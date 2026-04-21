import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import type { IMultiplexerBackend } from '../backends/IMultiplexerBackend';
import type { TeamSpec, AgentModel } from './OMCRuntime';

// Win32-input-mode KEY_EVENT sequence pair for Shift+Enter (verified v2.6.24).
// Claude CLI enters Win32 input mode on startup; joining multi-line prompts
// with this sequence preserves newlines within the editor while a trailing
// bare Enter submits. codex/gemini don't use Win32 mode — we keep the prompt
// single-line for them in this initial cut.
const SHIFT_ENTER_KEY_EVENT =
  '\x1b[13;28;10;1;16;1_' + '\x1b[13;28;10;0;16;1_';

const PROMPT_INJECTION_DELAY_MS = 2000;

export interface SpawnedWorker {
  paneId: string;
  agent: AgentModel;
  workerId: string;      // e.g., 'claude-1', 'codex-2'
  sessionId?: string;    // filled for claude (we generate it); codex/gemini
                         // need mtime-scan capture in v2.6.42
}

export interface InlineTeamSpawnResult {
  teamId: string;
  leaderSession: string;
  workers: SpawnedWorker[];
}

export interface InlineTeamSpawnOptions {
  backend: IMultiplexerBackend;
  leaderSession: string;          // e.g., 'podium-leader-cf12080d'
  spec: TeamSpec;                 // slots + prompt
  cwd: string;                    // workspace root for `psmux -c`
  output: vscode.OutputChannel;
  // Optional overrides for CLI binaries if user has custom paths; falls back
  // to bare name (expects PATH resolution in psmux-spawned shell).
  claudeBin?: string;
  codexBin?: string;
  geminiBin?: string;
}

/**
 * P0.6 core spawner — turns a single-pane `podium-leader-*` session into an
 * N+1 pane team by split-window-ing each worker with OMC env vars, tiling
 * the layout, then delivering the prompt via send-keys. Caller is
 * responsible for surfacing the result to the user (e.g. opening the multi-
 * pane grid view). On failure, already-spawned panes are killed to avoid
 * dangling workers — see `rollback` in the catch block.
 */
export async function spawnInlineTeam(
  opts: InlineTeamSpawnOptions,
): Promise<InlineTeamSpawnResult> {
  const { backend, leaderSession, spec, cwd, output } = opts;
  const teamId = randomUUID().slice(0, 8);
  const prompt = spec.prompt.trim();

  // Normalize: {model:'claude', count:2} → ['claude', 'claude']
  const flatSlots: AgentModel[] = [];
  for (const slot of spec.slots) {
    for (let i = 0; i < slot.count; i++) flatSlots.push(slot.model);
  }
  if (flatSlots.length === 0) {
    throw new Error('spawnInlineTeam: TeamSpec has no workers');
  }
  output.appendLine(
    `[inline-team] teamId=${teamId} leader=${leaderSession} workers=${flatSlots.join(',')} prompt="${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}"`,
  );

  // Count-by-agent so workerId seq is stable per agent type (claude-1,
  // claude-2, codex-1, …).
  const seqByAgent = new Map<AgentModel, number>();
  const nextSeq = (agent: AgentModel): number => {
    const n = (seqByAgent.get(agent) ?? 0) + 1;
    seqByAgent.set(agent, n);
    return n;
  };

  const spawned: SpawnedWorker[] = [];
  try {
    for (const agent of flatSlots) {
      const seq = nextSeq(agent);
      const workerId = `${agent}-${seq}`;
      const claudeSessionId = agent === 'claude' ? randomUUID() : undefined;
      const { command, args } = buildWorkerCli(agent, opts, claudeSessionId);
      const envPairs: Array<[string, string]> = [
        ['OMC_OPENCLAW', '1'],
        ['OMC_TEAM_ID', teamId],
        ['OMC_WORKER_ID', workerId],
        // v2.6.40: UTF-8 hinting so codex / gemini don't emit cp949 garbage
        // when the user's prompt or model reply contains Korean. Node-based
        // CLIs respect LANG/LC_ALL via their underlying libs; Python-based
        // bits also pick up PYTHONIOENCODING.
        ['LANG', 'C.UTF-8'],
        ['LC_ALL', 'C.UTF-8'],
        ['PYTHONIOENCODING', 'utf-8'],
      ];
      output.appendLine(`[inline-team] spawn ${workerId} → ${command} ${args.join(' ')}`);
      const paneId = await backend.splitWorker(leaderSession, envPairs, command, args, cwd);
      spawned.push({ paneId, agent, workerId, sessionId: claudeSessionId });
      output.appendLine(`[inline-team] ${workerId} → pane ${paneId}`);
    }

    // Re-tile after all splits so panes are evenly distributed.
    await backend.applyLayout(leaderSession, 'tiled');
    output.appendLine(`[inline-team] applied tiled layout to ${leaderSession}`);

    // Deliver prompt to each worker once CLIs have had time to initialize.
    // Single batch wait covers all workers since they started back-to-back.
    await sleep(PROMPT_INJECTION_DELAY_MS);
    for (const w of spawned) {
      try {
        await injectPrompt(backend, w, prompt, output);
      } catch (err) {
        output.appendLine(
          `[inline-team] prompt injection failed for ${w.workerId} (${w.paneId}): ${describeErr(err)}`,
        );
        // Don't rollback — worker pane stays alive, user can retype manually.
      }
    }

    return { teamId, leaderSession, workers: spawned };
  } catch (err) {
    output.appendLine(`[inline-team] spawn failed: ${describeErr(err)} — rolling back ${spawned.length} pane(s)`);
    for (const w of spawned) {
      try {
        await backend.killPane(w.paneId);
      } catch {
        /* best-effort rollback */
      }
    }
    throw err;
  }
}

function buildWorkerCli(
  agent: AgentModel,
  opts: InlineTeamSpawnOptions,
  claudeSessionId: string | undefined,
): { command: string; args: string[] } {
  const userArgs: string[] =
    agent === 'claude' && claudeSessionId ? ['--session-id', claudeSessionId] : [];
  const rawName =
    (agent === 'claude' && opts.claudeBin) ||
    (agent === 'codex' && opts.codexBin) ||
    (agent === 'gemini' && opts.geminiBin) ||
    agent;
  return resolveAgentCli(rawName, userArgs);
}

// Windows-aware CLI resolver. psmux passes `split-window -- cmd args` to a
// direct exec (no shell), so `.cmd` / `.bat` / `.ps1` wrappers can't be run
// unless we route them through `cmd.exe /c`. On Unix we trust the parent's
// PATH and just return the bare name.
//
// Discovery order on Windows:
//   1. `where <name>` — mirrors shell PATH, honors .cmd/.bat/.exe lookup
//   2. Fall back to the bare name (will likely fail; surfaces as an empty
//      pane so the user knows to install/fix PATH)
function resolveAgentCli(name: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command: name, args };
  }
  const resolved = whereOnWindows(name);
  if (!resolved) {
    return { command: name, args };
  }
  if (/\.(cmd|bat|ps1)$/i.test(resolved)) {
    // Route .cmd through cmd.exe so the script interpreter kicks in and env
    // (including UTF-8 hints) propagates to the child process naturally.
    return { command: 'cmd.exe', args: ['/c', resolved, ...args] };
  }
  return { command: resolved, args };
}

function whereOnWindows(name: string): string | null {
  try {
    const out = execFileSync('where', [name], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8');
    const first = out.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

async function injectPrompt(
  backend: IMultiplexerBackend,
  worker: SpawnedWorker,
  prompt: string,
  output: vscode.OutputChannel,
): Promise<void> {
  if (!prompt) return;
  let payload = prompt;
  if (worker.agent === 'claude') {
    // Multi-line via Win32 KEY_EVENT so the CLI's readline keeps newlines
    // without submitting on the first LF.
    payload = prompt.split(/\r?\n/).join(SHIFT_ENTER_KEY_EVENT);
  } else {
    // codex/gemini: strip newlines for now — multi-line per-agent strategy
    // belongs in a future pass (§future). Preserves single-line prompts
    // unchanged.
    if (prompt.includes('\n')) {
      output.appendLine(
        `[inline-team] ${worker.workerId}: stripping newlines (multi-line not yet supported for ${worker.agent})`,
      );
      payload = prompt.replace(/\r?\n/g, ' ');
    }
  }
  await backend.sendKeys(worker.paneId, [payload], true);
  await backend.sendKeys(worker.paneId, ['Enter'], false);
  output.appendLine(`[inline-team] ${worker.workerId}: prompt injected (${payload.length} chars)`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeErr(err: unknown): string {
  if (!err) return '(unknown)';
  if (err instanceof Error) return err.message;
  return String(err);
}
