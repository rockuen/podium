// @module tree/SessionTreeDataProvider — sidebar tree view showing session groups.
// Groups: "Resume Later" (pinned) / custom groups / "Recent Sessions" / "Trash".
// Expansion state kept in _expandedGroups (Set), tracked via activate()'s onDidExpand/Collapse.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { t } = require('../i18n');
const { sessionStoreGet } = require('../store/sessionStore');

class SessionTreeDataProvider {
  constructor(context) {
    this._context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._cache = null;
    this._expandedGroups = new Set([t('resumeLaterGroup')]);
  }

  refresh() {
    this._cache = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (!element) {
      if (this._cache) return this._cache;
      this._cache = this._buildGroups();
      return this._cache;
    }
    return element._children || [];
  }

  _getProjectDir() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!cwd) return null;
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return null;
    // Replace all non-alphanumeric chars with - (matches Claude CLI behavior)
    const dirName = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const projDir = path.join(projectsDir, dirName);
    if (fs.existsSync(projDir)) return projDir;
    // Fallback: find folder containing the workspace basename
    try {
      const wsName = path.basename(cwd).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
      const dirs = fs.readdirSync(projectsDir);
      const exact = dirs.find(d => d.toLowerCase() === dirName.toLowerCase());
      if (exact) return path.join(projectsDir, exact);
      const partial = dirs.find(d => d.toLowerCase().includes(wsName));
      if (partial) return path.join(projectsDir, partial);
    } catch (_) {}
    return null;
  }

  _buildGroups() {
    const projDir = this._getProjectDir();
    console.log('[Session] _getProjectDir:', projDir);
    const customGroups = sessionStoreGet('claudeSessionGroups', {});
    const savedSessions = sessionStoreGet('claudeSavedSessions', []);
    const allItems = this._loadSessions();

    const groupedSet = new Set();
    for (const ids of Object.values(customGroups)) {
      for (const id of ids) groupedSet.add(id);
    }
    for (const s of savedSessions) groupedSet.add(s.sessionId);

    const itemMap = new Map();
    for (const item of allItems) itemMap.set(item._sessionId, item);

    const groups = [];
    const exp = this._expandedGroups;
    const stateOf = (name) => exp.has(name) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;

    // Legacy "Resume Later" group (from close-resume)
    const rlName = t('resumeLaterGroup');
    const savedItems = savedSessions.map(s => itemMap.get(s.sessionId)).filter(Boolean);
    if (savedItems.length > 0) {
      const savedGroup = new vscode.TreeItem(`${rlName} (${savedItems.length})`, stateOf(rlName));
      savedGroup.iconPath = new vscode.ThemeIcon('pin');
      savedGroup._children = savedItems;
      groups.push(savedGroup);
    }

    // Custom groups
    for (const [name, ids] of Object.entries(customGroups)) {
      const items = ids.map(id => itemMap.get(id)).filter(Boolean);
      if (items.length === 0) continue;
      for (const item of items) {
        item.iconPath = new vscode.ThemeIcon('folder');
      }
      const group = new vscode.TreeItem(`${name} (${items.length})`, stateOf(name));
      group.iconPath = new vscode.ThemeIcon('folder');
      group.contextValue = 'customGroup';
      group._groupName = name;
      group._children = items;
      groups.push(group);
    }

    // Recent Sessions (ungrouped)
    const rsName = t('recentSessionsGroup');
    const recentItems = allItems.filter(item => !groupedSet.has(item._sessionId));
    if (recentItems.length > 0) {
      const recentGroup = new vscode.TreeItem(`${rsName} (${recentItems.length})`, stateOf(rsName));
      recentGroup.iconPath = new vscode.ThemeIcon('history');
      recentGroup._children = recentItems;
      groups.push(recentGroup);
    }

    // Trash group
    if (projDir) {
      const trashDir = path.join(projDir, 'trash');
      if (fs.existsSync(trashDir)) {
        const trashFiles = fs.readdirSync(trashDir).filter(f => f.endsWith('.jsonl'));
        if (trashFiles.length > 0) {
          const titleMap = sessionStoreGet('claudeSessionTitles', {});
          const trashItems = [];
          for (const f of trashFiles) {
            const sid = f.replace('.jsonl', '');
            const fullPath = path.join(trashDir, f);
            const mtime = fs.statSync(fullPath).mtimeMs;
            const date = new Date(mtime);
            const dateStr = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
            const savedTitle = titleMap[sid];
            const firstMsg = this._extractFirstUserMessage(fullPath);
            if (!savedTitle && !firstMsg) continue;
            const displayText = savedTitle || firstMsg;
            const label = displayText.length > 40 ? displayText.substring(0, 40) + '...' : displayText;
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
            item.description = dateStr;
            item.iconPath = new vscode.ThemeIcon('trash');
            item.contextValue = 'trashed';
            item._sessionId = sid;
            item.command = { command: 'claudeCodeLauncher.resumeSession', title: 'Resume', arguments: [sid] };
            trashItems.push(item);
          }
          if (trashItems.length > 0) {
            const trashGroup = new vscode.TreeItem(`Trash (${trashItems.length})`, stateOf('Trash'));
            trashGroup.iconPath = new vscode.ThemeIcon('trash');
            trashGroup.contextValue = 'trashGroup';
            trashGroup._children = trashItems;
            groups.push(trashGroup);
          }
        }
      }
    }

    return groups;
  }

  _loadSessions() {
    const projDir = this._getProjectDir();
    if (!projDir) return [];

    let files;
    try {
      files = fs.readdirSync(projDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fullPath = path.join(projDir, f);
          return { name: f, path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 30);
    } catch {
      return [];
    }

    const titleMap = sessionStoreGet('claudeSessionTitles', {});

    const items = [];
    for (const file of files) {
      const sessionId = file.name.replace('.jsonl', '');
      const savedTitle = titleMap[sessionId];
      const firstMsg = this._extractFirstUserMessage(file.path);
      if (!savedTitle && !firstMsg) continue;

      const date = new Date(file.mtime);
      const dateStr = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

      const displayText = savedTitle || firstMsg;
      const label = displayText.length > 40 ? displayText.substring(0, 40) + '...' : displayText;

      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.description = dateStr;
      item.tooltip = `${savedTitle ? savedTitle + '\n\n' : ''}${firstMsg || ''}\n\nSession: ${sessionId}\n${date.toLocaleString()}`;
      item.iconPath = new vscode.ThemeIcon(savedTitle ? 'bookmark' : 'comment-discussion');
      item.command = {
        command: 'claudeCodeLauncher.resumeSession',
        title: t('resumeSession'),
        arguments: [sessionId]
      };
      item._sessionId = sessionId;
      items.push(item);
    }
    return items;
  }

  _extractFirstUserMessage(filePath) {
    try {
      let fd, chunk;
      try {
        fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(32768);
        const bytesRead = fs.readSync(fd, buf, 0, 32768, 0);
        chunk = buf.toString('utf-8', 0, bytesRead);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== 'user') continue;
          const msg = d.message;
          if (!msg || msg.role !== 'user') continue;
          let text = '';
          if (typeof msg.content === 'string') {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            for (const c of msg.content) {
              if (c.type === 'text' && c.text) {
                text = c.text;
                break;
              }
            }
          }
          text = text.replace(/<[^>]+>/g, '').trim().split('\n')[0].trim();
          if (text) return text;
        } catch {}
      }
    } catch {}
    return null;
  }
}

module.exports = { SessionTreeDataProvider };
