// ARCHIVED — 2026-04-21 (Phase 0 v2.6.44).
//
// This file was part of an attempt (v2.6.42/43) to spawn an `omc team`
// coordinator pane inside the leader psmux session. The approach failed due
// to Windows Git Bash + psmux default-shell interactions that couldn't be
// reliably worked around. The project has since pivoted to a node-pty-based
// orchestrator (see 260421 Podium 세션 확장-축소 모델.md v2) that eliminates
// psmux entirely.
//
// Retained here temporarily as architectural reference. No call sites
// import it anymore. Safe to delete in Phase 6 when the psmux layer is
// removed wholesale.

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { IMultiplexerBackend } from '../backends/IMultiplexerBackend';
import type { TeamSpec } from './OMCRuntime';
import { normalizeSlots } from './OMCRuntime';

// v2.6.42 — "A mode, done right".
//
// Prior attempts (v2.6.41 dispatchViaTmuxSession) sent `omc team …` as
// keystrokes to the leader's pane. That pane runs the Claude CLI, not a
// shell, so the command was parsed as user chat input — Claude just
// replied "네." and nothing launched.
//
// This helper instead creates a NEW pane inside the leader psmux session
// that runs bash. The bash pane executes `omc team …`, OMC's runtime
// detects `$TMUX` from its parent session, and then OMC itself calls
// `psmux split-window` to add per-agent worker panes. Net result:
//   - leader Claude pane untouched (original conversation preserved)
//   - coordinator pane handles OMC orchestration
//   - worker panes appear in the same session → visible from Teams tree
//   - workers actually converse through OMC's team pipeline
//
// The coordinator pane closes when `omc team` returns; worker panes
// persist independently.

export interface OmcCoordinatorOptions {
  readonly backend: IMultiplexerBackend;
  readonly leaderSession: string;
  readonly spec: TeamSpec;
  readonly cwd: string;
  readonly output: vscode.OutputChannel;
  readonly slugSeed: string;     // deterministic team-name seed (dispatchShell parity)
}

export async function dispatchOmcTeamInLeaderSession(
  opts: OmcCoordinatorOptions,
): Promise<string> {
  const { backend, leaderSession, spec, cwd, output, slugSeed } = opts;
  const seededPrompt = `${slugSeed}. ${spec.prompt}`;

  const tmpPath = path.join(
    os.tmpdir(),
    `podium-prompt-coord-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  try {
    fs.writeFileSync(tmpPath, seededPrompt, 'utf8');
  } catch (err) {
    throw new Error(
      `OMC coordinator: failed to write prompt temp file: ${err instanceof Error ? err.message : err}`,
    );
  }
  const bashPath = tmpPath.replace(/\\/g, '/');
  const slotStr = normalizeSlots(spec.slots)
    .map((s) => `${s.count}:${s.model}`)
    .join(',');

  // The whole thing is ONE shell-command string — tmux/psmux runs it via
  // `$SHELL -c "<string>"` (default-shell is MSYS2 bash after
  // PsmuxSetup.ensurePsmuxTmuxConf). `$(cat '…')` evaluates safely in bash
  // regardless of newlines / quotes in the user prompt.
  const shellCmd = `omc team ${slotStr} "$(cat '${bashPath}')"`;

  // UTF-8 env so codex / gemini workers emit Korean correctly when the
  // coordinator in turn spawns them via OMC.
  const envPairs: Array<[string, string]> = [
    ['LANG', 'C.UTF-8'],
    ['LC_ALL', 'C.UTF-8'],
    ['PYTHONIOENCODING', 'utf-8'],
  ];

  output.appendLine(
    `[omc-coord] leader=${leaderSession} slotStr=${slotStr} shellCmd="${shellCmd.slice(0, 120)}${shellCmd.length > 120 ? '…' : ''}"`,
  );

  // v2.6.43's setServerOption('default-shell', bashPath) call removed in
  // v2.6.44 (Phase 0 cleanup). It was corrupting the running psmux server
  // on Windows Git Bash when the resolved path contained spaces. The whole
  // coordinator approach is being replaced by a node-pty orchestrator in
  // v2.7.

  const paneId = await backend.splitWorker(leaderSession, envPairs, shellCmd, [], cwd);
  output.appendLine(`[omc-coord] coordinator pane ${paneId} launched in ${leaderSession}`);
  return paneId;
}
