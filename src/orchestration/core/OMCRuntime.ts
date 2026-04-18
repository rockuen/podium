import * as pty from 'node-pty';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { exec, execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import type { IPty } from 'node-pty';

export interface OmcShutdownResult {
  ok: boolean;
  stderr?: string;
  stdout?: string;
  errMessage?: string;
  exitCode?: number | null;
}

export interface OmcShellHost {
  shellPath: string | null;
  shellArgs: string[];
  env: Record<string, string>;
  description: string;
}

const BASH_CANDIDATES_WIN = [
  (pf: string) => path.join(pf, 'Git', 'bin', 'bash.exe'),
  (pf: string) => path.join(pf, 'Git', 'usr', 'bin', 'bash.exe'),
  () => 'C:\\msys64\\usr\\bin\\bash.exe',
  () => 'C:\\msys64\\mingw64\\bin\\bash.exe',
];

/**
 * Resolve an MSYS2 / Git-Bash shell host for running `omc team ...` on
 * Windows. OMC detects `MSYSTEM` / `MINGW_PREFIX` in env and switches from
 * the broken cmd.exe-wrapped worker start command to the Unix-style branch.
 *
 * Returns `{ shellPath: null }` if no bash is found — caller should fall back
 * to the VSCode default shell and surface a warning.
 */
export function resolveOmcTeamShellHost(bashOverride?: string): OmcShellHost {
  if (process.platform !== 'win32') {
    return {
      shellPath: null,
      shellArgs: [],
      env: { OMC_OPENCLAW: '1' },
      description: 'default-shell (non-windows)',
    };
  }
  const env: Record<string, string> = {
    OMC_OPENCLAW: '1',
    MSYSTEM: 'MINGW64',
    MINGW_PREFIX: '/mingw64',
    MSYSTEM_PREFIX: '/mingw64',
    CHERE_INVOKING: '1',
    // Force UTF-8 everywhere so Codex/Gemini/Claude workers don't downgrade
    // Korean (or any non-ASCII) to cp949 "?" question marks when writing
    // stdout / mailbox JSON. Matters on Windows + Git Bash specifically.
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    LC_CTYPE: 'C.UTF-8',
    PYTHONIOENCODING: 'utf-8',
  };
  const override = (bashOverride || '').trim();
  if (override) {
    if (fs.existsSync(override)) {
      return {
        shellPath: override,
        shellArgs: ['-i'],
        env,
        description: `override:${override}`,
      };
    }
    // Signal invalid override explicitly so the caller (SpawnTeamPanel) can
    // surface a warning. Fall through to auto-detect rather than throwing so
    // the spawn still succeeds with the detected bash.
    return {
      shellPath: null,
      shellArgs: [],
      env,
      description: `override-missing:${override}`,
    };
  }
  const candidates: string[] = [];
  const shellEnv = process.env.SHELL;
  if (shellEnv && /bash/i.test(shellEnv) && fs.existsSync(shellEnv)) {
    candidates.push(shellEnv);
  }
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  for (const fn of BASH_CANDIDATES_WIN) {
    candidates.push(fn(pf));
    if (fn.length) candidates.push(fn(pfx86));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return {
        shellPath: c,
        shellArgs: ['-i'],
        env,
        description: `msys2-bash:${c}`,
      };
    }
  }
  return {
    shellPath: null,
    shellArgs: [],
    env: { OMC_OPENCLAW: '1' },
    description: 'default-shell (no bash detected)',
  };
}

export type AgentModel = 'claude' | 'codex' | 'gemini';

export interface TeamSlot {
  model: AgentModel;
  count: number;
}

export interface TeamSpec {
  slots: TeamSlot[];
  prompt: string;
}

export function normalizeSlots(slots: TeamSlot[]): TeamSlot[] {
  const merged = new Map<AgentModel, number>();
  for (const s of slots) {
    const count = Math.max(1, Math.floor(s.count));
    merged.set(s.model, (merged.get(s.model) ?? 0) + count);
  }
  return Array.from(merged.entries()).map(([model, count]) => ({ model, count }));
}

export function summarizeSlots(slots: TeamSlot[]): string {
  return normalizeSlots(slots)
    .map((s) => `${s.model}×${s.count}`)
    .join(' + ');
}

function slotSignature(spec: TeamSpec): string {
  const slots = normalizeSlots(spec.slots);
  if (slots.length === 0) {
    throw new Error('TeamSpec requires at least one slot');
  }
  return slots.map((s) => `${s.count}:${s.model}`).join(',');
}

function escapePrompt(prompt: string): string {
  // bash / sh treat backtick + $ as expansion triggers inside double quotes,
  // and ! can trigger history expansion. Escape them all so a prompt with
  // backticked file paths or "$foo" placeholders is passed literally.
  return prompt
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/!/g, '\\!');
}

function flattenPromptForShell(prompt: string): string {
  // Collapse any newline (CRLF or LF) into a single space, then collapse
  // runs of spaces. Trims leading/trailing whitespace. Preserves all other
  // content (including Korean, em-dashes, punctuation).
  return prompt
    .replace(/\r?\n+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export interface SpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
}

interface ResolvedCli {
  shell: string;
  args: string[];
  description: string;
}

export class OMCRuntime {
  private claudeCommandOverride: string | undefined;

  constructor(claudeCommandOverride?: string) {
    this.claudeCommandOverride = claudeCommandOverride || undefined;
  }

  setClaudeCommand(cmd: string | undefined): void {
    this.claudeCommandOverride = cmd || undefined;
  }

  resolveClaudeCli(): ResolvedCli {
    const override = this.claudeCommandOverride;
    if (override) {
      if (fs.existsSync(override)) {
        return { shell: override, args: [], description: `override:${override}` };
      }
      // If override looks like a path (contains slash/backslash or drive),
      // treat a missing file as a configuration error — previously this
      // silently passed to pty.spawn which then ENOENT'd with a confusing
      // "override-command:..." description that looked like a runtime bug.
      if (/[\\/]/.test(override) || /^[a-zA-Z]:/.test(override)) {
        throw new Error(
          `Podium: podium.claudeCommand points to "${override}" which does not exist. Fix the setting or clear it to auto-detect.`,
        );
      }
      // Otherwise treat as PATH-resolvable binary name.
      return { shell: override, args: [], description: `override-command:${override}` };
    }

    const isWin = process.platform === 'win32';
    const localBin = isWin
      ? path.join(os.homedir(), '.local', 'bin', 'claude.exe')
      : path.join(os.homedir(), '.local', 'bin', 'claude');
    if (fs.existsSync(localBin)) {
      return { shell: localBin, args: [], description: `local-bin:${localBin}` };
    }

    if (isWin) {
      const npmCli = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
      if (fs.existsSync(npmCli)) {
        return { shell: 'cmd.exe', args: ['/c', 'claude'], description: `npm-global:${npmCli}` };
      }
    }

    try {
      execFileSync('claude', ['--version'], { timeout: 1500, stdio: 'ignore' });
      return { shell: 'claude', args: [], description: 'path-fallback' };
    } catch {
      throw new Error(
        'Podium: claude CLI not found. Install Claude Code (https://claude.com/claude-code) or set "podium.claudeCommand" to the full binary path.',
      );
    }
  }

  spawnClaude(opts: SpawnOptions): IPty & { _description: string; _sessionId: string } {
    const resolved = this.resolveClaudeCli();
    const sessionId = randomUUID();
    const args = [...resolved.args, '--session-id', sessionId];
    const proc = pty.spawn(resolved.shell, args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: { ...process.env, FORCE_COLOR: '1', OMC_OPENCLAW: '1' },
    });
    (proc as unknown as { _description: string; _sessionId: string })._description =
      resolved.description;
    (proc as unknown as { _description: string; _sessionId: string })._sessionId = sessionId;
    return proc as IPty & { _description: string; _sessionId: string };
  }

  spawnShell(opts: SpawnOptions): IPty {
    const shell =
      process.platform === 'win32'
        ? process.env.COMSPEC || 'cmd.exe'
        : process.env.SHELL || '/bin/bash';
    return pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: { ...process.env },
    });
  }

  attachMultiplexerSession(
    binary: string,
    sessionName: string,
    opts: SpawnOptions,
  ): IPty {
    return pty.spawn(binary, ['attach-session', '-t', sessionName], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: { ...process.env },
    });
  }

  formatTeamCommand(spec: TeamSpec): string {
    return `/team ${slotSignature(spec)} "${escapePrompt(spec.prompt)}"`;
  }

  /**
   * Shell form — spawns tmux/psmux panes with real CLI workers. Podium
   * Sessions tree + multi-pane grid depend on this path.
   *
   * Flattens embedded newlines to a single space so the command reaches
   * `omc team` as a single token even when sent through VSCode's
   * terminal.sendText (which can split the input on \n and confuse bash's
   * unclosed-quote continuation, especially on Windows + Git Bash).
   */
  formatOmcTeamShellCommand(spec: TeamSpec): string {
    const flatPrompt = flattenPromptForShell(spec.prompt);
    return `omc team ${slotSignature(spec)} "${escapePrompt(flatPrompt)}"`;
  }

  /**
   * Best-effort OMC team shutdown. Called before psmux kill-session so that
   * OMC's one_team_per_leader_session guard is released. Non-fatal: if the
   * team is already gone or OMC is unavailable, the caller should still
   * attempt the backend-level kill.
   */
  shutdownOmcTeam(teamName: string, cwd: string): Promise<OmcShutdownResult> {
    return new Promise((resolve) => {
      const safe = String(teamName).trim();
      if (!safe) {
        resolve({ ok: false, stderr: 'empty team name' });
        return;
      }
      exec(
        `omc team shutdown ${safe} --force`,
        { cwd, timeout: 20_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const stdoutStr = String(stdout || '');
          const stderrStr = String(stderr || '');
          // OMC prints success even on "already gone" paths.
          const stdoutLooksOk =
            /Team shutdown complete/i.test(stdoutStr) ||
            /No team state found/i.test(stdoutStr);
          if (err) {
            const errCode = (err as NodeJS.ErrnoException).code;
            resolve({
              ok: stdoutLooksOk,
              stdout: stdoutStr,
              stderr: stderrStr,
              errMessage: err.message,
              exitCode: typeof errCode === 'number' ? errCode : null,
            });
          } else {
            resolve({ ok: true, stdout: stdoutStr, stderr: stderrStr });
          }
        },
      );
    });
  }
}
