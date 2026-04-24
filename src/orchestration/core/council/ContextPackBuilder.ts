// v0.9.7 — ContextPackBuilder MVP.
//
// Turns raw "what was the user looking at when they opened the council"
// inputs into a `ContextPack` that is safe to serialize, share with another
// model, and persist on disk. Three responsibilities:
//
//   1. **Shape**: assemble `ContextPack` from heterogeneous inputs (user
//      question, optional file refs, optional file content, optional git
//      diff, optional test output, optional constraints).
//   2. **Caps**: apply per-section byte caps so a noisy diff or a 5MB log
//      file does not blow up downstream model context. Truncated sections
//      are tagged so callers know they were cut, and the original byte
//      length is recorded in the manifest.
//   3. **Redaction**: strip obvious credentials (sk-*, GitHub PAT, AWS
//      access key, Bearer tokens, `*_TOKEN/KEY/SECRET/PASSWORD=value`) and
//      report the redaction count in the manifest. Conservative regex
//      matching only — this is not a substitute for real secret scanning,
//      but it stops the most common accidental leaks.
//
// Design rules followed here:
//   - VS Code runtime is not required. Only `fs`, `path`, `crypto`, `Buffer`.
//   - The builder is pure-ish: filesystem reads only happen when an input
//     file ref omits `content` AND `loadFileContents: true` is set.
//   - Output is intentionally separate from `runFakeCouncil`: the builder
//     produces a `BuiltContextPack`, then `runFakeCouncil` (or any future
//     caller) writes it to disk. Renderer + manifest helpers are exported
//     so the writer never has to re-derive structure from `ContextPack`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ContextPack, ContextFileRef } from './types';

const DEFAULT_PER_FILE_CAP = 8 * 1024;
const DEFAULT_DIFF_CAP = 16 * 1024;
const DEFAULT_TEST_OUTPUT_CAP = 8 * 1024;
const DEFAULT_CONVERSATION_SUMMARY_CAP = 4 * 1024;

const TRUNCATION_MARKER = '\n\n[...truncated by Podium ContextPackBuilder...]\n';

export interface ContextFileInput {
  /** Workspace-relative path (POSIX separators preferred). */
  path: string;
  /**
   * Optional explicit content. If provided, the builder uses it directly
   * (still subject to caps + redaction). If absent and `loadFileContents`
   * is true on the parent input, the builder reads the file from
   * `<cwd>/<path>`. If both are absent the file is recorded as a ref-only
   * entry with empty content.
   */
  content?: string;
  reason?: string;
}

export interface ContextPackCaps {
  perFile?: number;
  diff?: number;
  testOutput?: number;
  conversationSummary?: number;
}

export interface BuildContextPackInput {
  cwd: string;
  primarySessionId: string;
  userQuestion: string;
  currentGoal?: string;
  recentConversationSummary?: string;
  files?: ContextFileInput[];
  loadFileContents?: boolean;
  gitDiff?: string;
  testOutput?: string;
  constraints?: string[];
  /** Test seam: clock. */
  now?: () => Date;
  /** Test seam: id generator. */
  newId?: () => string;
  caps?: ContextPackCaps;
}

export interface InclusionRecord {
  includedBytes: number;
  originalBytes: number;
  truncated: boolean;
  redactionCount: number;
}

export interface FileInclusionRecord extends InclusionRecord {
  path: string;
  /** True if `loadFileContents` was set but the file could not be read. */
  missing: boolean;
}

export interface BuiltContextPack {
  pack: ContextPack;
  inclusions: {
    files: FileInclusionRecord[];
    gitDiff?: InclusionRecord;
    testOutput?: InclusionRecord;
    recentConversationSummary?: InclusionRecord;
  };
  totals: {
    redactionCount: number;
    truncatedSections: number;
  };
  /**
   * Per-file body after caps + redaction, keyed by the input `path`. Lets
   * `renderContextPackMarkdown` embed file bodies without having to
   * re-process them.
   */
  fileContents: Record<string, string>;
}

export function buildContextPack(input: BuildContextPackInput): BuiltContextPack {
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? (() => randomUUID());
  const caps = {
    perFile: input.caps?.perFile ?? DEFAULT_PER_FILE_CAP,
    diff: input.caps?.diff ?? DEFAULT_DIFF_CAP,
    testOutput: input.caps?.testOutput ?? DEFAULT_TEST_OUTPUT_CAP,
    conversationSummary: input.caps?.conversationSummary ?? DEFAULT_CONVERSATION_SUMMARY_CAP,
  };

  // --- Files ------------------------------------------------------------
  const fileContents: Record<string, string> = {};
  const fileInclusions: FileInclusionRecord[] = [];
  const fileRefs: ContextFileRef[] = [];

  for (const f of input.files ?? []) {
    let raw: string | undefined = f.content;
    let missing = false;
    if (raw === undefined && input.loadFileContents) {
      try {
        raw = fs.readFileSync(path.join(input.cwd, f.path), 'utf8');
      } catch {
        missing = true;
        raw = '';
      }
    }
    if (raw === undefined) raw = '';

    const originalBytes = Buffer.byteLength(raw, 'utf8');
    const { value: capped, truncated } = truncateBytes(raw, caps.perFile);
    const { value: redacted, count: redactionCount } = redactSecrets(capped);
    const includedBytes = Buffer.byteLength(redacted, 'utf8');

    fileContents[f.path] = redacted;
    fileInclusions.push({
      path: f.path,
      includedBytes,
      originalBytes,
      truncated,
      missing,
      redactionCount,
    });
    fileRefs.push({
      path: f.path,
      bytes: originalBytes,
      reason: f.reason,
    });
  }

  // --- Git diff ---------------------------------------------------------
  let gitDiff: string | undefined;
  let gitDiffInclusion: InclusionRecord | undefined;
  if (input.gitDiff !== undefined) {
    const originalBytes = Buffer.byteLength(input.gitDiff, 'utf8');
    const { value: capped, truncated } = truncateBytes(input.gitDiff, caps.diff);
    const { value: redacted, count } = redactSecrets(capped);
    gitDiff = redacted;
    gitDiffInclusion = {
      includedBytes: Buffer.byteLength(redacted, 'utf8'),
      originalBytes,
      truncated,
      redactionCount: count,
    };
  }

  // --- Test output ------------------------------------------------------
  let testOutput: string | undefined;
  let testOutputInclusion: InclusionRecord | undefined;
  if (input.testOutput !== undefined) {
    const originalBytes = Buffer.byteLength(input.testOutput, 'utf8');
    const { value: capped, truncated } = truncateBytes(input.testOutput, caps.testOutput);
    const { value: redacted, count } = redactSecrets(capped);
    testOutput = redacted;
    testOutputInclusion = {
      includedBytes: Buffer.byteLength(redacted, 'utf8'),
      originalBytes,
      truncated,
      redactionCount: count,
    };
  }

  // --- Recent conversation summary -------------------------------------
  let recentConversationSummary = '';
  let conversationInclusion: InclusionRecord | undefined;
  if (input.recentConversationSummary !== undefined && input.recentConversationSummary.length > 0) {
    const originalBytes = Buffer.byteLength(input.recentConversationSummary, 'utf8');
    const { value: capped, truncated } = truncateBytes(
      input.recentConversationSummary,
      caps.conversationSummary,
    );
    const { value: redacted, count } = redactSecrets(capped);
    recentConversationSummary = redacted;
    conversationInclusion = {
      includedBytes: Buffer.byteLength(redacted, 'utf8'),
      originalBytes,
      truncated,
      redactionCount: count,
    };
  }

  const pack: ContextPack = {
    id: `cpack_${newId()}`,
    primarySessionId: input.primarySessionId,
    userQuestion: input.userQuestion,
    currentGoal: input.currentGoal ?? '',
    recentConversationSummary,
    relevantFiles: fileRefs,
    gitDiff,
    testOutput,
    constraints: input.constraints ?? [],
    createdAt: now().toISOString(),
  };

  const totalRedactions =
    fileInclusions.reduce((s, r) => s + r.redactionCount, 0) +
    (gitDiffInclusion?.redactionCount ?? 0) +
    (testOutputInclusion?.redactionCount ?? 0) +
    (conversationInclusion?.redactionCount ?? 0);

  const truncatedSections =
    fileInclusions.filter((r) => r.truncated).length +
    (gitDiffInclusion?.truncated ? 1 : 0) +
    (testOutputInclusion?.truncated ? 1 : 0) +
    (conversationInclusion?.truncated ? 1 : 0);

  return {
    pack,
    inclusions: {
      files: fileInclusions,
      gitDiff: gitDiffInclusion,
      testOutput: testOutputInclusion,
      recentConversationSummary: conversationInclusion,
    },
    totals: { redactionCount: totalRedactions, truncatedSections },
    fileContents,
  };
}

export function renderContextPackMarkdown(built: BuiltContextPack): string {
  const pack = built.pack;
  const fileSection = pack.relevantFiles.length
    ? pack.relevantFiles
        .map((f) => {
          const inc = built.inclusions.files.find((i) => i.path === f.path);
          const meta: string[] = [];
          if (inc) {
            meta.push(`included ${inc.includedBytes} of ${inc.originalBytes} bytes`);
            if (inc.truncated) meta.push('truncated');
            if (inc.missing) meta.push('missing on disk');
            if (inc.redactionCount > 0) meta.push(`${inc.redactionCount} redactions`);
          } else if (f.bytes != null) {
            meta.push(`${f.bytes} bytes`);
          }
          if (f.reason) meta.push(f.reason);
          const head = `### ${f.path}` + (meta.length ? `\n\n_${meta.join(' · ')}_` : '');
          const body = built.fileContents[f.path];
          if (body === undefined || body.length === 0) return head;
          return `${head}\n\n\`\`\`\n${body}\n\`\`\``;
        })
        .join('\n\n')
    : '_(none)_';

  const constraints = pack.constraints.length
    ? pack.constraints.map((c) => `- ${c}`).join('\n')
    : '_(none)_';

  return [
    `# Context Pack ${pack.id}`,
    ``,
    `- **Primary session**: ${pack.primarySessionId}`,
    `- **Created at**: ${pack.createdAt}`,
    `- **Total redactions**: ${built.totals.redactionCount}`,
    `- **Truncated sections**: ${built.totals.truncatedSections}`,
    ``,
    `## User question`,
    pack.userQuestion || '_(empty)_',
    ``,
    `## Current goal`,
    pack.currentGoal || '_(empty)_',
    ``,
    `## Recent conversation summary`,
    pack.recentConversationSummary || '_(empty)_',
    ``,
    `## Relevant files`,
    fileSection,
    ``,
    `## Constraints`,
    constraints,
    ``,
    `## Git diff`,
    pack.gitDiff ? '```diff\n' + pack.gitDiff + '\n```' : '_(none)_',
    ``,
    `## Test output`,
    pack.testOutput ? '```\n' + pack.testOutput + '\n```' : '_(none)_',
    ``,
  ].join('\n');
}

export function buildContextManifest(built: BuiltContextPack): Record<string, unknown> {
  const pack = built.pack;
  return {
    contextPackId: pack.id,
    primarySessionId: pack.primarySessionId,
    createdAt: pack.createdAt,
    relevantFiles: pack.relevantFiles,
    constraints: pack.constraints,
    includes: {
      gitDiff: pack.gitDiff !== undefined,
      testOutput: pack.testOutput !== undefined,
      recentConversationSummary: pack.recentConversationSummary.length > 0,
    },
    inclusions: built.inclusions,
    totals: built.totals,
  };
}

// --- helpers ---------------------------------------------------------

export function truncateBytes(
  value: string,
  capBytes: number,
): { value: string; truncated: boolean } {
  if (capBytes <= 0) return { value, truncated: false };
  if (Buffer.byteLength(value, 'utf8') <= capBytes) return { value, truncated: false };
  return { value: sliceByteSafe(value, capBytes) + TRUNCATION_MARKER, truncated: true };
}

function sliceByteSafe(value: string, capBytes: number): string {
  // Walk codepoints and accumulate UTF-8 byte length until adding the next
  // codepoint would exceed the cap. Avoids cutting a multi-byte sequence
  // mid-way (which `Buffer.slice + toString` can do).
  let acc = 0;
  let out = '';
  for (const ch of value) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (acc + b > capBytes) break;
    out += ch;
    acc += b;
  }
  return out;
}

interface SecretPattern {
  name: string;
  re: RegExp;
}

// Order matters: more-specific KV pattern runs first so a `KEY="sk-..."`
// is recorded as a single redaction rather than KV + sk- both firing.
const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: 'kv-secret',
    re: /\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|API_?KEY))\s*[:=]\s*['"]?([A-Za-z0-9_\-+/=.]{12,})['"]?/g,
  },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghr|ghs)_[A-Za-z0-9]{20,}\b/g },
  { name: 'sk-token', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'bearer', re: /\b[Bb]earer\s+[A-Za-z0-9._\-+/=]{20,}\b/g },
];

export function redactSecrets(value: string): { value: string; count: number } {
  let out = value;
  let count = 0;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, (match: string, ...groups: unknown[]) => {
      count++;
      // KV pattern provides the secret value as the second capture group;
      // preserve the key portion for readability.
      const valueGroup = groups[1];
      if (typeof valueGroup === 'string' && valueGroup.length > 0) {
        const idx = match.lastIndexOf(valueGroup);
        if (idx >= 0) {
          return match.slice(0, idx) + '[REDACTED]' + match.slice(idx + valueGroup.length);
        }
      }
      return '[REDACTED]';
    });
  }
  return { value: out, count };
}
