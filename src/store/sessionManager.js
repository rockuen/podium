// @module store/sessionManager — save/restore open tabs across Reload Window.
// createPanel is injected as a callback to avoid circular imports with panel/ (Phase 6 target).

const state = require('../state');
const { sessionStoreGet, sessionStoreUpdate } = require('./sessionStore');

function saveSessions() {
  const sessions = [];
  let order = 0;
  for (const [, entry] of state.panels) {
    if (entry.pty) {
      sessions.push({
        title: entry.title,
        memo: entry.memo || '',
        cwd: entry.cwd,
        sessionId: entry.sessionId,
        order: order++,
        viewColumn: entry.panel.viewColumn || 1
      });
    }
  }
  sessionStoreUpdate('claudeSessions', sessions);

  // sessionId → title 매핑 저장 (사이드바 세션 목록용)
  const titleMap = sessionStoreGet('claudeSessionTitles', {});
  for (const s of sessions) {
    if (s.sessionId && s.title) {
      // 기본 탭 이름(Claude Code, Claude Code (N))이면 기존 매핑 유지 (덮어쓰기 금지)
      if (/^Claude Code( \(\d+\))?$/.test(s.title)) continue;
      titleMap[s.sessionId] = s.title;
    }
  }
  sessionStoreUpdate('claudeSessionTitles', titleMap);

  if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
}

// Called at end of activate(). Restores in saved order with 500ms stagger
// for correct viewColumn placement in split views.
function restoreSessions(onRestore) {
  const sessions = sessionStoreGet('claudeSessions', []);
  console.log('[Podium] restoreSessions called, found:', sessions.length, 'sessions');
  if (sessions.length === 0) return;

  // Clear immediately to avoid double-restore on activate re-entry
  sessionStoreUpdate('claudeSessions', []);

  const sorted = [...sessions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  sorted.forEach((session, i) => {
    setTimeout(() => {
      console.log('[Podium] Restoring session:', session.title, session.sessionId);
      onRestore(session);
    }, i * 500);
  });
}

module.exports = { saveSessions, restoreSessions };
