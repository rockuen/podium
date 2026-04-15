// @module panel/messageRouter — single dispatch for 19 webview→extension message types.
// ctx carries: { entry, panel, context, extensionPath, createPanel, onWebviewReady }.
// createPanel is injected (callback) to avoid circular import with createPanel.js.
//
// Message protocol (18 webview→ext):
//   webview-ready, input, resize, toolbar, paste-image, check-clipboard-image,
//   drop-files, open-link, rename-tab, save-setting, export-settings, import-settings,
//   close-resume, open-file, open-folder, export-conversation, restart-session,
//   request-edit-memo

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const state = require('../state');
const { t } = require('../i18n');
const { sessionStoreGet, sessionStoreUpdate } = require('../store/sessionStore');
const { saveSessions } = require('../store/sessionManager');
const { writePtyChunked } = require('../pty/write');
const { handleToolbar } = require('../handlers/toolbar');
const { handlePasteImage, readClipboardImageFromSystem } = require('../handlers/pasteImage');
const { handleDropFiles } = require('../handlers/dropFiles');
const { handleOpenFile } = require('../handlers/openFile');
const { handleOpenFolder } = require('../handlers/openFolder');
const { handleExportConversation } = require('../handlers/exportConversation');
const { handlePasteLargeText } = require('../handlers/pasteLargeText');
const { restartPty } = require('./restartPty');

function routeWebviewMessage(msg, ctx) {
  const { entry, panel, context, extensionPath, createPanel, onWebviewReady } = ctx;

  switch (msg.type) {
    case 'webview-ready':
      onWebviewReady();
      return;

    case 'input':
      if (entry.pty) writePtyChunked(entry, msg.data);
      return;

    case 'resize':
      entry._lastCols = msg.cols;
      entry._lastRows = msg.rows;
      if (entry.pty) try { entry.pty.resize(msg.cols, msg.rows); } catch (_) {}
      return;

    case 'toolbar':
      handleToolbar(msg.action, entry, context, extensionPath, createPanel);
      return;

    case 'paste-image':
      if (entry.pty) handlePasteImage(msg.data, entry, panel);
      return;

    case 'check-clipboard-image':
      if (entry.pty) readClipboardImageFromSystem(entry, panel);
      return;

    case 'drop-files':
      if (entry.pty) handleDropFiles(msg.paths, entry);
      return;

    case 'open-link':
      if (/^https?:\/\//i.test(msg.url)) {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
      }
      return;

    case 'rename-tab':
      vscode.window.showInputBox({ prompt: t('enterTabName'), value: entry.title }).then(newName => {
        if (newName) {
          entry.title = newName;
          panel.title = newName;
          panel.webview.postMessage({ type: 'title-updated', title: newName });
          saveSessions();
        }
      });
      return;

    case 'save-setting': {
      const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
      cfg.update(msg.key, msg.value, true);
      return;
    }

    case 'export-settings': {
      const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
      const exportData = {
        defaultTheme: cfg.get('defaultTheme'),
        defaultFontSize: cfg.get('defaultFontSize'),
        defaultFontFamily: cfg.get('defaultFontFamily'),
        soundEnabled: cfg.get('soundEnabled'),
        particlesEnabled: cfg.get('particlesEnabled'),
        customButtons: cfg.get('customButtons'),
        customSlashCommands: cfg.get('customSlashCommands'),
      };
      const json = JSON.stringify(exportData, null, 2);
      vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'claude-launcher-settings.json')),
        filters: { 'JSON': ['json'] }
      }).then(uri => {
        if (uri) {
          fs.writeFileSync(uri.fsPath, json, 'utf8');
          vscode.window.showInformationMessage('Settings exported: ' + path.basename(uri.fsPath));
        }
      });
      return;
    }

    case 'import-settings':
      vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        filters: { 'JSON': ['json'] }
      }).then(uris => {
        if (!uris || uris.length === 0) return;
        try {
          const text = fs.readFileSync(uris[0].fsPath, 'utf8');
          const data = JSON.parse(text);
          const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
          const keys = ['defaultTheme','defaultFontSize','defaultFontFamily','soundEnabled','particlesEnabled','customButtons','customSlashCommands'];
          for (const k of keys) {
            if (data[k] !== undefined) cfg.update(k, data[k], true);
          }
          vscode.window.showInformationMessage('Settings imported from ' + path.basename(uris[0].fsPath) + '. Reload window to apply.');
        } catch (e) {
          vscode.window.showErrorMessage('Invalid settings file: ' + e.message);
        }
      });
      return;

    case 'close-resume': {
      const titleMap = sessionStoreGet('claudeSessionTitles', {});
      if (entry.sessionId && entry.title && !/^Claude Code( \(\d+\))?$/.test(entry.title)) {
        titleMap[entry.sessionId] = entry.title;
      }
      sessionStoreUpdate('claudeSessionTitles', titleMap);
      if (entry.sessionId) {
        const saved = sessionStoreGet('claudeSavedSessions', []);
        if (!saved.some(s => s.sessionId === entry.sessionId)) {
          saved.unshift({ sessionId: entry.sessionId, title: entry.title, savedAt: Date.now() });
          sessionStoreUpdate('claudeSavedSessions', saved);
        }
      }
      panel.dispose();
      if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
      return;
    }

    case 'open-file':
      handleOpenFile(msg.filePath, msg.line, entry);
      return;

    case 'open-folder':
      handleOpenFolder(msg.filePath, entry);
      return;

    case 'export-conversation':
      handleExportConversation(msg.text, entry, panel);
      return;

    case 'paste-large-text':
      handlePasteLargeText(msg, entry, panel);
      return;

    case 'open-paste-file':
      if (msg.path) {
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
      }
      return;

    case 'cancel-paste-file':
      // v2.5.7: user clicked [취소] on a paste/image attachment toast. PTY
      // backspaces are sent client-side via an 'input' message; here we just
      // remove the temp file so it doesn't linger past its purpose.
      if (msg.path) {
        try { fs.unlinkSync(msg.path); } catch (_) {}
      }
      return;

    case 'restart-session':
      restartPty(entry, panel, context, extensionPath);
      return;

    case 'request-edit-memo':
      vscode.window.showInputBox({
        prompt: t('enterMemo'),
        value: entry.memo || ''
      }).then(value => {
        if (value !== undefined) {
          entry.memo = value;
          saveSessions();
          panel.webview.postMessage({ type: 'memo-updated', memo: value });
        }
      });
      return;

    default:
      console.warn('[Claude Launcher] [router] unknown message type:', msg.type);
  }
}

module.exports = { routeWebviewMessage };
