// @module handlers/exportConversation — saves the session as Markdown.
// v2.6.9: prefer Claude Code's own JSONL (~/.claude/projects/<slug>/<sid>.jsonl)
// over the webview-supplied terminal viewport. The viewport is viewport-capped
// and garbled in Ink fullscreen mode; the JSONL has every turn verbatim. The
// `text` argument from the webview is kept only as a last-resort fallback for
// sessions where no JSONL exists (non-Claude CLI use, or before Claude Code
// started persisting sessions).

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { t } = require('../i18n');
const {
  getSessionJsonlPath,
  readSessionTurns,
  renderMarkdown,
} = require('./jsonlTranscript');

async function handleExportConversation(text, entry, panel) {
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}`;
    const safeName = entry.title.replace(/[<>:"/\\|?*]/g, '_');
    const defaultName = `${dateStr}_${timeStr}_${safeName}.md`;

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(entry.cwd, defaultName)),
      filters: { 'Markdown': ['md'], 'Text': ['txt'] }
    });

    if (!uri) return;

    const jsonlPath = getSessionJsonlPath(entry.cwd, entry.sessionId);
    let content;
    if (jsonlPath) {
      console.log('[export] using JSONL:', jsonlPath);
      const turns = readSessionTurns(jsonlPath);
      content = renderMarkdown(turns, {
        title: entry.title,
        sessionId: entry.sessionId,
        cwd: entry.cwd,
      });
    } else {
      console.log('[export] JSONL missing — fallback to viewport');
      const header = `# ${entry.title}\n\n- ${t('exportLabel')}: ${dateStr} ${pad(now.getHours())}:${pad(now.getMinutes())}\n- ${t('sessionLabel')}: ${entry.sessionId || 'N/A'}\n\n---\n\n`;
      content = header + '```\n' + (text || '') + '\n```\n';
    }

    fs.writeFileSync(uri.fsPath, content, 'utf8');
    panel.webview.postMessage({ type: 'export-result', success: true });
    vscode.window.showInformationMessage(t('conversationSaved') + path.basename(uri.fsPath));
  } catch (e) {
    panel.webview.postMessage({ type: 'export-result', success: false });
    vscode.window.showErrorMessage(t('exportFail') + e.message);
  }
}

module.exports = { handleExportConversation };
