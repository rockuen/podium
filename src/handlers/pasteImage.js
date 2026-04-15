// @module handlers/pasteImage — clipboard image → temp PNG file → PTY input.
// Two entry points: webview-side base64 paste, or system clipboard fallback (PowerShell/osascript).

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { t } = require('../i18n');

function handlePasteImage(base64Data, entry, panel) {
  try {
    const tmpDir = path.join(os.tmpdir(), 'claude-code-images');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const filename = `clipboard-${Date.now()}.png`;
    const filepath = path.join(tmpDir, filename);

    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filepath, buffer);

    const normalized = filepath.replace(/\\/g, '/');
    if (entry.pty) entry.pty.write(normalized + ' ');
    try { panel.webview.postMessage({ type: 'image-paste-result', success: true, filename, fullPath: filepath }); } catch (_) {}
  } catch (e) {
    vscode.window.showErrorMessage(t('imageSaveFail') + e.message);
    try { panel.webview.postMessage({ type: 'image-paste-result', success: false, reason: e.message }); } catch (_) {}
  }
}

function readClipboardImageFromSystem(entry, panel) {
  const tmpDir = path.join(os.tmpdir(), 'claude-code-images');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const filename = `clipboard-${Date.now()}.png`;
  const filepath = path.join(tmpDir, filename);
  const { execFile } = require('child_process');

  let program, args;
  if (process.platform === 'win32') {
    const escapedPath = filepath.replace(/'/g, "''");
    const psScript = `Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if($img){ $img.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png); 'OK' } else { 'NO' }`;
    program = 'powershell';
    args = ['-NoProfile', '-Command', psScript];
  } else if (process.platform === 'darwin') {
    program = 'osascript';
    args = ['-e', 'try', '-e', 'set imgData to the clipboard as «class PNGf»', '-e', `set f to open for access POSIX file "${filepath}" with write permission`, '-e', 'write imgData to f', '-e', 'close access f', '-e', 'return "OK"', '-e', 'on error', '-e', 'return "NO"', '-e', 'end try'];
  } else {
    panel.webview.postMessage({ type: 'image-paste-result', success: false, reason: 'unsupported-platform' });
    return;
  }

  execFile(program, args, { timeout: 5000 }, (err, stdout) => {
    if (entry._disposed) return;
    if (err) {
      try { panel.webview.postMessage({ type: 'image-paste-result', success: false, reason: 'clipboard-no-image' }); } catch (_) {}
      return;
    }

    const result = stdout.trim();
    if (result === 'OK' && fs.existsSync(filepath)) {
      const normalized = filepath.replace(/\\/g, '/');
      if (entry.pty) entry.pty.write(normalized + ' ');
      try { panel.webview.postMessage({ type: 'image-paste-result', success: true, filename, fullPath: filepath }); } catch (_) {}
    } else {
      try { panel.webview.postMessage({ type: 'image-paste-result', success: false, reason: 'clipboard-no-image' }); } catch (_) {}
    }
  });
}

module.exports = { handlePasteImage, readClipboardImageFromSystem };
