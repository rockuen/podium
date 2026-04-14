// @module handlers/openFile — opens a file via OS default app or IDE editor.
// Handles partial-path recovery (cwd/ancestors/home/roots) and
// honors fileAssociations setting (obsidian/excel/browser/system/editor/auto).
//
// Windows quirk: vscode.env.openExternal silently fails for file:// URIs in
// some Electron hosts (Antigravity). We use `cmd /c start` with verbatim args
// so cmd sees the quoted path intact.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { t } = require('../i18n');

// Resolve a possibly-partial path to an existing absolute path.
// Tries (in order): absolute, cwd+frag, walk up cwd ancestors, homedir, platform roots.
// Returns first existing candidate, or null. Verifies every candidate with fs.existsSync.
function resolvePathFragment(frag, cwd) {
  if (!frag) return null;

  const normalize = (p) => p.replace(/\\/g, '/').replace(/\//g, path.sep);

  if (path.isAbsolute(frag)) {
    const abs = normalize(frag);
    if (fs.existsSync(abs)) return abs;
    frag = frag.replace(/^[\\/]+/, '');
  }

  const candidates = [];
  if (cwd) candidates.push(path.join(cwd, frag));

  let current = cwd;
  while (current) {
    const parent = path.dirname(current);
    if (parent === current) break;
    candidates.push(path.join(parent, frag));
    current = parent;
  }

  candidates.push(path.join(os.homedir(), frag));
  if (process.platform === 'darwin') candidates.push(path.join('/Users', frag));
  else if (process.platform === 'linux') candidates.push(path.join('/home', frag));

  for (const c of candidates) {
    const n = normalize(c);
    if (fs.existsSync(n)) return n;
  }
  return null;
}

function handleOpenFile(filePath, line, entry) {
  let raw = (filePath || '').trim();
  if (!raw) {
    vscode.window.showWarningMessage(t('fileNotFound') + filePath);
    return;
  }

  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = path.join(os.homedir(), raw.slice(1));
  }

  let absPath = resolvePathFragment(raw, entry.cwd);

  // Fallback: basename search within cwd (legacy behavior for deeply nested project files)
  if (!absPath) {
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
          if (e.isFile() && e.name === basename) found.push(full);
          else if (e.isDirectory()) searchDir(full, depth + 1);
        }
      } catch (_) {}
    }
    if (entry.cwd) searchDir(entry.cwd, 0);
    const match = found.find(f => f.replace(/\\/g, '/').endsWith(suffix)) || found[0];
    if (match) absPath = match;
  }

  if (!absPath || !fs.existsSync(absPath)) {
    vscode.window.showWarningMessage(t('fileNotFound') + filePath);
    return;
  }

  try {
    if (fs.statSync(absPath).isDirectory()) {
      vscode.window.showWarningMessage(t('fileNotFound') + filePath);
      return;
    }
  } catch (_) {}

  absPath = absPath.replace(/\\/g, '/');

  const { spawn } = require('child_process');
  const config = vscode.workspace.getConfiguration('claudeCodeLauncher');
  const fileAssoc = config.get('fileAssociations', {});
  const ext = path.extname(absPath).toLowerCase();
  const method = fileAssoc[ext] || 'auto';
  const nativePath = absPath.replace(/\//g, path.sep);

  const shellOpen = () => {
    try {
      let child;
      if (process.platform === 'win32') {
        child = spawn('cmd.exe', ['/c', 'start', '""', `"${nativePath}"`], {
          detached: true,
          stdio: 'ignore',
          windowsVerbatimArguments: true
        });
      } else if (process.platform === 'darwin') {
        child = spawn('open', [nativePath], { detached: true, stdio: 'ignore' });
      } else {
        child = spawn('xdg-open', [nativePath], { detached: true, stdio: 'ignore' });
      }
      child.on('error', (err) => {
        vscode.window.showWarningMessage('Open file failed: ' + (err && err.message ? err.message : String(err)));
      });
      child.unref();
    } catch (e) {
      vscode.window.showWarningMessage('Open file failed: ' + (e && e.message ? e.message : String(e)));
    }
  };

  const openNative = (app) => {
    if (process.platform === 'darwin') {
      spawn('open', app ? ['-a', app, nativePath] : [nativePath], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      // Windows app names like 'excel' rarely live in PATH. Defer to file association.
      shellOpen();
    } else {
      spawn(app || 'xdg-open', [nativePath], { detached: true, stdio: 'ignore' }).unref();
    }
  };

  if (method === 'obsidian' || (method === 'auto' && ext === '.md')) {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath?.replace(/\\/g, '/');
    const vaultRoot = wsFolder ? wsFolder + '/' : '';
    const vaultName = wsFolder ? path.basename(wsFolder) : '';
    let relativePath = absPath;
    if (vaultRoot && absPath.toLowerCase().startsWith(vaultRoot.toLowerCase())) {
      relativePath = absPath.substring(vaultRoot.length);
    }
    const obsidianUri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relativePath)}`;
    vscode.env.openExternal(vscode.Uri.parse(obsidianUri));
  } else if (method === 'excel') {
    if (process.platform === 'darwin') {
      openNative('Microsoft Excel');
    } else if (process.platform === 'win32') {
      shellOpen();
    } else {
      spawn('libreoffice', ['--calc', nativePath], { detached: true, stdio: 'ignore' }).unref();
    }
  } else if (method === 'browser' || method === 'system') {
    openNative(null);
  } else if (method === 'editor') {
    const fileUri = vscode.Uri.file(nativePath);
    const options = line ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : {};
    vscode.window.showTextDocument(fileUri, options);
  } else if (method !== 'auto') {
    if (process.platform === 'darwin') {
      openNative(method);
    } else if (process.platform === 'win32') {
      shellOpen();
    } else {
      spawn(method, [nativePath], { detached: true, stdio: 'ignore' }).unref();
    }
  } else {
    // auto: OS default for known types, IDE editor for others
    if (/\.(html?|xlsx?|csv|pptx?|docx?|pdf|png|jpe?g|gif|svg|zip|tar|gz)$/i.test(ext)) {
      shellOpen();
    } else {
      const fileUri = vscode.Uri.file(nativePath);
      const options = line ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : {};
      vscode.window.showTextDocument(fileUri, options);
    }
  }
}

module.exports = { handleOpenFile, resolvePathFragment };
