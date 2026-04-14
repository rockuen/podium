// @module pty/resolveCli — locates the Claude CLI binary across install methods.
// Priority: ~/.local/bin (official standalone) → npm global → PATH fallback.

const path = require('path');
const os = require('os');
const fs = require('fs');

function resolveClaudeCli() {
  const isWin = process.platform === 'win32';

  // 1) ~/.local/bin/claude(.exe) — official standalone install
  const localBin = isWin
    ? path.join(os.homedir(), '.local', 'bin', 'claude.exe')
    : path.join(os.homedir(), '.local', 'bin', 'claude');
  if (fs.existsSync(localBin)) return { shell: localBin, args: [] };

  // 2) npm global install — Windows needs cmd.exe /c wrapper for .cmd shims
  if (isWin) {
    const npmCli = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
    if (fs.existsSync(npmCli)) return { shell: 'cmd.exe', args: ['/c', 'claude'] };
  }

  // 3) Fallback — hope it's on PATH (works on macOS/Linux where shell scripts are directly executable)
  try {
    require('child_process').execFileSync('claude', ['--version'], { timeout: 1500, stdio: 'ignore' });
    return { shell: 'claude', args: [] };
  } catch (_) {
    return null;
  }
}

module.exports = { resolveClaudeCli };
