// @module pty/autoSend — programmatic slash-command / text submission helper.
//
// Why this exists (v2.6.18): Claude CLI enables win32-input-mode
// (CSI ?9001h) when it detects the launcher's ConPTY. In that mode, key events
// coming from xterm.js onData are already encoded into the win32 KEY_EVENT ANSI
// sequence that Claude Ink understands as a real "Enter pressed" event.
//
// A raw `pty.write('\\r')` from the extension side bypasses xterm.js and
// sends a literal CR byte into tmux/psmux. Inside a tmux-wrapped (Podium-ready)
// session, tmux does NOT re-encode that CR into the win32 key-event form, so
// Claude Ink falls back to treating it as a literal newline (equivalent to
// Shift+Enter) instead of a submit. The fix: route programmatic sends through
// `tmux send-keys` — tmux parses the `Enter` token itself and delivers
// whatever key-event format the inner pane expects.
//
// Multi-line send history (Podium-ready path):
// - v2.6.20  bracketed paste injection (\x1b[200~...\x1b[201~).
//            Claude readline buffered the start marker as data when
//            CSI ?2004h hadn't been enabled; pane locked up. ABANDONED.
// - v2.6.21  psmux load-buffer + paste-buffer -p. psmux escaped every LF
//            into a literal "\n" two-character sequence. ABANDONED.
// - v2.6.22  per-line send-keys + S-Enter token. psmux doesn't recognize
//            S-Enter; separator vanished and lines ran together. ABANDONED.
// - v2.6.23  single send-keys -l with the whole body. Raw LF bytes were
//            treated by Claude readline as submit (same as CR), so only the
//            first line was sent. ABANDONED.
// - v2.6.24 (current): Win32-input-mode Shift+Enter KEY_EVENT ANSI sequence
//            injected between lines. Format per MS ConPTY spec:
//              \x1b[<vk>;<sc>;<uc>;<kd>;<cs>;<rc>_
//            Enter: vk=13, sc=28; Shift modifier: cs=16.
//            Sending the down+up pair makes Claude readline see a real
//            Shift+Enter key event — newline-in-buffer, not submit. Bare
//            Enter at the end submits.
//
// Non-Podium multi-line sends are still a known gap — pty.write + CR is
// kept to avoid the v2.6.20-style lockup.

const { execFile } = require('child_process');
const { findMuxBinary } = require('./tmuxWrap');

// Win32-input-mode Shift+Enter key event (down + up). See MS ConPTY spec:
// https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md
const SHIFT_ENTER_KEY_EVENT =
  '\x1b[13;28;10;1;16;1_' +   // keydown: vk=13 (VK_RETURN), sc=28, uc=10 (LF), kd=1, cs=16 (SHIFT), rc=1
  '\x1b[13;28;10;0;16;1_';    // keyup:   same with kd=0

function autoSendToEntry(entry, text) {
  if (!entry || !entry.pty) return;
  if (text == null) return;
  // Strip any trailing CR/LF — this helper is responsible for appending Enter.
  let body = String(text).replace(/[\r\n]+$/, '');
  const multiline = body.includes('\n') || body.includes('\r');

  const podiumReady = !!(entry.podiumReady && entry.tmuxSession);
  if (!podiumReady) {
    try { entry.pty.write(body + '\r'); } catch (e) {
      console.warn('[auto-send] pty.write failed:', e && e.message);
    }
    return;
  }

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

  // Payload: lines joined by Win32 Shift+Enter key events. Single-line bodies
  // produce no SHIFT_ENTER insertions (lines.length === 1). `-l` keeps psmux
  // from parsing embedded ESC sequences as key names — it types every byte.
  const lines = body.split(/\r?\n/);
  const payload = lines.join(SHIFT_ENTER_KEY_EVENT);

  execFile(muxBin, ['send-keys', '-l', '-t', target, payload], { windowsHide: true }, (err) => {
    if (err) {
      console.warn('[auto-send] send-keys -l failed, falling back:', err && err.message);
      fallback();
      return;
    }
    execFile(muxBin, ['send-keys', '-t', target, 'Enter'], { windowsHide: true }, (err2) => {
      if (err2) {
        console.warn('[auto-send] submit Enter failed:', err2 && err2.message);
        try { entry.pty.write('\r'); } catch (_) {}
      }
    });
  });
}

module.exports = { autoSendToEntry };
