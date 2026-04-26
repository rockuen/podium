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
//
//            v0.11.2 ALSO splits body + submit across a setTimeout boundary
//            and routes through writePtyChunked. Field finding 2026-04-25:
//            even the textarea Send path (single Claude Code session, no
//            Podium team) intermittently dropped the submit — text arrived
//            in the input buffer but Enter never fired. Same race
//            cliInput.ts splitSubmitPayload documents (Windows v2.7.12 +
//            macOS v0.11.2): when body+submit go out as one pty.write,
//            ConPTY/PTY layer can flush only part before Claude Ink reads,
//            so the trailing Enter byte is absorbed by the wrong line of
//            the readline state machine. Splitting them with writePtyChunked
//            (per-entry serialization queue) + a small delay gives PTY time
//            to drain the body before submit arrives.

const vscode = require('vscode');
const { writePtyChunked } = require('./write');

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
  // v0.11.2 final — darwin reverted to bare CR. See cliInput.ts comment for
  // the "broken hypothesis" history. Mac+Claude accepts bare \r as submit
  // and silently drops KEY_EVENT bytes, so darwin must NOT take the KEY_EVENT
  // path. The race fix (writePtyChunked + setTimeout submit) below handles
  // the separate body/submit flush race that was the actual Mac symptom.
  return process.platform === 'win32';
}

// v0.11.2 — body→submit split delay. cliInput.ts splitSubmitPayload's macrotask
// hint generalized to ms because writePtyChunked is itself a 20ms-per-chunk
// pacer (queue-serialized), and a single setImmediate often returns before
// the body's last chunk has been drained. 30ms covers up to one chunk of
// body (256B headroom) before submit is queued. Tuned with cliInput.ts
// splitSubmitPayload caller in PodiumOrchestrator (which uses setTimeout(0)
// because that path's body is already chunked through panel.writeToPane).
const SUBMIT_DELAY_MS = 30;

/**
 * v0.11.2 — User-toggleable auto-submit setting.
 * When false (default), this helper writes the body to the terminal but skips
 * the trailing Enter — the user presses Enter inside the terminal to submit.
 * When true, the trailing submit byte is appended (race-safe: split + delay).
 *
 * Default false because v0.11.2 field testing showed Mac auto-submit is
 * unstable (Claude Code v2.1+ readline race) — making the user the explicit
 * trigger is currently more reliable than any in-process workaround.
 */
function isAutoSendEnabled() {
  try {
    const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
    return cfg.get('autoSendEnter', false) === true;
  } catch (_) {
    return false;
  }
}

function autoSendToEntry(entry, text) {
  if (!entry || !entry.pty) return;
  if (text == null) return;
  // Strip any trailing CR/LF — this helper is responsible for appending Enter.
  const body = String(text).replace(/[\r\n]+$/, '');
  try {
    const autoSubmit = isAutoSendEnabled();
    const submit = needsWin32KeyEvents() ? WIN32_ENTER_SUBMIT : '\r';
    const bodyPayload = needsWin32KeyEvents()
      ? body.split(/\r?\n/).join(WIN32_SHIFT_ENTER)
      : body;

    // autoSendEnter=false: body only, the user submits with Enter inside the
    // terminal. Empty body + autoSubmit=false is a no-op (nothing to insert,
    // no Enter to fire) — silently skip.
    if (!autoSubmit) {
      if (bodyPayload.length > 0) writePtyChunked(entry, bodyPayload);
      return;
    }

    if (bodyPayload.length > 0) {
      // Body first via writePtyChunked (per-entry queue + 256B chunks +
      // 20ms pacing). Submit follows after the queue has had time to drain
      // at least one chunk, preventing the v0.11.2 "text arrived, Enter
      // didn't fire" race.
      writePtyChunked(entry, bodyPayload);
      setTimeout(() => {
        if (entry.pty && !entry._disposed) {
          writePtyChunked(entry, submit);
        }
      }, SUBMIT_DELAY_MS);
    } else {
      // Empty body (used by webview Enter-intercept callers when they want
      // a bare submit). Single queued write — no race possible.
      writePtyChunked(entry, submit);
    }
  } catch (e) {
    console.warn('[auto-send] pty.write failed:', e && e.message);
  }
}

module.exports = {
  autoSendToEntry,
  // Exported for unit tests / inspection only.
  __testing: { WIN32_ENTER_SUBMIT, WIN32_SHIFT_ENTER, needsWin32KeyEvents },
};
