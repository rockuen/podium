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
// - v2.6.24: Win32-input-mode Shift+Enter KEY_EVENT ANSI sequence injected
//            between lines. Format per MS ConPTY spec:
//              \x1b[<vk>;<sc>;<uc>;<kd>;<cs>;<rc>_
//            Enter: vk=13, sc=28; Shift modifier: cs=16.
//            Sending the down+up pair makes Claude readline see a real
//            Shift+Enter key event — newline-in-buffer, not submit. Bare
//            Enter at the end submits.
// - v0.11.2: Mac added to the KEY_EVENT path. Claude Code v2.1+ activates
//            win32-input-mode on macOS too — bare \r becomes Shift+Enter and
//            leaves the directive un-submitted (leader hangs in Sautéed).
//            This helper now uses KEY_EVENT on darwin + win32, and the
//            v2.6.24-era "non-Podium multi-line" gap is closed by joining
//            embedded newlines with SHIFT_ENTER on those platforms.

const ESC = '\x1b';
// Win32-input-mode KEY_EVENT pairs, mirrored byte-for-byte from
// src/orchestration/core/cliInput.ts. This file is plain CommonJS, runs
// alongside the extension host without going through the TS build, but the
// sequences MUST stay byte-identical to cliInput. cliInput.test.ts covers the
// canonical encoding sanity case.
const WIN32_ENTER_SUBMIT =
  ESC + '[13;28;13;1;0;1_' + // keydown: vk=13, sc=28, uc=13 (CR), kd=1, cs=0
  ESC + '[13;28;13;0;0;1_';  // keyup
const WIN32_SHIFT_ENTER =
  ESC + '[13;28;10;1;16;1_' + // keydown: uc=10 (LF), cs=16 (SHIFT)
  ESC + '[13;28;10;0;16;1_';  // keyup

/**
 * Whether this process needs win32-input-mode KEY_EVENT encoding when writing
 * to a Claude PTY. Mirrors `needsWin32KeyEvents` in cliInput.ts.
 *
 * The legacy chat panel always spawns the Claude CLI, so we don't need an
 * agent kind on `entry`. If we ever wire codex / gemini into the legacy
 * panel, gate on `entry.agent === 'claude'` here.
 */
function needsWin32KeyEvents() {
  const plat = process.platform;
  return plat === 'win32' || plat === 'darwin';
}

function autoSendToEntry(entry, text) {
  if (!entry || !entry.pty) return;
  if (text == null) return;
  // Strip any trailing CR/LF — this helper is responsible for appending Enter.
  const body = String(text).replace(/[\r\n]+$/, '');
  try {
    let payload;
    if (needsWin32KeyEvents()) {
      const lines = body.split(/\r?\n/);
      payload = lines.join(WIN32_SHIFT_ENTER) + WIN32_ENTER_SUBMIT;
    } else {
      payload = body + '\r';
    }
    entry.pty.write(payload);
  } catch (e) {
    console.warn('[auto-send] pty.write failed:', e && e.message);
  }
}

module.exports = {
  autoSendToEntry,
  // Exported for unit tests / inspection only.
  __testing: { WIN32_ENTER_SUBMIT, WIN32_SHIFT_ENTER, needsWin32KeyEvents },
};
