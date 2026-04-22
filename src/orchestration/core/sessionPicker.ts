// Phase 3.4 · v2.7.12 — Claude session discovery + QuickPick picker.
//
// Powers the `podium.orchestrate.resume` command: scans the user's Claude
// Code session store for the current workspace, presents a picker, and
// returns the chosen session UUID so the caller can spawn a leader with
// `claude --resume <uuid>`.
//
// Session layout
// --------------
// Claude Code writes each conversation to:
//
//     ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
//
// `<encoded-cwd>` is the current working directory with every non-
// alphanumeric character replaced by `-`. So `c:\obsidian\Won's 2nd Brain`
// → `c--obsidian-Won-s-2nd-Brain` (drive colon + backslash fold to `--`,
// apostrophes and spaces become `-`).
//
// Each JSONL file is a stream of message + metadata records. We only read
// the head of each file to extract a preview; we never load the full
// transcript into memory.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

// NOTE: `vscode` is imported lazily inside `pickClaudeSession` so the pure
// helpers below (hashCwdForClaudeProjects / claudeProjectsDirForCwd /
// listClaudeSessions) can be exercised by Node unit tests that run outside
// the extension host.

export interface ClaudeSessionInfo {
  sessionId: string;
  filePath: string;
  mtime: Date;
  firstUserMessage?: string;
  messageCount: number;
  gitBranch?: string;
}

/** Replicate Claude Code's directory-name encoding for a cwd. */
export function hashCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function claudeProjectsDirForCwd(cwd: string, home = os.homedir()): string {
  return path.join(home, '.claude', 'projects', hashCwdForClaudeProjects(cwd));
}

/**
 * v2.7.26 · Probe whether a Claude session UUID has an actual on-disk JSONL
 * file under `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
 *
 * Why this exists
 * ---------------
 * Snapshot save (v2.7.19+) records pre-allocated session UUIDs for every
 * pane. But Claude CLI only writes the JSONL file AFTER the first user
 * message is submitted. Workers spawned but never used have a UUID the
 * orchestrator knows about yet no file exists — passing `--resume <uuid>`
 * to such a session fails with "No conversation found with session ID…"
 * and the pane exits code=1. Callers use this probe to branch:
 *   resumable  → `--resume <sid>` (preserve conversation)
 *   not yet   → `--session-id <sid>` fresh spawn (preserve UUID so the
 *               snapshot ledger stays consistent on re-save)
 */
export function isClaudeSessionResumable(
  cwd: string,
  sessionId: string,
  home = os.homedir(),
): boolean {
  if (!sessionId) return false;
  const filePath = path.join(claudeProjectsDirForCwd(cwd, home), `${sessionId}.jsonl`);
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/** Scan all session JSONLs for `cwd`, newest first. Empty array if dir absent. */
export async function listClaudeSessions(
  cwd: string,
  opts: { home?: string; previewCap?: number } = {},
): Promise<ClaudeSessionInfo[]> {
  const dir = claudeProjectsDirForCwd(cwd, opts.home ?? os.homedir());
  if (!fs.existsSync(dir)) return [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const jsonlFiles = entries.filter(
    (e) => e.isFile() && e.name.endsWith('.jsonl'),
  );
  const results: ClaudeSessionInfo[] = [];
  for (const entry of jsonlFiles) {
    const sessionId = entry.name.replace(/\.jsonl$/, '');
    const filePath = path.join(dir, entry.name);
    try {
      const stat = await fs.promises.stat(filePath);
      const preview = await readSessionPreview(filePath, opts.previewCap ?? 50);
      results.push({
        sessionId,
        filePath,
        mtime: stat.mtime,
        ...preview,
      });
    } catch {
      // Skip unreadable files silently — picker should still work.
    }
  }
  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results;
}

interface SessionPreview {
  firstUserMessage?: string;
  messageCount: number;
  gitBranch?: string;
}

async function readSessionPreview(filePath: string, cap: number): Promise<SessionPreview> {
  let firstUserMessage: string | undefined;
  let messageCount = 0;
  let gitBranch: string | undefined;
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let parsed: {
        type?: string;
        message?: { role?: string; content?: unknown };
        gitBranch?: string;
      };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.type === 'user' || parsed.type === 'assistant') {
        messageCount += 1;
      }
      if (!firstUserMessage && parsed.type === 'user') {
        const content = parsed.message?.content;
        if (typeof content === 'string') {
          firstUserMessage = content;
        } else if (Array.isArray(content)) {
          // v2.1+ structured content: find the first `text` block.
          const textBlock = (content as Array<{ type?: string; text?: string }>).find(
            (b) => b && b.type === 'text' && typeof b.text === 'string',
          );
          if (textBlock?.text) firstUserMessage = textBlock.text;
        }
      }
      if (!gitBranch && typeof parsed.gitBranch === 'string' && parsed.gitBranch) {
        gitBranch = parsed.gitBranch;
      }
      if (messageCount >= cap && firstUserMessage) break;
    }
  } finally {
    rl.close();
    input.close();
  }
  return { firstUserMessage, messageCount, gitBranch };
}

/**
 * Show a QuickPick for available sessions under `cwd`. Returns the selected
 * session UUID, or `undefined` if the user cancelled or none were found.
 */
export async function pickClaudeSession(cwd: string): Promise<string | undefined> {
  // Lazy require so unit tests of the pure helpers don't need the vscode
  // module surface. The extension host always has it.
  const vscode = require('vscode') as typeof import('vscode');
  const sessions = await listClaudeSessions(cwd);
  if (sessions.length === 0) {
    await vscode.window.showInformationMessage(
      `Podium: no Claude sessions found under ~/.claude/projects/ for this workspace.`,
    );
    return undefined;
  }
  const items = sessions.map((s) => ({
    label: truncateOneLine(s.firstUserMessage ?? '(no user message)', 70),
    description: `${s.messageCount} msgs · ${timeAgo(s.mtime)}${s.gitBranch ? ` · ${s.gitBranch}` : ''}`,
    detail: s.sessionId,
    sessionId: s.sessionId,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Resume Claude session as Podium leader',
    placeHolder: 'Pick a recent session — leader will resume it with Podium routing enforced.',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.sessionId;
}

function truncateOneLine(s: string, max: number): string {
  const firstLine = s.split(/\r?\n/)[0] ?? '';
  if (firstLine.length <= max) return firstLine;
  return firstLine.slice(0, max - 1) + '…';
}

function timeAgo(d: Date): string {
  const diff = Date.now() - d.getTime();
  const sec = Math.max(0, Math.floor(diff / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
