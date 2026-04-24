// @module tree/SessionTreeDataProvider — sidebar tree view showing session groups.
// Groups: "Resume Later" (pinned) / custom groups / "Recent Sessions" / "Trash".
// Expansion state kept in _expandedGroups (Set), tracked via activate()'s onDidExpand/Collapse.
//
// v2.6.0: custom sort (claudeSessionSortOrder) + 2-level nesting (claudeSessionParent)
// + TreeDragAndDropController for drag-reorder / drag-to-group.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { t } = require('../i18n');
const { sessionStoreGet, sessionStoreUpdate } = require('../store/sessionStore');

const DND_SESSION_MIME = 'application/vnd.code.tree.claudecodelauncher.sessions';
const DND_GROUP_MIME = 'application/vnd.code.tree.claudecodelauncher.groups';

class SessionTreeDataProvider {
  constructor(context) {
    this._context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._cache = null;
    this._expandedGroups = new Set([t('resumeLaterGroup')]);

    // TreeDragAndDropController interface (read by createTreeView(options))
    this.dropMimeTypes = [DND_SESSION_MIME, DND_GROUP_MIME];
    this.dragMimeTypes = [DND_SESSION_MIME, DND_GROUP_MIME];
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
    const dirName = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const projDir = path.join(projectsDir, dirName);
    if (fs.existsSync(projDir)) return projDir;
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

  // Sort comparator: honors claudeSessionSortOrder, falls back to mtime DESC
  _cmp(sortMap, mtimeMap) {
    return (a, b) => {
      const oa = sortMap[a._sessionId];
      const ob = sortMap[b._sessionId];
      if (oa != null && ob != null) return oa - ob;
      if (oa != null) return -1;
      if (ob != null) return 1;
      return (mtimeMap.get(b._sessionId) || 0) - (mtimeMap.get(a._sessionId) || 0);
    };
  }

  _buildGroups() {
    const projDir = this._getProjectDir();
    const customGroups = sessionStoreGet('claudeSessionGroups', {});
    const savedSessions = sessionStoreGet('claudeSavedSessions', []);
    const parents = sessionStoreGet('claudeSessionParent', {});
    const sortOrder = sessionStoreGet('claudeSessionSortOrder', {});
    const allItems = this._loadSessions();

    const itemMap = new Map();
    const mtimeMap = new Map();
    for (const item of allItems) {
      itemMap.set(item._sessionId, item);
      mtimeMap.set(item._sessionId, item._mtime || 0);
    }
    const cmp = this._cmp(sortOrder, mtimeMap);

    // Attach sub-sessions to their parent items. An item is a sub-session if
    // its parent exists in itemMap (otherwise the parent was deleted/trashed
    // and the child falls back to top level).
    const isSubSession = (sid) => {
      const pid = parents[sid];
      return pid && itemMap.has(pid);
    };
    for (const item of allItems) {
      const pid = parents[item._sessionId];
      if (pid && itemMap.has(pid)) {
        const parentItem = itemMap.get(pid);
        parentItem._children = parentItem._children || [];
        parentItem._children.push(item);
        // Mark sub-session for context menu targeting
        item.contextValue = 'subSession';
      }
    }
    for (const item of allItems) {
      if (item._children && item._children.length > 0) {
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        item._children.sort(cmp);
      }
    }

    // Build map: sessionId → group name (for top-level sessions)
    const groupedSet = new Set();
    for (const ids of Object.values(customGroups)) {
      for (const id of ids) groupedSet.add(id);
    }
    for (const s of savedSessions) groupedSet.add(s.sessionId);

    const groups = [];
    const exp = this._expandedGroups;
    const stateOf = (name) => exp.has(name) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;

    // Resume Later (pinned)
    const rlName = t('resumeLaterGroup');
    const savedItems = savedSessions
      .map(s => itemMap.get(s.sessionId))
      .filter(Boolean)
      .filter(it => !isSubSession(it._sessionId));
    if (savedItems.length > 0) {
      savedItems.sort(cmp);
      const savedGroup = new vscode.TreeItem(`${rlName} (${savedItems.length})`, stateOf(rlName));
      savedGroup.iconPath = new vscode.ThemeIcon('pin');
      savedGroup._children = savedItems;
      savedGroup.contextValue = 'resumeLaterGroup';
      groups.push(savedGroup);
    }

    // Custom groups (only top-level sessions; sub-sessions appear under parent)
    for (const [name, ids] of Object.entries(customGroups)) {
      const items = ids
        .map(id => itemMap.get(id))
        .filter(Boolean)
        .filter(it => !isSubSession(it._sessionId));
      if (items.length === 0) continue;
      items.sort(cmp);
      const group = new vscode.TreeItem(`${name} (${items.length})`, stateOf(name));
      group.iconPath = new vscode.ThemeIcon('folder');
      group.contextValue = 'customGroup';
      group._groupName = name;
      group._children = items;
      groups.push(group);
    }

    // Recent Sessions (ungrouped top-level)
    const rsName = t('recentSessionsGroup');
    const recentItems = allItems.filter(item =>
      !groupedSet.has(item._sessionId) && !isSubSession(item._sessionId)
    );
    if (recentItems.length > 0) {
      recentItems.sort(cmp);
      const recentGroup = new vscode.TreeItem(`${rsName} (${recentItems.length})`, stateOf(rsName));
      recentGroup.iconPath = new vscode.ThemeIcon('history');
      recentGroup._children = recentItems;
      recentGroup.contextValue = 'recentGroup';
      groups.push(recentGroup);
    }

    // Trash
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
      // Conversation-style icons: titled sessions get a "discussion" icon;
      // untitled get "comment-draft".
      item.iconPath = new vscode.ThemeIcon(savedTitle ? 'comment-discussion' : 'comment-draft');
      item.command = {
        command: 'claudeCodeLauncher.resumeSession',
        title: t('resumeSession'),
        arguments: [sessionId]
      };
      item.contextValue = 'session';
      item._sessionId = sessionId;
      item._mtime = file.mtime;
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

  // ─── Sort + Nest helpers (v2.6.0) ───────────────────────────────────────

  // Get a session's scope: { group?: string, parent?: string } where it lives.
  // If parent is set, that takes precedence (sibling set = same parent).
  // Else group membership determines sibling set.
  _getScope(sessionId) {
    const parents = sessionStoreGet('claudeSessionParent', {});
    if (parents[sessionId]) return { parent: parents[sessionId] };
    const groups = sessionStoreGet('claudeSessionGroups', {});
    for (const [gname, ids] of Object.entries(groups)) {
      if (ids.includes(sessionId)) return { group: gname };
    }
    return {}; // ungrouped top-level (Recent Sessions)
  }

  // Get ordered sibling list for a given scope. All sessionIds that share the
  // same scope, sorted by current effective order (sortOrder ? mtime).
  _getSiblings(scope) {
    const allItems = this._loadSessions();
    const idSet = new Set(allItems.map(i => i._sessionId));
    const parents = sessionStoreGet('claudeSessionParent', {});
    const groups = sessionStoreGet('claudeSessionGroups', {});
    const sortOrder = sessionStoreGet('claudeSessionSortOrder', {});
    const mtimeMap = new Map(allItems.map(i => [i._sessionId, i._mtime || 0]));

    let siblings;
    if (scope.parent) {
      siblings = allItems.filter(i => parents[i._sessionId] === scope.parent).map(i => i._sessionId);
    } else if (scope.group) {
      siblings = (groups[scope.group] || [])
        .filter(id => idSet.has(id) && !parents[id]);
    } else {
      const grouped = new Set();
      for (const ids of Object.values(groups)) for (const id of ids) grouped.add(id);
      siblings = allItems
        .filter(i => !grouped.has(i._sessionId) && !parents[i._sessionId])
        .map(i => i._sessionId);
    }
    siblings.sort((a, b) => {
      const oa = sortOrder[a], ob = sortOrder[b];
      if (oa != null && ob != null) return oa - ob;
      if (oa != null) return -1;
      if (ob != null) return 1;
      return (mtimeMap.get(b) || 0) - (mtimeMap.get(a) || 0);
    });
    return siblings;
  }

  // Assign sparse integer sortOrder (10, 20, 30, ...) to an ordered id list.
  // Overwrites existing sortOrder entries for these ids only.
  _writeSortOrder(orderedIds) {
    const sortOrder = sessionStoreGet('claudeSessionSortOrder', {});
    let n = 10;
    for (const sid of orderedIds) {
      sortOrder[sid] = n;
      n += 10;
    }
    sessionStoreUpdate('claudeSessionSortOrder', sortOrder);
  }

  // Move a session up/down among its siblings.
  moveSessionUp(sessionId) {
    const scope = this._getScope(sessionId);
    const siblings = this._getSiblings(scope);
    const idx = siblings.indexOf(sessionId);
    if (idx <= 0) return;
    [siblings[idx - 1], siblings[idx]] = [siblings[idx], siblings[idx - 1]];
    this._writeSortOrder(siblings);
    this.refresh();
  }

  moveSessionDown(sessionId) {
    const scope = this._getScope(sessionId);
    const siblings = this._getSiblings(scope);
    const idx = siblings.indexOf(sessionId);
    if (idx < 0 || idx >= siblings.length - 1) return;
    [siblings[idx], siblings[idx + 1]] = [siblings[idx + 1], siblings[idx]];
    this._writeSortOrder(siblings);
    this.refresh();
  }

  // Set parent for session (nest as sub-session). 2-level limit enforced:
  // targetParent must itself be top-level (no parent), and sessionId must not
  // have children.
  setSessionParent(sessionId, parentSessionId) {
    if (sessionId === parentSessionId) return { ok: false, reason: 'self' };
    const parents = sessionStoreGet('claudeSessionParent', {});
    // 2-level limit: parent candidate must not itself be a sub-session
    if (parents[parentSessionId]) return { ok: false, reason: 'depth' };
    // sessionId must not have existing children (would push them to level 3)
    const hasChildren = Object.values(parents).some(p => p === sessionId);
    if (hasChildren) return { ok: false, reason: 'hasChildren' };
    parents[sessionId] = parentSessionId;
    sessionStoreUpdate('claudeSessionParent', parents);
    // Also remove sessionId from any custom group and saved sessions
    // (sub-sessions belong to their parent's scope, not an independent group)
    const groups = sessionStoreGet('claudeSessionGroups', {});
    for (const g of Object.keys(groups)) {
      groups[g] = groups[g].filter(id => id !== sessionId);
      if (groups[g].length === 0) delete groups[g];
    }
    sessionStoreUpdate('claudeSessionGroups', groups);
    this.refresh();
    return { ok: true };
  }

  removeSessionParent(sessionId) {
    const parents = sessionStoreGet('claudeSessionParent', {});
    if (!parents[sessionId]) return;
    delete parents[sessionId];
    sessionStoreUpdate('claudeSessionParent', parents);
    this.refresh();
  }

  // ─── TreeDragAndDropController ──────────────────────────────────────────

  handleDrag(source, dataTransfer, _token) {
    // Sessions (including sub-sessions) → session MIME
    const sessionIds = source
      .filter(it => it && (it.contextValue === 'session' || it.contextValue === 'subSession'))
      .map(it => it._sessionId)
      .filter(Boolean);
    if (sessionIds.length > 0) {
      dataTransfer.set(DND_SESSION_MIME, new vscode.DataTransferItem(sessionIds));
    }
    // Custom groups → group MIME (for reordering)
    const groupNames = source
      .filter(it => it && it.contextValue === 'customGroup')
      .map(it => it._groupName)
      .filter(Boolean);
    if (groupNames.length > 0) {
      dataTransfer.set(DND_GROUP_MIME, new vscode.DataTransferItem(groupNames));
    }
  }

  async handleDrop(target, dataTransfer, _token) {
    // Group drag takes precedence — dragged item is a group, reorder groups.
    const groupItem = dataTransfer.get(DND_GROUP_MIME);
    if (groupItem) {
      const names = this._asArray(groupItem.value);
      if (names.length === 0) return;
      // Drop on another custom group → reorder before target.
      // Drop anywhere else → no-op (don't transform groups into sessions).
      if (target && target.contextValue === 'customGroup' && target._groupName) {
        this._reorderGroupsBefore(names, target._groupName);
        this.refresh();
      }
      return;
    }

    // Session drag (existing behavior)
    const sessItem = dataTransfer.get(DND_SESSION_MIME);
    if (!sessItem) return;
    const ids = this._asArray(sessItem.value);
    if (ids.length === 0) return;

    // Drop on custom group → move to that group (root level, end)
    if (target && target.contextValue === 'customGroup') {
      this._moveToGroup(ids, target._groupName);
      this.refresh();
      return;
    }

    // Drop on Recent Sessions group → ungrouped top level
    if (target && target.contextValue === 'recentGroup') {
      this._moveToUngrouped(ids);
      this.refresh();
      return;
    }

    // Drop on another session → reorder: insert before target, inherit scope
    if (target && (target.contextValue === 'session' || target.contextValue === 'subSession')) {
      this._reorderBefore(ids, target._sessionId);
      this.refresh();
      return;
    }

    // Drop in empty area — no-op
  }

  _asArray(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch (_) { return [v]; }
    }
    return [v];
  }

  // ─── Group ordering helpers (v2.6.0) ────────────────────────────────────

  // Rewrite claudeSessionGroups with the given name order. Preserves each
  // group's session-id array. Object insertion order is preserved by modern
  // JS engines for non-integer string keys, and JSON.stringify honors it —
  // so we get stable persistence without an extra order map.
  _writeGroupOrder(orderedNames) {
    const groups = sessionStoreGet('claudeSessionGroups', {});
    const rebuilt = {};
    for (const name of orderedNames) {
      if (groups[name]) rebuilt[name] = groups[name];
    }
    // Append any groups that weren't in orderedNames (defensive)
    for (const [name, ids] of Object.entries(groups)) {
      if (!(name in rebuilt)) rebuilt[name] = ids;
    }
    sessionStoreUpdate('claudeSessionGroups', rebuilt);
  }

  _reorderGroupsBefore(draggedNames, targetName) {
    const groups = sessionStoreGet('claudeSessionGroups', {});
    const names = Object.keys(groups);
    const draggedSet = new Set(draggedNames);
    // Remove dragged names first
    const remaining = names.filter(n => !draggedSet.has(n));
    const tIdx = remaining.indexOf(targetName);
    const insertList = draggedNames.filter(n => names.includes(n));
    if (tIdx >= 0) {
      remaining.splice(tIdx, 0, ...insertList);
    } else {
      remaining.unshift(...insertList);
    }
    this._writeGroupOrder(remaining);
  }

  moveGroupUp(groupName) {
    const groups = sessionStoreGet('claudeSessionGroups', {});
    const names = Object.keys(groups);
    const idx = names.indexOf(groupName);
    if (idx <= 0) return;
    [names[idx - 1], names[idx]] = [names[idx], names[idx - 1]];
    this._writeGroupOrder(names);
    this.refresh();
  }

  moveGroupDown(groupName) {
    const groups = sessionStoreGet('claudeSessionGroups', {});
    const names = Object.keys(groups);
    const idx = names.indexOf(groupName);
    if (idx < 0 || idx >= names.length - 1) return;
    [names[idx], names[idx + 1]] = [names[idx + 1], names[idx]];
    this._writeGroupOrder(names);
    this.refresh();
  }

  _moveToGroup(sessionIds, groupName) {
    const groups = sessionStoreGet('claudeSessionGroups', {});
    const parents = sessionStoreGet('claudeSessionParent', {});
    for (const sid of sessionIds) {
      // Remove from all groups and clear parent
      for (const g of Object.keys(groups)) {
        groups[g] = groups[g].filter(id => id !== sid);
      }
      delete parents[sid];
    }
    if (!groups[groupName]) groups[groupName] = [];
    for (const sid of sessionIds) {
      if (!groups[groupName].includes(sid)) groups[groupName].push(sid);
    }
    for (const g of Object.keys(groups)) {
      if (groups[g].length === 0) delete groups[g];
    }
    sessionStoreUpdate('claudeSessionGroups', groups);
    sessionStoreUpdate('claudeSessionParent', parents);
  }

  _moveToUngrouped(sessionIds) {
    const groups = sessionStoreGet('claudeSessionGroups', {});
    const parents = sessionStoreGet('claudeSessionParent', {});
    for (const sid of sessionIds) {
      for (const g of Object.keys(groups)) {
        groups[g] = groups[g].filter(id => id !== sid);
      }
      delete parents[sid];
    }
    for (const g of Object.keys(groups)) {
      if (groups[g].length === 0) delete groups[g];
    }
    sessionStoreUpdate('claudeSessionGroups', groups);
    sessionStoreUpdate('claudeSessionParent', parents);
  }

  // Reorder: move sessionIds right before targetSessionId. Dragged items
  // inherit target's scope (same group + same parent). 2-level safety: if
  // target is a sub-session and any dragged item has children, reject those.
  _reorderBefore(sessionIds, targetSessionId) {
    const parents = sessionStoreGet('claudeSessionParent', {});
    const groups = sessionStoreGet('claudeSessionGroups', {});
    const targetParent = parents[targetSessionId];
    let targetGroup = null;
    for (const [gname, gids] of Object.entries(groups)) {
      if (gids.includes(targetSessionId)) { targetGroup = gname; break; }
    }

    // Filter: can't drop onto self
    const incoming = sessionIds.filter(sid => sid !== targetSessionId);
    if (incoming.length === 0) return;

    // 2-level safety: if target has parent (target is sub-session), dragged
    // items also become sub-sessions under same parent. Skip any dragged
    // item that has children of its own.
    const filtered = [];
    for (const sid of incoming) {
      if (targetParent) {
        const hasChildren = Object.values(parents).some(p => p === sid);
        if (hasChildren) continue; // would exceed 2 levels
      }
      filtered.push(sid);
    }
    if (filtered.length === 0) return;

    // Update scope for each dragged item
    for (const sid of filtered) {
      // Clear from any existing group
      for (const g of Object.keys(groups)) {
        if (g !== targetGroup) groups[g] = groups[g].filter(id => id !== sid);
      }
      // Set parent or group
      if (targetParent) {
        parents[sid] = targetParent;
      } else {
        delete parents[sid];
        if (targetGroup) {
          if (!groups[targetGroup]) groups[targetGroup] = [];
          if (!groups[targetGroup].includes(sid)) groups[targetGroup].push(sid);
        }
      }
    }
    for (const g of Object.keys(groups)) {
      if (groups[g].length === 0) delete groups[g];
    }
    sessionStoreUpdate('claudeSessionGroups', groups);
    sessionStoreUpdate('claudeSessionParent', parents);

    // Rewrite sortOrder among siblings (scope of target, now includes filtered)
    const scope = targetParent ? { parent: targetParent } : (targetGroup ? { group: targetGroup } : {});
    let siblings = this._getSiblings(scope);
    // Remove dragged ids from siblings list, then insert before target
    const draggedSet = new Set(filtered);
    siblings = siblings.filter(sid => !draggedSet.has(sid));
    const tIdx = siblings.indexOf(targetSessionId);
    if (tIdx >= 0) {
      siblings.splice(tIdx, 0, ...filtered);
    } else {
      siblings.unshift(...filtered);
    }
    this._writeSortOrder(siblings);
  }
}

module.exports = { SessionTreeDataProvider };
