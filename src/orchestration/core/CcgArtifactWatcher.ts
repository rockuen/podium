import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import type {
  CcgArtifact,
  CcgPair,
  CcgProvider,
  CcgSnapshot,
} from '../types/ccg';

const ASK_DIR = '.omc/artifacts/ask';
const PAIR_WINDOW_MS = 5 * 60 * 1000;
const RECONCILE_MS = 8000;

/**
 * Hybrid watcher for CCG artifacts: FileSystemWatcher for responsiveness +
 * periodic reconcile to catch partial writes and missed rename events.
 * Follows the same pattern as SessionHistoryWatcher / MissionWatcher.
 */
export class CcgArtifactWatcher extends EventEmitter {
  private root: string | null = null;
  private fsWatcher: vscode.FileSystemWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private cache = new Map<string, { mtimeMs: number; size: number; artifact: CcgArtifact }>();
  private lastSnapshot: CcgSnapshot | null = null;

  constructor(private readonly logger: (msg: string) => void) {
    super();
  }

  get currentRoot(): string | null {
    return this.root;
  }

  start(projectRoot: string): void {
    this.stop();
    this.root = projectRoot;

    const pattern = new vscode.RelativePattern(projectRoot, `${ASK_DIR}/*.md`);
    this.fsWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    const debounced = () => this.scheduleScan(250);
    this.fsWatcher.onDidCreate(debounced);
    this.fsWatcher.onDidChange(debounced);
    this.fsWatcher.onDidDelete(debounced);

    this.pollTimer = setInterval(() => this.scan(), RECONCILE_MS);
    this.scan();
    this.logger(`[podium.ccg] watching ${path.join(projectRoot, ASK_DIR)}`);
  }

  stop(): void {
    this.fsWatcher?.dispose();
    this.fsWatcher = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.root = null;
    this.cache.clear();
    this.lastSnapshot = null;
  }

  snapshot(): CcgSnapshot | null {
    return this.lastSnapshot;
  }

  forceRefresh(): void {
    this.scan();
  }

  private scheduleScan(delayMs: number): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.scan();
    }, delayMs);
  }

  private scan(): void {
    if (!this.root) return;
    const askDir = path.join(this.root, ASK_DIR);
    let entries: string[];
    try {
      entries = fs.readdirSync(askDir);
    } catch {
      this.emitSnapshot({ pairs: [], scannedAt: Date.now(), root: this.root });
      return;
    }

    const artifacts: CcgArtifact[] = [];
    const seenPaths = new Set<string>();

    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const provider = detectProvider(name);
      if (!provider) continue;

      const full = path.join(askDir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      seenPaths.add(full);

      const cached = this.cache.get(full);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        artifacts.push(cached.artifact);
        continue;
      }

      let raw: string;
      try {
        raw = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      // Skip partial writes (header without Raw output section).
      if (raw.length < 40 || (!raw.includes('## Original task') && !raw.includes('## Raw output'))) {
        continue;
      }

      const parsed = parseArtifactMarkdown(full, provider, raw, stat.mtimeMs);
      if (!parsed) continue;
      this.cache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, artifact: parsed });
      artifacts.push(parsed);
    }

    for (const key of Array.from(this.cache.keys())) {
      if (!seenPaths.has(key)) this.cache.delete(key);
    }

    const pairs = buildPairs(artifacts);
    this.emitSnapshot({ pairs, scannedAt: Date.now(), root: this.root });
  }

  private emitSnapshot(next: CcgSnapshot): void {
    if (this.lastSnapshot && sameSnapshot(this.lastSnapshot, next)) return;
    this.lastSnapshot = next;
    this.emit('snapshot', next);
  }
}

function detectProvider(fileName: string): CcgProvider | null {
  if (fileName.startsWith('codex-')) return 'codex';
  if (fileName.startsWith('gemini-')) return 'gemini';
  if (fileName.startsWith('claude-')) return 'claude';
  return null;
}

/**
 * Extract slug + timestamp from filename like
 * `codex-i-m-working-on-podium-...-2026-04-17T13-14-53-009Z.md`.
 */
function parseFileName(fileName: string, provider: CcgProvider): {
  slug: string;
  timestampMs: number | null;
} {
  const withoutExt = fileName.replace(/\.md$/, '');
  const body = withoutExt.slice(provider.length + 1);
  const tsMatch = body.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/);
  if (!tsMatch) {
    return { slug: body, timestampMs: null };
  }
  const tsToken = tsMatch[1];
  const slug = body.slice(0, body.length - tsToken.length - 1);
  const iso = tsToken.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z');
  const parsed = Date.parse(iso);
  return { slug, timestampMs: Number.isNaN(parsed) ? null : parsed };
}

export function parseArtifactMarkdown(
  filePath: string,
  provider: CcgProvider,
  raw: string,
  mtimeMs: number,
): CcgArtifact | null {
  const fileName = path.basename(filePath);
  const { slug, timestampMs } = parseFileName(fileName, provider);

  const createdAtField = extractField(raw, 'Created at');
  const createdFromField = createdAtField ? Date.parse(createdAtField) : NaN;
  const createdAt = Number.isFinite(createdFromField)
    ? (createdFromField as number)
    : timestampMs ?? mtimeMs;

  const exitCodeField = extractField(raw, 'Exit code');
  const exitCode = exitCodeField !== null && /^-?\d+$/.test(exitCodeField.trim())
    ? Number(exitCodeField.trim())
    : null;

  const originalTask = extractSection(raw, 'Original task') ?? '';
  const finalPrompt = extractSection(raw, 'Final prompt') ?? '';
  const rawOutput = extractRawOutput(raw) ?? '';

  const keySource = originalTask || finalPrompt || slug;
  const questionKey = normalizeKey(keySource);

  return {
    filePath,
    fileName,
    provider,
    createdAt,
    mtimeMs,
    exitCode,
    originalTask: originalTask.trim(),
    finalPrompt: finalPrompt.trim(),
    rawOutput: rawOutput.trim(),
    questionKey,
    slug,
  };
}

/**
 * Pair artifacts by temporal proximity within PAIR_WINDOW_MS. CCG emits codex
 * + gemini almost simultaneously so time beats questionKey (different prompts
 * per advisor) as the primary signal. Unpaired artifacts appear as single-
 * provider entries.
 */
export function buildPairs(artifacts: CcgArtifact[]): CcgPair[] {
  const remaining = [...artifacts].sort((a, b) => a.createdAt - b.createdAt);
  const pairs: CcgPair[] = [];
  const used = new Set<string>();

  for (const artifact of remaining) {
    if (used.has(artifact.filePath)) continue;
    used.add(artifact.filePath);

    const partners: Record<'codex' | 'gemini' | 'claude', CcgArtifact | null> = {
      codex: null,
      gemini: null,
      claude: null,
    };
    partners[artifact.provider] = artifact;

    for (const other of remaining) {
      if (used.has(other.filePath)) continue;
      if (other.provider === artifact.provider) continue;
      if (Math.abs(other.createdAt - artifact.createdAt) > PAIR_WINDOW_MS) continue;
      if (partners[other.provider]) continue;
      partners[other.provider] = other;
      used.add(other.filePath);
    }

    const artifactsInPair = [partners.codex, partners.gemini, partners.claude].filter(
      (a): a is CcgArtifact => a !== null,
    );
    const earliest = artifactsInPair.reduce(
      (min, a) => (a.createdAt < min ? a.createdAt : min),
      artifact.createdAt,
    );
    const anchor = partners.codex ?? partners.gemini ?? partners.claude ?? artifact;
    const title = summarizeTitle(anchor.originalTask || anchor.finalPrompt || anchor.slug);

    pairs.push({
      id: `${earliest}:${anchor.questionKey.slice(0, 24)}`,
      questionKey: anchor.questionKey,
      createdAt: earliest,
      codex: partners.codex,
      gemini: partners.gemini,
      claude: partners.claude,
      title,
    });
  }

  return pairs.sort((a, b) => b.createdAt - a.createdAt);
}

function extractField(raw: string, label: string): string | null {
  const re = new RegExp(`^-\\s+${label}:\\s*(.+)$`, 'm');
  const m = raw.match(re);
  return m ? m[1].trim() : null;
}

function extractSection(raw: string, heading: string): string | null {
  const re = new RegExp(`## ${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
  const m = raw.match(re);
  return m ? m[1].trim() : null;
}

function extractRawOutput(raw: string): string | null {
  const section = extractSection(raw, 'Raw output');
  if (!section) return null;
  const fence = section.match(/```(?:[a-zA-Z0-9]+)?\n([\s\S]*?)\n```/);
  if (fence) return fence[1];
  return section;
}

function normalizeKey(source: string): string {
  return source
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .trim()
    .slice(0, 160);
}

function summarizeTitle(source: string): string {
  const clean = source.replace(/\s+/g, ' ').trim();
  if (!clean) return 'CCG session';
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sameSnapshot(a: CcgSnapshot, b: CcgSnapshot): boolean {
  if (a.pairs.length !== b.pairs.length) return false;
  for (let i = 0; i < a.pairs.length; i++) {
    const pa = a.pairs[i];
    const pb = b.pairs[i];
    if (pa.id !== pb.id) return false;
    if (pa.createdAt !== pb.createdAt) return false;
    if (signature(pa.codex) !== signature(pb.codex)) return false;
    if (signature(pa.gemini) !== signature(pb.gemini)) return false;
    if (signature(pa.claude) !== signature(pb.claude)) return false;
  }
  return true;
}

function signature(a: CcgArtifact | null): string {
  if (!a) return 'x';
  return `${a.filePath}:${a.mtimeMs}`;
}
