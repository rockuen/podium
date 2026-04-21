// Phase 4.A · v2.7.19 — Team Snapshot/Restore.
//
// Persists the current Podium team (leader + workers + their session IDs +
// cwd + metadata) as JSON so the user can reopen the same team later with
// `--resume <uuid>` per pane. The actual Claude Code conversation transcripts
// live in `~/.claude/projects/<cwd>/<sessionId>.jsonl` and are untouched;
// this file only tracks WHICH sessions belong together as a team.
//
// Storage location
// ----------------
// OneDrive-synced path so Windows + Mac devices share the same team library:
//
//   %OneDrive%/wons-2nd-brain-data/podium/claudeTeams.json
//
// Fallback when OneDrive isn't configured: `~/.podium/claudeTeams.json`.
//
// Retention
// ---------
// Newest-first list, capped at `MAX_SNAPSHOTS` entries. Oldest entries get
// pruned on every save so the file stays small even with constant auto-save.
// Users can still pin important snapshots by re-saving them (bumps timestamp).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentKind } from './agentSpawn';

// NOTE: vscode is lazy-required inside `pickSnapshot` so the pure helpers
// below are testable outside the extension host.

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_SNAPSHOTS = 10;

export interface SnapshotPane {
  paneId: string;
  agent: AgentKind;
  /** Session UUID for --resume. For Claude this is a real UUID; future
   *  agents (Codex, Gemini) may use their own identifier shape. */
  sessionId: string;
  label?: string;
}

export interface TeamSnapshot {
  id: string;
  name: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** Source whose kind triggered the save — helps debug auto-save behavior. */
  source: 'manual' | 'dissolve' | 'pane-exit';
  cwd: string;
  leader: SnapshotPane;
  workers: SnapshotPane[];
}

export interface SnapshotFile {
  version: number;
  teams: TeamSnapshot[];
}

/**
 * Resolve the on-disk location for the team snapshot ledger.
 *
 * - Prefers `%OneDrive%/wons-2nd-brain-data/podium/claudeTeams.json` on
 *   machines where OneDrive is set up (so multi-device sync works).
 * - Falls back to `~/.podium/claudeTeams.json` elsewhere.
 *
 * `override` lets tests inject a temp path.
 */
export function resolveSnapshotPath(override?: {
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string {
  const env = override?.env ?? process.env;
  const home = override?.home ?? os.homedir();
  if (env.OneDrive) {
    return path.join(env.OneDrive, 'wons-2nd-brain-data', 'podium', 'claudeTeams.json');
  }
  return path.join(home, '.podium', 'claudeTeams.json');
}

export async function loadSnapshots(filePath: string): Promise<SnapshotFile> {
  if (!fs.existsSync(filePath)) {
    return { version: SNAPSHOT_SCHEMA_VERSION, teams: [] };
  }
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SnapshotFile>;
    if (!parsed || !Array.isArray(parsed.teams)) {
      return { version: SNAPSHOT_SCHEMA_VERSION, teams: [] };
    }
    const teams = parsed.teams.filter((t): t is TeamSnapshot =>
      !!t && typeof t.id === 'string' && typeof t.createdAt === 'string' && !!t.leader,
    );
    return { version: parsed.version ?? SNAPSHOT_SCHEMA_VERSION, teams };
  } catch {
    // Corrupted file — start over rather than crash the command.
    return { version: SNAPSHOT_SCHEMA_VERSION, teams: [] };
  }
}

/**
 * Save a snapshot and prune to `maxKeep` entries. Atomic write via
 * `file.tmp → rename` so readers never see a half-written JSON.
 */
export async function saveSnapshot(
  filePath: string,
  snapshot: TeamSnapshot,
  maxKeep = MAX_SNAPSHOTS,
): Promise<SnapshotFile> {
  const file = await loadSnapshots(filePath);
  file.teams = [snapshot, ...file.teams.filter((t) => t.id !== snapshot.id)];
  if (file.teams.length > maxKeep) file.teams = file.teams.slice(0, maxKeep);
  file.version = SNAPSHOT_SCHEMA_VERSION;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
  await fs.promises.rename(tmp, filePath);
  return file;
}

export function makeSnapshotId(now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `snap-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export function summarizeSnapshotForPicker(s: TeamSnapshot): {
  label: string;
  description: string;
  detail: string;
} {
  const ts = new Date(s.createdAt);
  const when = `${ts.toLocaleDateString()} ${ts.toLocaleTimeString()}`;
  const agents = [s.leader, ...s.workers].map((p) => p.agent);
  const agentCounts = agents.reduce<Record<string, number>>((acc, a) => {
    acc[a] = (acc[a] ?? 0) + 1;
    return acc;
  }, {});
  const agentSummary = Object.entries(agentCounts)
    .map(([k, v]) => `${v}×${k}`)
    .join(', ');
  return {
    label: s.name,
    description: `${s.workers.length} worker${s.workers.length === 1 ? '' : 's'} · ${when} · ${s.source}`,
    detail: `[${s.id}] ${agentSummary} · cwd=${s.cwd}`,
  };
}

/** Show a QuickPick of saved snapshots; returns the chosen one or undefined. */
export async function pickSnapshot(filePath: string): Promise<TeamSnapshot | undefined> {
  const vscode = require('vscode') as typeof import('vscode');
  const file = await loadSnapshots(filePath);
  if (file.teams.length === 0) {
    await vscode.window.showInformationMessage(
      `Podium: no saved team snapshots. File: ${filePath}`,
    );
    return undefined;
  }
  const items = file.teams.map((s) => ({
    ...summarizeSnapshotForPicker(s),
    snapshot: s,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Open saved Podium team',
    placeHolder: 'Pick a team — each pane will resume its session.',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.snapshot;
}

/** Prompt the user for a snapshot name; returns the chosen name or undefined. */
export async function promptSnapshotName(defaultName: string): Promise<string | undefined> {
  const vscode = require('vscode') as typeof import('vscode');
  const value = await vscode.window.showInputBox({
    title: 'Save Podium team snapshot',
    prompt: 'Team name — something you can recognize later.',
    value: defaultName,
    validateInput: (v: string) => (v.trim().length === 0 ? 'Name is required' : undefined),
  });
  return value?.trim() || undefined;
}
