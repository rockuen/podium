// @module handlers/pasteLargeText — large clipboard text → temp file + @path.
// Works around PTY write truncation (Ink/ConPTY line-editor drops bytes on
// sustained large writes) by sidestepping bulk writes entirely: we save the
// paste to a temp file and hand Claude CLI a `@<path>` reference it can read.
//
// Files live under <os.tmpdir()>/claude-launcher-paste/. Files older than
// 7 days are swept on each paste (cheap; O(N) readdir over a small folder).

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const TEMP_SUBDIR = 'claude-launcher-paste';
const CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getPasteDir() {
  const dir = path.join(os.tmpdir(), TEMP_SUBDIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupOld(dir) {
  try {
    const cutoff = Date.now() - CLEANUP_AGE_MS;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const stat = fs.statSync(p);
        if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(p);
      } catch (_) {}
    }
  } catch (_) {}
}

function makeFileName() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${String(d.getFullYear()).slice(2)}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = crypto.randomBytes(3).toString('hex');
  return `paste-${ts}-${rand}.txt`;
}

// Normalize to forward slashes so Claude CLI `@path` parser works on Windows
// (backslashes can be mis-parsed as escapes in some shells/TUI line editors).
function toCliPath(absPath) {
  return absPath.replace(/\\/g, '/');
}

function handlePasteLargeText(msg, entry, panel) {
  try {
    const text = msg.text || '';
    if (!text) return;
    const dir = getPasteDir();
    cleanupOld(dir);
    const fileName = makeFileName();
    const fullPath = path.join(dir, fileName);
    fs.writeFileSync(fullPath, text, 'utf8');
    const cliPath = toCliPath(fullPath);
    panel.webview.postMessage({
      type: 'paste-file-ready',
      cliPath,
      fullPath,
      fileName,
      size: Buffer.byteLength(text, 'utf8')
    });
  } catch (e) {
    vscode.window.showErrorMessage('Paste-to-file failed: ' + e.message);
    panel.webview.postMessage({ type: 'paste-file-ready', error: true });
  }
}

module.exports = { handlePasteLargeText };
