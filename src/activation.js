// @module activation — activate()/deactivate() lifecycle hooks.
// Exposes 10 commands under the `claudeCodeLauncher.*` prefix (legacy identifier,
// do NOT rename — user keybindings.json depends on it).
//
// activate() flow (order is load-bearing):
//   1. state.context / isDeactivating
//   2. migrateFromWorkspaceState (legacy workspaceState → sessions.json)
//   3. statusBar creation + show
//   4. 10 command registrations (each subscriptions.push)
//   5. SessionTreeDataProvider + treeView + expand/collapse tracking
//   6. restoreSessions (MUST be last — earlier restore would try to refresh
//      a treeView that isn't registered yet)

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { t } = require('./i18n');
const state = require('./state');
const { sessionStoreGet, sessionStoreUpdate, migrateFromWorkspaceState } = require('./store/sessionStore');
const { saveSessions, restoreSessions } = require('./store/sessionManager');
const { killPtyProcess } = require('./pty/kill');
const { SessionTreeDataProvider } = require('./tree/SessionTreeDataProvider');
const { setStatusBar } = require('./panel/statusIndicator');
const { createPanel } = require('./panel/createPanel');

function activate(context) {
  state.context = context;
  state.isDeactivating = false;
  const extensionPath = context.extensionPath;

  // Migrate legacy workspaceState data to JSON file
  migrateFromWorkspaceState(context);

  state.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  state.statusBar.command = 'claudeCodeLauncher.open';
  setStatusBar('idle');
  state.statusBar.show();
  context.subscriptions.push(state.statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.open', () => {
      createPanel(context, extensionPath, null);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.renameTab', async () => {
      let activeEntry = null;
      for (const [, entry] of state.panels) {
        if (entry.panel.active) { activeEntry = entry; break; }
      }
      if (!activeEntry) {
        vscode.window.showWarningMessage(t('noActiveTab'));
        return;
      }
      const newName = await vscode.window.showInputBox({
        prompt: t('enterTabName'),
        value: activeEntry.title
      });
      if (newName) {
        activeEntry.title = newName;
        activeEntry.panel.title = newName;
        saveSessions();
      }
    })
  );

  // Session tree view — v2.6.0: register TreeDragAndDropController via provider
  state.sessionTreeProvider = new SessionTreeDataProvider(context);
  const treeView = vscode.window.createTreeView('claudeCodeLauncher.sessionList', {
    treeDataProvider: state.sessionTreeProvider,
    dragAndDropController: state.sessionTreeProvider,
    canSelectMany: true
  });
  context.subscriptions.push(treeView);

  // Track expanded groups
  treeView.onDidExpandElement(e => {
    if (e.element.label) state.sessionTreeProvider._expandedGroups.add(String(e.element.label).replace(/\s*\(\d+\)$/, ''));
  });
  treeView.onDidCollapseElement(e => {
    if (e.element.label) state.sessionTreeProvider._expandedGroups.delete(String(e.element.label).replace(/\s*\(\d+\)$/, ''));
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.refreshSessions', () => {
      state.sessionTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.resumeSession', (sessionId) => {
      const titleMap = sessionStoreGet('claudeSessionTitles', {});
      const title = titleMap[sessionId] || undefined;
      // Remove from saved sessions list when resuming
      const saved = sessionStoreGet('claudeSavedSessions', []);
      const filtered = saved.filter(s => s.sessionId !== sessionId);
      if (filtered.length !== saved.length) {
        sessionStoreUpdate('claudeSavedSessions', filtered);
      }
      createPanel(context, extensionPath, { sessionId, title });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveToGroup', async (item) => {
      const sessionId = item?._sessionId;
      if (!sessionId) return;
      const groups = sessionStoreGet('claudeSessionGroups', {});
      const groupNames = Object.keys(groups);
      const picks = [...groupNames, '$(add) New Group...', '$(close) Remove from Group'];
      const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'Move session to group...' });
      if (!choice) return;
      // Remove from all existing groups first
      for (const g of Object.keys(groups)) {
        groups[g] = groups[g].filter(id => id !== sessionId);
        if (groups[g].length === 0) delete groups[g];
      }
      // Also remove from legacy saved/archived
      const saved = sessionStoreGet('claudeSavedSessions', []);
      sessionStoreUpdate('claudeSavedSessions', saved.filter(s => s.sessionId !== sessionId));
      const archived = sessionStoreGet('claudeArchivedSessions', []);
      sessionStoreUpdate('claudeArchivedSessions', archived.filter(s => s.sessionId !== sessionId));
      if (choice === '$(close) Remove from Group') {
        // Just remove, already done above
      } else if (choice === '$(add) New Group...') {
        const name = await vscode.window.showInputBox({ prompt: 'Group name' });
        if (name) {
          if (!groups[name]) groups[name] = [];
          groups[name].push(sessionId);
        }
      } else {
        if (!groups[choice]) groups[choice] = [];
        groups[choice].push(sessionId);
      }
      sessionStoreUpdate('claudeSessionGroups', groups);
      if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.deleteGroup', async (item) => {
      const groups = sessionStoreGet('claudeSessionGroups', {});
      const choice = item?._groupName;
      if (!choice || !groups[choice]) return;
      delete groups[choice];
      sessionStoreUpdate('claudeSessionGroups', groups);
      if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.renameGroup', async (item) => {
      const groups = sessionStoreGet('claudeSessionGroups', {});
      const choice = item?._groupName;
      if (!choice || !groups[choice]) return;
      const newName = await vscode.window.showInputBox({ prompt: 'New group name', value: choice });
      if (!newName || newName === choice) return;
      groups[newName] = groups[choice];
      delete groups[choice];
      // Update expanded state
      if (state.sessionTreeProvider._expandedGroups.has(choice)) {
        state.sessionTreeProvider._expandedGroups.delete(choice);
        state.sessionTreeProvider._expandedGroups.add(newName);
      }
      sessionStoreUpdate('claudeSessionGroups', groups);
      if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
    })
  );

  // Trash: delete session (move .jsonl to trash/)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.trashSession', async (item) => {
      const sessionId = item?._sessionId;
      if (!sessionId) return;
      const projDir = state.sessionTreeProvider._getProjectDir();
      if (!projDir) return;
      const src = path.join(projDir, sessionId + '.jsonl');
      if (!fs.existsSync(src)) return;
      const trashDir = path.join(projDir, 'trash');
      if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(src, path.join(trashDir, sessionId + '.jsonl'));
      // Remove from all groups
      const groups = sessionStoreGet('claudeSessionGroups', {});
      for (const g of Object.keys(groups)) {
        groups[g] = groups[g].filter(id => id !== sessionId);
        if (groups[g].length === 0) delete groups[g];
      }
      sessionStoreUpdate('claudeSessionGroups', groups);
      const saved = sessionStoreGet('claudeSavedSessions', []);
      sessionStoreUpdate('claudeSavedSessions', saved.filter(s => s.sessionId !== sessionId));
      if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
    })
  );

  // Trash: restore session
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.restoreSession', async (item) => {
      const sessionId = item?._sessionId;
      if (!sessionId) return;
      const projDir = state.sessionTreeProvider._getProjectDir();
      if (!projDir) return;
      const trashDir = path.join(projDir, 'trash');
      const src = path.join(trashDir, sessionId + '.jsonl');
      if (!fs.existsSync(src)) return;
      fs.renameSync(src, path.join(projDir, sessionId + '.jsonl'));
      if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
    })
  );

  // v2.6.0: sort + nesting commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveSessionUp', (item) => {
      const sid = item?._sessionId;
      if (sid) state.sessionTreeProvider.moveSessionUp(sid);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveSessionDown', (item) => {
      const sid = item?._sessionId;
      if (sid) state.sessionTreeProvider.moveSessionDown(sid);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveUnderSession', async (item) => {
      const sid = item?._sessionId;
      if (!sid) return;
      // Build candidate list: top-level sessions only (parent empty), not self
      const parents = sessionStoreGet('claudeSessionParent', {});
      const titleMap = sessionStoreGet('claudeSessionTitles', {});
      const projDir = state.sessionTreeProvider._getProjectDir();
      if (!projDir) return;
      const files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
      const hasChildrenOfMe = Object.values(parents).some(p => p === sid);
      if (hasChildrenOfMe) {
        vscode.window.showWarningMessage(t('nestDepthErr'));
        return;
      }
      const candidates = [];
      for (const f of files) {
        const cid = f.replace('.jsonl', '');
        if (cid === sid) continue;
        if (parents[cid]) continue; // can't nest under a sub-session
        const label = titleMap[cid] || cid.substring(0, 8);
        candidates.push({ label, detail: cid, sessionId: cid });
      }
      if (candidates.length === 0) {
        vscode.window.showInformationMessage(t('nestNoCandidates'));
        return;
      }
      const pick = await vscode.window.showQuickPick(candidates, {
        placeHolder: t('nestPickPlaceholder'),
        matchOnDetail: true
      });
      if (!pick) return;
      const result = state.sessionTreeProvider.setSessionParent(sid, pick.sessionId);
      if (!result.ok) {
        const reasons = { self: t('nestSelfErr'), depth: t('nestDepthErr'), hasChildren: t('nestHasChildrenErr') };
        vscode.window.showWarningMessage(reasons[result.reason] || 'Failed to nest');
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.removeSessionParent', (item) => {
      const sid = item?._sessionId;
      if (sid) state.sessionTreeProvider.removeSessionParent(sid);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveGroupUp', (item) => {
      const name = item?._groupName;
      if (name) state.sessionTreeProvider.moveGroupUp(name);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveGroupDown', (item) => {
      const name = item?._groupName;
      if (name) state.sessionTreeProvider.moveGroupDown(name);
    })
  );

  // Trash: empty all
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.emptyTrash', async () => {
      const projDir = state.sessionTreeProvider._getProjectDir();
      if (!projDir) return;
      const trashDir = path.join(projDir, 'trash');
      if (!fs.existsSync(trashDir)) return;
      const files = fs.readdirSync(trashDir).filter(f => f.endsWith('.jsonl'));
      if (files.length === 0) return;
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${files.length} session(s) permanently?`, { modal: true }, 'Delete'
      );
      if (confirm === 'Delete') {
        for (const f of files) fs.unlinkSync(path.join(trashDir, f));
        if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
      }
    })
  );

  // ─── Orchestration placeholder commands ───
  // M3.A: All orchestration commands (including CCG) are registered inside
  // orchestration/index.ts. No placeholders remain in activation.js.

  // ─── Context keys for conditional views (M1) ───
  for (const ck of [
    'claudeCodeLauncher.podiumModeActive',
    'claudeCodeLauncher.teamSelected',
    'claudeCodeLauncher.hasAnyTeam',
    'claudeCodeLauncher.gatewayRegistered',
    'claudeCodeLauncher.providerHealthy'
  ]) {
    vscode.commands.executeCommand('setContext', ck, false);
  }

  // ─── Orchestration status bar entry point (M1) ───
  state.orchStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  state.orchStatusBar.text = '$(organization) Orchestration';
  state.orchStatusBar.tooltip = 'Claude: Enter Podium Mode';
  state.orchStatusBar.command = 'claudeCodeLauncher.podium.enter';
  state.orchStatusBar.show();
  context.subscriptions.push(state.orchStatusBar);

  // ─── Orchestration layer (Podium) — conditional load ───
  // M2.F: orchestration/index.ts activate() is async and registers all
  // orchestration commands + views itself. We fire-and-forget the Promise
  // and resolve state.orch lazily once it settles.
  try {
    const orchModule = require('../out/orchestration/index.js');
    Promise.resolve(orchModule.activate(context))
      .then((orch) => {
        state.orch = orch;
        context.subscriptions.push({
          dispose: () => { try { orch.dispose(); } catch (_) { /* ignore */ } }
        });
      })
      .catch((e) => {
        console.warn('[orchestration] activation failed:', e?.message || e);
      });
  } catch (e) {
    console.warn('[orchestration] not available:', e?.message || e);
  }

  // ─── Orchestration commands ───
  // M2.F: podium.* / team.* / hud.* / conversation.* / history.* /
  // system.* / session.{filter,clearFilter,openDir} are registered inside
  // orchestration/index.ts (see activate() above). Nothing to wire here.

  // Restore previous sessions (MUST be last — tree + commands must be ready first)
  restoreSessions(s => createPanel(context, extensionPath, s));
}

function deactivate() {
  state.isDeactivating = true;

  // Save sessions BEFORE cleanup so they survive reload
  if (state.context && state.panels.size > 0) {
    const sessions = [];
    let order = 0;
    for (const [, entry] of state.panels) {
      if (!entry.pty) continue; // don't restore dead sessions
      sessions.push({
        title: entry.title,
        memo: entry.memo || '',
        cwd: entry.cwd,
        sessionId: entry.sessionId,
        order: order++,
        viewColumn: entry.panel.viewColumn || 1
      });
    }
    sessionStoreUpdate('claudeSessions', sessions);
  }

  for (const [, entry] of state.panels) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    killPtyProcess(entry.pty);
  }
  state.panels.clear();
}

module.exports = { activate, deactivate };
