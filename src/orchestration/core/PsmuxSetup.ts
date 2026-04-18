import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';

const PODIUM_MARKER = '# Podium: psmux panes must use bash for OMC worker init (Unix-style env KEY=val ... pattern).';
const UTF8_MARKER = '# Podium: force UTF-8 locale in every pane so Codex/Gemini Korean output is not downgraded to cp949.';
const OPTION_PATTERN = /^\s*set(?:-option)?\s+-g\s+default-shell\b/m;
const UTF8_LANG_PATTERN = /^\s*set-environment\s+-g\s+LANG\b/m;
const UTF8_LCALL_PATTERN = /^\s*set-environment\s+-g\s+LC_ALL\b/m;
const UTF8_LCCTYPE_PATTERN = /^\s*set-environment\s+-g\s+LC_CTYPE\b/m;

export interface PsmuxConfigResult {
  /** Config file was written or modified this call. */
  wrote: boolean;
  /** Config already had a compatible default-shell (no change needed). */
  alreadyOk: boolean;
  /** Config has a different default-shell that we did not touch. */
  conflict: string | null;
  /** Path to the config file we manage. */
  configPath: string;
}

/**
 * Ensure `~/.tmux.conf` sets psmux's default-shell to the provided bash path.
 * Non-destructive: if the user already has a `default-shell` line, we leave
 * it alone (no overwrite, no silent mutation) and report the conflict.
 */
export function ensurePsmuxTmuxConf(bashPath: string): PsmuxConfigResult {
  const home = process.env.HOME || os.homedir();
  const configPath = path.join(home, '.tmux.conf');
  const normalized = bashPath.replace(/\\/g, '/');
  const desiredLine = `set-option -g default-shell "${normalized}"`;

  const utf8Block = buildUtf8Block();

  if (!fs.existsSync(configPath)) {
    const content = `${PODIUM_MARKER}\n${desiredLine}\n\n${utf8Block}\n`;
    fs.writeFileSync(configPath, content, 'utf8');
    return { wrote: true, alreadyOk: false, conflict: null, configPath };
  }

  const existing = fs.readFileSync(configPath, 'utf8');
  const match = existing.match(OPTION_PATTERN);
  let updated = existing;
  let wroteAny = false;
  let conflict: string | null = null;
  let shellAlreadyOk = false;

  if (match) {
    const lineStart = existing.lastIndexOf('\n', match.index ?? 0) + 1;
    const lineEnd = existing.indexOf('\n', lineStart);
    const line = existing.slice(lineStart, lineEnd === -1 ? existing.length : lineEnd);
    const quoted = line.match(/["']([^"']+)["']/);
    const current = quoted ? quoted[1] : line.replace(OPTION_PATTERN, '').trim();
    if (current && current.replace(/\\/g, '/') === normalized) {
      shellAlreadyOk = true;
    } else {
      conflict = current || line;
    }
  } else {
    // Missing default-shell block entirely — append.
    const needsLeadingNewline = updated.length > 0 && !updated.endsWith('\n');
    updated = `${updated}${needsLeadingNewline ? '\n' : ''}\n${PODIUM_MARKER}\n${desiredLine}\n`;
    wroteAny = true;
  }

  // Independently ensure UTF-8 locale lines (orthogonal to default-shell).
  const hasLang = UTF8_LANG_PATTERN.test(updated);
  const hasLcAll = UTF8_LCALL_PATTERN.test(updated);
  const hasLcCtype = UTF8_LCCTYPE_PATTERN.test(updated);
  if (!hasLang || !hasLcAll || !hasLcCtype) {
    const needsLeadingNewline = updated.length > 0 && !updated.endsWith('\n');
    updated = `${updated}${needsLeadingNewline ? '\n' : ''}\n${utf8Block}\n`;
    wroteAny = true;
  }

  if (wroteAny) {
    fs.writeFileSync(configPath, updated, 'utf8');
    return { wrote: true, alreadyOk: false, conflict, configPath };
  }
  if (shellAlreadyOk && hasLang && hasLcAll && hasLcCtype) {
    return { wrote: false, alreadyOk: true, conflict: null, configPath };
  }
  return { wrote: false, alreadyOk: false, conflict, configPath };
}

function buildUtf8Block(): string {
  return [
    UTF8_MARKER,
    'set-environment -g LANG "C.UTF-8"',
    'set-environment -g LC_ALL "C.UTF-8"',
    'set-environment -g LC_CTYPE "C.UTF-8"',
  ].join('\n');
}

/**
 * Check if a psmux server is running. Used to decide whether to warn the
 * user that config changes need a kill-server to take effect.
 */
export function isPsmuxServerRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('psmux list-sessions', { timeout: 4000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '');
        // "no server running" stderr = server is NOT up. Anything else means running.
        resolve(!/no server running|failed to connect|address in use/i.test(msg));
      } else {
        resolve(true);
      }
    });
  });
}

/**
 * Kill the psmux server. Caller must confirm it is safe (e.g. no active
 * sessions beyond ones being spawned).
 */
export function killPsmuxServer(): Promise<{ ok: boolean; errMessage?: string }> {
  return new Promise((resolve) => {
    exec('psmux kill-server', { timeout: 5000, windowsHide: true }, (err) => {
      if (err) {
        // no-server errors are fine; treat as already-clean.
        if (/no server running|failed to connect/i.test(err.message)) {
          resolve({ ok: true });
          return;
        }
        resolve({ ok: false, errMessage: err.message });
        return;
      }
      resolve({ ok: true });
    });
  });
}
