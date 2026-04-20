// @module store/sessionStore — JSON file-based persistence for session metadata.
// Location: <workspace>/.claude-launcher/sessions.json (workspace-scoped, not globalStorage).
// This choice enables cross-device sync via git/OneDrive on the workspace itself.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const SESSION_STORE_DIR = '.claude-launcher';
const SESSION_STORE_FILE = 'sessions.json';

function getSessionStorePath() {
  const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!wsFolder) return null;
  return path.join(wsFolder, SESSION_STORE_DIR, SESSION_STORE_FILE);
}

function sessionStoreGet(key, defaultValue) {
  const filePath = getSessionStorePath();
  if (!filePath || !fs.existsSync(filePath)) return defaultValue;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data[key] !== undefined ? data[key] : defaultValue;
  } catch (_) {
    return defaultValue;
  }
}

// Atomic write: write to .tmp.<pid>.<ts>, fsync, then rename over the target.
// Prevents partial-file corruption / cross-window race when multiple windows
// (or the same window racing with a previous flush) update the same key.
function sessionStoreUpdate(key, value) {
  const filePath = getSessionStorePath();
  if (!filePath) return;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let data = {};
  if (fs.existsSync(filePath)) {
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
  }
  data[key] = value;
  const json = JSON.stringify(data, null, 2);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, json, 0, 'utf8');
    try { fs.fsyncSync(fd); } catch (_) {}
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    throw e;
  }
}

// One-time migration from legacy workspaceState storage to sessions.json.
// Safe to call on every activate(); guarded by _migrated flag.
function migrateFromWorkspaceState(context) {
  const filePath = getSessionStorePath();
  if (!filePath) return;
  let existing = {};
  if (fs.existsSync(filePath)) {
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
    if (existing._migrated) return;
  }
  const keys = ['claudeSessions', 'claudeSessionTitles', 'claudeSavedSessions', 'claudeSessionGroups', 'claudeArchivedSessions'];
  let migrated = false;
  for (const key of keys) {
    const val = context.workspaceState.get(key);
    if (val !== undefined && existing[key] === undefined) {
      sessionStoreUpdate(key, val);
      migrated = true;
    }
  }
  if (migrated) {
    sessionStoreUpdate('_migrated', true);
    console.log('[Claude Launcher] Migrated workspaceState to sessions.json');
  }
}

// v2.6.12: List Podium-ready sessions for a given cwd. Orchestration
// (SpawnTeamPanel) calls this to populate its "Leader source" dropdown.
// Returns [{ sessionId, title, tmuxSession }] — empty when no match.
function listPodiumReadySessionsForCwd(cwd) {
  const podiumMap = sessionStoreGet('claudePodiumReadySessions', {});
  const titleMap = sessionStoreGet('claudeSessionTitles', {});
  // Active panel entries (in-memory only) are the authoritative cwd source.
  // Saved-to-disk entries survive reload but don't carry per-session cwd yet,
  // so we only match active ones here. Callers get a truthful "this cwd has
  // a live Podium-ready pane you can target" list.
  const state = require('../state');
  const out = [];
  for (const [, entry] of state.panels) {
    if (!entry.podiumReady || !entry.tmuxSession || !entry.sessionId) continue;
    if (cwd && entry.cwd && path.resolve(entry.cwd) !== path.resolve(cwd)) continue;
    out.push({
      sessionId: entry.sessionId,
      title: entry.title || titleMap[entry.sessionId] || 'Claude Code',
      tmuxSession: entry.tmuxSession,
      cwd: entry.cwd,
    });
    // Also confirm the persisted map knows about this one (durability probe).
    if (!podiumMap[entry.sessionId]) {
      podiumMap[entry.sessionId] = { tmuxSession: entry.tmuxSession };
    }
  }
  return out;
}

module.exports = {
  getSessionStorePath,
  sessionStoreGet,
  sessionStoreUpdate,
  migrateFromWorkspaceState,
  listPodiumReadySessionsForCwd,
};
