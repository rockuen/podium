import * as pty from 'node-pty';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import type { IPty } from 'node-pty';

// Phase 1 · v2.7.0 — unified agent-CLI spawning for the new node-pty based
// orchestrator. Supersedes `OMCRuntime.spawnClaude` (claude-only) by adding
// codex and gemini. psmux is NOT involved; each worker is its own pty owned
// by this extension, so message routing goes through `onData` / `write()`
// directly rather than tmux send-keys / capture-pane.

export type AgentKind = 'claude' | 'codex' | 'gemini';

export interface ResolvedAgentCli {
  shell: string;           // direct exec target (.exe path) OR 'cmd.exe' for .cmd wrappers
  args: string[];           // args to pass to shell (includes /c <name> when shell=cmd.exe)
  description: string;      // human-readable origin (for OutputChannel logs)
}

export interface SpawnAgentOpts {
  agent: AgentKind;
  /** CLI-specific extra args the caller wants to pass (e.g. `--resume <id>`). */
  extraArgs?: readonly string[];
  cols: number;
  rows: number;
  cwd: string;
  /** Optional env overrides, merged on top of process.env + UTF-8 defaults. */
  env?: Record<string, string>;
  /** Override resolved CLI path for a specific agent. */
  claudeOverride?: string;
  codexOverride?: string;
  geminiOverride?: string;
  /** If true and agent=claude, pre-generate a session-id UUID and inject it. */
  autoSessionId?: boolean;
  /**
   * v2.7.19 · Explicit session ID override for Claude. When set, we pass
   * `--session-id <sessionId>` and skip the `autoSessionId` random UUID path.
   * Callers that need to snapshot + restore teams generate UUIDs up front,
   * then pass them here so the orchestrator can capture them for
   * `teamSnapshot.ts`. Ignored for codex/gemini.
   */
  sessionId?: string;
}

export interface SpawnedAgent {
  pty: IPty;
  /** Claude-only: the UUID we injected via `--session-id`. undefined for codex/gemini
   * since those CLIs don't accept session-id injection; caller is expected to
   * capture their session id by scanning the agent's state dir after spawn. */
  sessionId: string | undefined;
  resolved: ResolvedAgentCli;
}

const WINDOWS = process.platform === 'win32';

// Windows .cmd wrappers can't be exec'd directly via CreateProcess — must go
// through cmd.exe. The resolver normalizes every CLI to `shell` (exec target)
// + `args` (its argv) so pty.spawn is uniform across platforms.
export function resolveAgentCli(agent: AgentKind, override?: string): ResolvedAgentCli {
  if (override) {
    const trimmed = override.trim();
    if (!trimmed) {
      // treat empty string as "no override"
    } else if (fs.existsSync(trimmed)) {
      return wrapCmdIfNeeded(trimmed, [], `override:${trimmed}`);
    } else if (/[\\/]/.test(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
      throw new Error(
        `Podium: ${agent} CLI override "${trimmed}" does not exist. Fix the setting or clear it to auto-detect.`,
      );
    } else {
      // Bare name → trust PATH
      return { shell: trimmed, args: [], description: `override-command:${trimmed}` };
    }
  }

  // Agent-specific auto-detect.
  if (agent === 'claude') {
    const localBin = WINDOWS
      ? path.join(os.homedir(), '.local', 'bin', 'claude.exe')
      : path.join(os.homedir(), '.local', 'bin', 'claude');
    if (fs.existsSync(localBin)) {
      return { shell: localBin, args: [], description: `local-bin:${localBin}` };
    }
    if (WINDOWS) {
      const npmCli = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
      if (fs.existsSync(npmCli)) {
        return wrapCmdIfNeeded(npmCli, [], `npm-global:${npmCli}`);
      }
    }
  } else if (agent === 'codex') {
    if (WINDOWS) {
      const npmCli = path.join(process.env.APPDATA || '', 'npm', 'codex.cmd');
      if (fs.existsSync(npmCli)) {
        return wrapCmdIfNeeded(npmCli, [], `npm-global:${npmCli}`);
      }
    } else {
      const unixBin = path.join(os.homedir(), '.local', 'bin', 'codex');
      if (fs.existsSync(unixBin)) {
        return { shell: unixBin, args: [], description: `local-bin:${unixBin}` };
      }
    }
  } else if (agent === 'gemini') {
    if (WINDOWS) {
      const npmCli = path.join(process.env.APPDATA || '', 'npm', 'gemini.cmd');
      if (fs.existsSync(npmCli)) {
        return wrapCmdIfNeeded(npmCli, [], `npm-global:${npmCli}`);
      }
    } else {
      const unixBin = path.join(os.homedir(), '.local', 'bin', 'gemini');
      if (fs.existsSync(unixBin)) {
        return { shell: unixBin, args: [], description: `local-bin:${unixBin}` };
      }
    }
  }

  // Last resort — bare-name PATH resolution. execFileSync probes for
  // existence so pty.spawn doesn't ENOENT silently later.
  try {
    execFileSync(agent, ['--version'], { timeout: 1500, stdio: 'ignore' });
    return { shell: agent, args: [], description: 'path-fallback' };
  } catch {
    throw new Error(
      `Podium: ${agent} CLI not found. Install it, or set the "podium.${agent}Command" override to the full binary path.`,
    );
  }
}

function wrapCmdIfNeeded(fullPath: string, userArgs: string[], description: string): ResolvedAgentCli {
  if (!WINDOWS) {
    return { shell: fullPath, args: userArgs, description };
  }
  if (/\.(cmd|bat)$/i.test(fullPath)) {
    return {
      shell: 'cmd.exe',
      args: ['/c', fullPath, ...userArgs],
      description: `${description} (cmd.exe-wrapped)`,
    };
  }
  if (/\.ps1$/i.test(fullPath)) {
    return {
      shell: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-File', fullPath, ...userArgs],
      description: `${description} (powershell-wrapped)`,
    };
  }
  return { shell: fullPath, args: userArgs, description };
}

export function spawnAgent(opts: SpawnAgentOpts): SpawnedAgent {
  const override =
    (opts.agent === 'claude' && opts.claudeOverride) ||
    (opts.agent === 'codex' && opts.codexOverride) ||
    (opts.agent === 'gemini' && opts.geminiOverride) ||
    undefined;
  const resolved = resolveAgentCli(opts.agent, override || undefined);

  // Compose CLI argv: resolver-emitted args + claude --session-id (if requested)
  // + caller-supplied extra args. Order matters for CLIs that distinguish
  // flags vs positional.
  let claudeSessionId: string | undefined;
  const finalArgs = [...resolved.args];
  if (opts.agent === 'claude') {
    if (opts.sessionId) {
      claudeSessionId = opts.sessionId;
      finalArgs.push('--session-id', claudeSessionId);
    } else if (opts.autoSessionId) {
      claudeSessionId = randomUUID();
      finalArgs.push('--session-id', claudeSessionId);
    }
  }
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    finalArgs.push(...opts.extraArgs);
  }

  // UTF-8 env so Korean and other non-ASCII survive the Windows console.
  // Caller env takes precedence over these defaults.
  const env: Record<string, string> = {
    ...process.env,
    FORCE_COLOR: '1',
    OMC_OPENCLAW: '1',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    ...(opts.env || {}),
  } as Record<string, string>;

  const p = pty.spawn(resolved.shell, finalArgs, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env,
  });
  return { pty: p, sessionId: claudeSessionId, resolved };
}
