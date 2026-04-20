// @module pty/autoSend — programmatic slash-command / text submission helper.
//
// Why this exists (v2.6.18): Claude CLI enables win32-input-mode
// (CSI ?9001h) when it detects the launcher's ConPTY. In that mode, key events
// coming from xterm.js onData are already encoded into the win32 KEY_EVENT ANSI
// sequence that Claude Ink understands as a real "Enter pressed" event.
//
// BUT — a raw `pty.write('\\r')` from the extension side bypasses xterm.js and
// sends a literal CR byte into tmux/psmux. Inside a tmux-wrapped (Podium-ready)
// session, tmux does NOT re-encode that CR into the win32 key-event form, so
// Claude Ink falls back to treating it as a literal newline (equivalent to
// Shift+Enter) instead of a submit. This made `/effort max` auto-send, custom
// buttons, the queue runner, and toolbar `/compact`·`/clear` all stall on the
// first Enter in Podium-ready sessions.
//
// The fix: route programmatic sends through `tmux send-keys` — tmux parses the
// `Enter` token itself and delivers whatever key-event format the inner pane
// expects, so Claude Ink receives a proper submit. Non-Podium (direct-spawn)
// sessions keep using pty.write — that path was never broken.

const { execFile } = require('child_process');
const { findMuxBinary } = require('./tmuxWrap');

// Route a slash command / text + Enter to a session.
// - podiumReady (tmux-wrapped) sessions → psmux/tmux send-keys (Enter token)
//   to survive win32-input-mode encoding.
// - regular sessions → pty.write(text + '\r').
// Falls back to pty.write on send-keys failure so we never swallow the send.
function autoSendToEntry(entry, text) {
  if (!entry || !entry.pty) return;
  if (text == null) return;
  // Strip any trailing CR/LF — this helper is responsible for appending Enter.
  let body = String(text).replace(/[\r\n]+$/, '');

  const podiumReady = !!(entry.podiumReady && entry.tmuxSession);
  if (!podiumReady) {
    try { entry.pty.write(body + '\r'); } catch (e) {
      console.warn('[auto-send] pty.write failed:', e && e.message);
    }
    return;
  }

  // Podium-ready: drive the leader via send-keys so tmux/psmux translates the
  // Enter token into the win32 key-event form that Claude Ink expects.
  // On Windows this resolves to psmux; elsewhere tmux. `findMuxBinary` returns
  // an absolute path so node's execFile doesn't hit PATH-resolution issues.
  const muxBin = findMuxBinary(process.platform === 'win32' ? 'psmux' : 'tmux',
    process.platform === 'win32' ? 'tmux' : null);
  const target = entry.tmuxSession + ':0';
  const fallback = () => {
    try { entry.pty.write(body + '\r'); } catch (e) {
      console.warn('[auto-send] pty.write fallback failed:', e && e.message);
    }
  };
  if (!muxBin) {
    console.warn('[auto-send] mux binary not found; falling back to pty.write for', target);
    fallback();
    return;
  }
  // Two separate send-keys calls: (1) the literal text, (2) the Enter token.
  // Keeping text and `Enter` in separate argv entries avoids any shell quoting
  // issues — psmux's send-keys treats non-key-token strings as type-literals.
  execFile(muxBin, ['send-keys', '-t', target, body], { windowsHide: true }, (err) => {
    if (err) {
      console.warn('[auto-send] send-keys (text) failed, falling back:', err && err.message);
      fallback();
      return;
    }
    execFile(muxBin, ['send-keys', '-t', target, 'Enter'], { windowsHide: true }, (err2) => {
      if (err2) {
        console.warn('[auto-send] send-keys (Enter) failed, falling back:', err2 && err2.message);
        // Text already landed via send-keys, so just send a raw CR as a best
        // effort. This still won't submit under win32-input-mode, but at least
        // the user can hit Enter manually.
        try { entry.pty.write('\r'); } catch (_) {}
      }
    });
  });
}

module.exports = { autoSendToEntry };
