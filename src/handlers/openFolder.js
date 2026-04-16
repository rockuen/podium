// @module handlers/openFolder — opens containing folder in OS file explorer.
// Reuses resolvePathFragment from openFile.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { t } = require('../i18n');
const { resolvePathFragment } = require('./openFile');

function handleOpenFolder(filePath, entry) {
  let raw = (filePath || '').trim();
  if (!raw) {
    vscode.window.showWarningMessage(t('invalidFolderPath') + filePath);
    return;
  }

  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = path.join(os.homedir(), raw.slice(1));
  }

  let resolved = resolvePathFragment(raw, entry.cwd);

  // v2.6.2: mirror openFile.js basename-search fallback so partial paths
  // like "slack-manifests/01-demand-forecast.yaml" resolve to the containing
  // folder even when cwd isn't a direct ancestor. Walks up to depth 6,
  // matches by basename, then prefers a full-suffix match.
  if (!resolved) {
    const suffix = raw.replace(/\\/g, '/');
    const basename = path.basename(raw);
    const found = [];
    function searchDir(dir, depth) {
      if (depth > 6 || found.length >= 5) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = path.join(dir, e.name);
          if ((e.isFile() || e.isDirectory()) && e.name === basename) found.push(full);
          else if (e.isDirectory()) searchDir(full, depth + 1);
        }
      } catch (_) {}
    }
    if (entry.cwd) searchDir(entry.cwd, 0);
    const match = found.find(f => f.replace(/\\/g, '/').endsWith(suffix)) || found[0];
    if (match) resolved = match;
  }

  if (!resolved) {
    vscode.window.showWarningMessage(t('invalidFolderPath') + filePath);
    return;
  }

  let folderPath;
  try {
    const stat = fs.statSync(resolved);
    folderPath = stat.isDirectory() ? resolved : path.dirname(resolved);
  } catch (_) {
    vscode.window.showWarningMessage(t('invalidFolderPath') + filePath);
    return;
  }

  if (!fs.existsSync(folderPath)) {
    vscode.window.showWarningMessage(t('invalidFolderPath') + filePath);
    return;
  }

  const { spawn } = require('child_process');
  if (process.platform === 'darwin') {
    spawn('open', [folderPath], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    spawn('explorer', [folderPath.replace(/\//g, '\\')], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [folderPath], { detached: true, stdio: 'ignore' }).unref();
  }
}

module.exports = { handleOpenFolder };
