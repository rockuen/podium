// @module handlers/exportConversation — saves PTY transcript as Markdown.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { t } = require('../i18n');

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

    const header = `# ${entry.title}\n\n- ${t('exportLabel')}: ${dateStr} ${pad(now.getHours())}:${pad(now.getMinutes())}\n- ${t('sessionLabel')}: ${entry.sessionId || 'N/A'}\n\n---\n\n`;
    const content = header + '```\n' + text + '\n```\n';

    fs.writeFileSync(uri.fsPath, content, 'utf8');
    panel.webview.postMessage({ type: 'export-result', success: true });
    vscode.window.showInformationMessage(t('conversationSaved') + path.basename(uri.fsPath));
  } catch (e) {
    panel.webview.postMessage({ type: 'export-result', success: false });
    vscode.window.showErrorMessage(t('exportFail') + e.message);
  }
}

module.exports = { handleExportConversation };
