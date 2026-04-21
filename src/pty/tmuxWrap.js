// @module pty/tmuxWrap — Podium-ready tmux wrapping for Claude CLI spawn.
//
// When a session entry has `podiumReady: true`, the launcher wraps Claude in a
// tmux (darwin/linux) / psmux (win32) session so `omc team` can later use it as
// a leader pane. This module centralises:
//   - mux binary resolution (psmux on win32, tmux elsewhere, graceful fallback)
//   - leader tmux.conf writing (minimal chrome: status off, set-titles off)
//   - spawn argv construction for node-pty (tmux new-session -A -s <name> …)
//
// All paths are absolute; no shelling out. The node-pty spawn still uses
// { name: 'xterm-256color', cwd, env } — same environment as the direct spawn
// path, so behavior inside Claude is unchanged.

const path = require('path');
const os = require('os');
const fs = require('fs');

const LEADER_CONF_DIR = path.join(os.homedir(), '.claude-launcher');
const LEADER_CONF_FILE = path.join(LEADER_CONF_DIR, 'tmux-leader.conf');

// Minimal chrome: status bar off, no window rename, no title escape — keeps
// the webview terminal looking like a normal Claude CLI. Mouse reporting is
// OFF so xterm.js can deliver its own drag text selection.
const LEADER_CONF_BODY = [
  '# Podium launcher: leader-pane tmux conf (managed, do not edit by hand)',
  'set -g status off',
  '# v2.6.25: mouse OFF — restores xterm native drag text selection.',
  '# Background: v2.6.19 tried "mouse ON + unbind MouseDrag1Pane" to keep',
  '# native text selection alive while preserving wheel-scroll passthrough.',
  '# That assumption was wrong: xterm.js disables its native selection the',
  '# moment terminal-side mouse tracking is active, regardless of whether',
  '# tmux later drops the event. The drag bytes just went to /dev/null on',
  '# the tmux side; xterm was still in passthrough mode so the highlight',
  '# never drew. Reverting to mouse off restores xterm native drag select.',
  '# Wheel scroll now stays inside xterm (its own scrollback buffer) — same',
  '# visible behavior for normal-screen output. For tmux copy-mode history',
  '# (e.g. in alt-screen TUIs), use prefix+[ (keyboard).',
  'set -g mouse off',
  'set -g set-titles off',
  'set -g allow-rename off',
  'set -g history-limit 50000',
  'set -g remain-on-exit off',
  '# v2.6.14: key-handling fixes for Claude Ink TUI inside tmux.',
  '# Without these, Enter was being queued as a literal newline (paste-bracket',
  '# mode) so users had to press Enter twice to submit.',
  'set -g default-terminal "xterm-256color"',
  'setw -g xterm-keys on',
  'set -s escape-time 0',
  'set -g assume-paste-time 0',
  '',
].join('\n');

function resolveMuxBinary() {
  if (process.platform === 'win32') {
    // Prefer psmux (Windows-native tmux fork). If not found, try tmux so the
    // user at least gets an error they can debug rather than a cryptic spawn
    // failure. Caller logs the outcome.
    return { bin: 'psmux', fallback: 'tmux' };
  }
  return { bin: 'tmux', fallback: null };
}

function ensureLeaderConf() {
  try {
    if (!fs.existsSync(LEADER_CONF_DIR)) {
      fs.mkdirSync(LEADER_CONF_DIR, { recursive: true });
    }
    const existing = fs.existsSync(LEADER_CONF_FILE)
      ? fs.readFileSync(LEADER_CONF_FILE, 'utf8')
      : null;
    if (existing !== LEADER_CONF_BODY) {
      fs.writeFileSync(LEADER_CONF_FILE, LEADER_CONF_BODY, 'utf8');
    }
    return LEADER_CONF_FILE;
  } catch (e) {
    console.warn('[Podium] leader tmux.conf write failed:', e && e.message);
    return null;
  }
}

// Build a tmux session name scoped to the launcher session. 8-char slice keeps
// it readable in `tmux ls` while preserving uniqueness per-sessionId.
function buildTmuxSessionName(sessionId) {
  const slice = (sessionId || '').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'anon';
  return `podium-leader-${slice}`;
}

// Build node-pty spawn args that wrap `claudeShell + claudeArgs` inside a tmux
// session. Returns { shell, args } — drop-in replacement for the direct
// (shell, args) pair otherwise fed to pty.spawn.
//
// -A makes `new-session` attach-if-exists, so resume/restart reuses the same
// tmux session instead of stacking new ones.
function buildTmuxSpawnArgs({ sessionId, cols, rows, claudeShell, claudeArgs }) {
  const { bin, fallback } = resolveMuxBinary();
  const confPath = ensureLeaderConf();
  const tmuxName = buildTmuxSessionName(sessionId);

  const muxBin = findMuxBinary(bin, fallback);
  if (!muxBin) {
    return null;
  }

  const args = [];
  if (confPath) args.push('-f', confPath);
  args.push('new-session', '-A', '-s', tmuxName);
  if (Number.isFinite(cols) && cols > 0) args.push('-x', String(cols));
  if (Number.isFinite(rows) && rows > 0) args.push('-y', String(rows));
  // Claude command + its args follow `--` so tmux doesn't mis-parse flags.
  args.push('--', claudeShell, ...claudeArgs);

  return { shell: muxBin, args, tmuxName, muxBin };
}

// Test PATH for a binary without spawning. Windows adds .exe/.cmd candidates
// so users can install psmux via installer or npm wrapper.
function findMuxBinary(primary, fallback) {
  const candidates = [primary];
  if (fallback) candidates.push(fallback);
  const pathDirs = (process.env.PATH || '')
    .split(process.platform === 'win32' ? ';' : ':')
    .filter(Boolean);
  const extList = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const cand of candidates) {
    // Absolute path supplied by user
    if (path.isAbsolute(cand) && fs.existsSync(cand)) return cand;
    for (const dir of pathDirs) {
      for (const ext of extList) {
        const full = path.join(dir, cand + ext);
        if (fs.existsSync(full)) return full; // return absolute path — node-pty on Windows doesn't resolve PATH for bare names
      }
    }
  }
  return null;
}

module.exports = {
  buildTmuxSessionName,
  buildTmuxSpawnArgs,
  ensureLeaderConf,
  resolveMuxBinary,
  findMuxBinary,
  LEADER_CONF_FILE,
};
