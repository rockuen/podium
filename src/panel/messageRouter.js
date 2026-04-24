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
const { autoSendToEntry } = require('../pty/autoSend');
const { handleToolbar } = require('../handlers/toolbar');
const { handlePasteImage, readClipboardImageFromSystem } = require('../handlers/pasteImage');
const { handleDropFiles } = require('../handlers/dropFiles');
const { handleOpenFile } = require('../handlers/openFile');
const { handleOpenFolder } = require('../handlers/openFolder');
const { handleExportConversation } = require('../handlers/exportConversation');
const { handlePasteLargeText } = require('../handlers/pasteLargeText');
const {
  getSessionJsonlPath,
  readSessionTurns,
  renderMarkdown,
  renderPlainText,
  countConversationTurns,
} = require('../handlers/jsonlTranscript');
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

    // v2.6.18: programmatic slash-command / text submission. Unlike `input`,
    // this path appends Enter via `tmux send-keys` in Podium-ready sessions so
    // Claude CLI's win32-input-mode receives a proper submit instead of a
    // literal newline. See src/pty/autoSend.js for the root-cause write-up.
    case 'auto-send':
      if (entry.pty) autoSendToEntry(entry, msg.text);
      return;

    case 'resize':
      entry._lastCols = msg.cols;
      entry._lastRows = msg.rows;
      if (entry.pty) try { entry.pty.resize(msg.cols, msg.rows); } catch (_) {}
      return;

    // v2.6.4: force TUI full redraw without touching session or scrollback.
    // Useful when fullscreen rendering gets corrupted (overlapping text,
    // ghost lines) after wheel scrolling. We toggle the PTY size by 1 column
    // and back so the TUI receives two SIGWINCH signals and redraws from
    // scratch. No SIGINT, no /clear, no /compact — just a visual refresh.
    case 'redraw-screen':
      if (!entry.pty) return;
      try {
        const cols = entry._lastCols || 80;
        const rows = entry._lastRows || 24;
        const tmpCols = Math.max(2, cols - 1);
        entry.pty.resize(tmpCols, rows);
        setTimeout(() => {
          try { entry.pty && entry.pty.resize(cols, rows); } catch (_) {}
        }, 40);
      } catch (_) {}
      return;

    case 'toolbar':
      handleToolbar(msg.action, entry, context, extensionPath, createPanel);
      return;

    // v0.3.1 · Summon Team — keep this legacy chat window as the leader
    // and open 2 role-typed worker chat windows to the right (ViewColumn
    // .Beside). The orchestrator binds all three via LegacyPanelBridge.
    // The user keeps the familiar chat UI in every pane.
    case 'summon-team':
      vscode.commands.executeCommand('claudeCodeLauncher.podium.summonTeam', {
        leaderEntry: entry,
      });
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

    // v2.6.9: Copy-All reads Claude's JSONL and writes plain text to the
    // system clipboard from the extension side. The webview supplies a
    // viewport fallback for the rare case that JSONL is missing.
    case 'copy-all-request': {
      (async () => {
        try {
          const jsonlPath = getSessionJsonlPath(entry.cwd, entry.sessionId);
          let textToCopy;
          if (jsonlPath) {
            const turns = readSessionTurns(jsonlPath);
            textToCopy = renderPlainText(turns);
          } else {
            textToCopy = msg.fallback || '';
          }
          if (!textToCopy) {
            panel.webview.postMessage({ type: 'copy-all-result', success: false });
            vscode.window.showWarningMessage(t('copiedAllFail'));
            return;
          }
          await vscode.env.clipboard.writeText(textToCopy);
          panel.webview.postMessage({ type: 'copy-all-result', success: true, source: jsonlPath ? 'jsonl' : 'fallback' });
          vscode.window.showInformationMessage(t('copiedAll'));
        } catch (e) {
          console.warn('[copy-all] failed:', e && e.message);
          panel.webview.postMessage({ type: 'copy-all-result', success: false });
          vscode.window.showErrorMessage(t('copiedAllFail') + ': ' + (e && e.message || ''));
        }
      })();
      return;
    }

    // v2.6.9: Copy-Mode overlay requests the rendered Markdown transcript.
    // If JSONL is missing, fall back to the viewport text the webview sent.
    case 'copy-mode-request': {
      try {
        const jsonlPath = getSessionJsonlPath(entry.cwd, entry.sessionId);
        if (jsonlPath) {
          const turns = readSessionTurns(jsonlPath);
          const md = renderMarkdown(turns, {
            title: entry.title,
            sessionId: entry.sessionId,
            cwd: entry.cwd,
          });
          panel.webview.postMessage({
            type: 'copy-mode-content',
            text: md,
            source: 'jsonl',
            turns: countConversationTurns(turns),
          });
        } else {
          const notice = t('copyModeNoTranscript') || 'No Claude transcript found — showing terminal viewport.';
          const text = notice + '\n\n' + (msg.fallback || '');
          panel.webview.postMessage({
            type: 'copy-mode-content',
            text,
            source: 'fallback',
            turns: 0,
          });
        }
      } catch (e) {
        console.warn('[copy-mode] failed:', e && e.message);
        panel.webview.postMessage({
          type: 'copy-mode-content',
          text: 'Failed to load transcript: ' + (e && e.message || 'unknown error'),
          source: 'fallback',
          turns: 0,
        });
      }
      return;
    }

    // Overlay "Copy Selection" — webview sends the drag-selected text and
    // the extension writes it to the clipboard. Avoids webview clipboard
    // permission pitfalls.
    case 'copy-selection-from-overlay': {
      (async () => {
        try {
          const sel = String(msg.text || '').trim();
          if (!sel) {
            panel.webview.postMessage({ type: 'copy-selection-result', success: false });
            return;
          }
          await vscode.env.clipboard.writeText(sel);
          panel.webview.postMessage({ type: 'copy-selection-result', success: true });
        } catch (e) {
          console.warn('[copy-selection] failed:', e && e.message);
          panel.webview.postMessage({ type: 'copy-selection-result', success: false });
        }
      })();
      return;
    }

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
      console.warn('[Podium] [router] unknown message type:', msg.type);
  }
}

module.exports = { routeWebviewMessage };
