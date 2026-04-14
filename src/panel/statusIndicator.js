// @module panel/statusIndicator — tab icon + status bar updates.

const vscode = require('vscode');
const path = require('path');
const state = require('../state');
const { t } = require('../i18n');

function setTabIcon(panel, status, extensionPath) {
  if (!panel) return;
  const iconFile = {
    idle: 'claude-idle.svg',
    running: 'claude-running.svg',
    done: 'claude-done.svg',
    error: 'claude-error.svg'
  }[status] || 'claude-idle.svg';

  try {
    const iconUri = vscode.Uri.file(path.join(extensionPath, 'icons', iconFile));
    panel.iconPath = { light: iconUri, dark: iconUri };
  } catch (_) {}
}

function updateStatusBar() {
  let hasRunning = false;
  let hasNeedsAttention = false;
  let hasWaiting = false;

  for (const [, entry] of state.panels) {
    if (entry.state === 'running') hasRunning = true;
    if (entry.state === 'needs-attention') hasNeedsAttention = true;
    if (entry.state === 'waiting') hasWaiting = true;
  }

  if (hasRunning) setStatusBar('running');
  else if (hasNeedsAttention) setStatusBar('needs-attention');
  else if (hasWaiting) setStatusBar('waiting');
  else if (state.panels.size > 0) setStatusBar('done');
  else setStatusBar('idle');
}

// Param renamed from `state` → `nextState` to avoid shadowing the imported state module.
function setStatusBar(nextState) {
  if (!state.statusBar) return;
  const config = {
    idle:              { text: '$(hubot) Claude Code', bg: undefined },
    waiting:           { text: t('sbIdle'),      bg: undefined },
    running:           { text: t('sbRunning'),   bg: 'statusBarItem.warningBackground' },
    'needs-attention': { text: t('sbAttention'), bg: 'statusBarItem.prominentBackground' },
    done:              { text: t('sbDone'),      bg: undefined },
    error:             { text: t('sbError'),     bg: 'statusBarItem.errorBackground' }
  }[nextState];
  if (!config) return;

  state.statusBar.text = config.text;
  state.statusBar.backgroundColor = config.bg ? new vscode.ThemeColor(config.bg) : undefined;
}

module.exports = { setTabIcon, setStatusBar, updateStatusBar };
