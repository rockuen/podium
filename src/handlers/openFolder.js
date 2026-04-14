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

  const resolved = resolvePathFragment(raw, entry.cwd);
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
