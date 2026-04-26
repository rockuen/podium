// Phase 2a · v2.7.1 — CLI stdin payload builder.
//
// Given a body of text and a target agent, produce the exact byte sequence the
// CLI's readline loop expects for "paste these line(s) and submit."
//
// Why this is not trivial
// -----------------------
// Claude CLI on Windows enables win32-input-mode (CSI ?9001h) as soon as it
// detects it's running under ConPTY. In that mode its Ink readline no longer
// interprets a bare CR (\r) as submit — it expects the full Win32 KEY_EVENT
// ANSI encoding for each keystroke. The xterm.js webview already produces
// these sequences for user keyboard input. But when *we* inject text from the
// extension via `pty.write(...)`, those bytes go straight into the ConPTY
// stream and bypass xterm.js — so we need to emit KEY_EVENT sequences
// ourselves.
//
// Legacy context (pre-v2.7): v2.6.24 solved this by routing injections through
// `psmux send-keys -l`, which delivers raw bytes including embedded KEY_EVENT
// sequences, plus a terminal `Enter` token that psmux re-encodes per target
// terminal mode. v2.7 removes psmux, so we do the encoding ourselves and write
// directly through node-pty.
//
// Key facts:
//   - Win32 KEY_EVENT format:  ESC '[' vk ';' sc ';' uc ';' kd ';' cs ';' rc '_'
//   - Enter keydown/up:        vk=13 (VK_RETURN), sc=28, uc=13 (CR), cs=0
//   - Shift+Enter keydown/up:  same but uc=10 (LF), cs=16 (VK_SHIFT)
//   - Codex / Gemini CLIs do NOT enable win32-input-mode → bare CR / LF OK.
//
// POSIX platforms: node-pty spawns a real PTY; Claude's readline accepts
// `\r` as submit there because win32-input-mode is Windows-only. So the
// KEY_EVENT dance is Windows-and-Claude only.

import type { IPty } from 'node-pty';
import type { AgentKind } from './agentSpawn';

const ESC = '\x1b';

/** Win32-input-mode Enter (submit) — keydown + keyup pair. */
const WIN32_ENTER_SUBMIT =
  `${ESC}[13;28;13;1;0;1_` + // keydown: vk=13, sc=28, uc=13 (CR), kd=1, cs=0 (no mod), rc=1
  `${ESC}[13;28;13;0;0;1_`;  // keyup

/** Win32-input-mode Shift+Enter (newline in buffer, no submit). */
const WIN32_SHIFT_ENTER =
  `${ESC}[13;28;10;1;16;1_` + // keydown: uc=10 (LF), cs=16 (SHIFT)
  `${ESC}[13;28;10;0;16;1_`;  // keyup

export interface BuildPayloadOptions {
  agent: AgentKind;
  /** Override for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * Return true when the given agent + platform pair requires Win32 KEY_EVENT
 * encoding rather than bare CR/LF.
 *
 * History: v0.11.2 mid-cycle promoted darwin to the KEY_EVENT path on a
 * (broken) hypothesis that Claude Code v2.1+ activated win32-input-mode on
 * macOS too. Field testing 2026-04-25 falsified that — Mac+Claude actually
 * accepts bare CR as submit and SILENTLY DROPS the KEY_EVENT byte stream
 * (treats it as a no-op ANSI escape), which is why textarea-Send showed up
 * as "text arrived but Enter never fired" while xterm.js direct \r worked
 * fine. v0.11.2 final reverts darwin to the POSIX bare-CR path. The race
 * fix that lives in autoSend.js (writePtyChunked + setTimeout submit) stays
 * — that addresses a separate "single pty.write of body+\r flushes only the
 * body" race observed even on POSIX.
 */
export function needsWin32KeyEvents(opts: BuildPayloadOptions): boolean {
  if (opts.agent !== 'claude') return false;
  const plat = opts.platform ?? process.platform;
  return plat === 'win32';
}

/**
 * Build the byte sequence that, when written to a pty, types the given text
 * into the CLI's input buffer and submits it. Supports multi-line bodies:
 * embedded `\n` or `\r\n` are converted to the newline-in-buffer sequence
 * appropriate for the target, and a final submit is appended.
 */
export function buildSubmitPayload(body: string, opts: BuildPayloadOptions): string {
  const trimmed = String(body).replace(/[\r\n]+$/g, '');
  const lines = trimmed.split(/\r?\n/);

  if (needsWin32KeyEvents(opts)) {
    return lines.join(WIN32_SHIFT_ENTER) + WIN32_ENTER_SUBMIT;
  }
  // POSIX + non-Claude CLIs: readlines accept raw LF for newline-in-buffer
  // and raw CR for submit.
  return lines.join('\n') + '\r';
}

/** Low-level helper: write the built payload to a pty. Wraps errors. */
export function submitToPty(
  pty: Pick<IPty, 'write'>,
  body: string,
  opts: BuildPayloadOptions,
): { ok: true } | { ok: false; error: string } {
  try {
    pty.write(buildSubmitPayload(body, opts));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Variant of `buildSubmitPayload` that returns the body and the submit key
 * as separate strings. Callers that suffer intermittent "text arrived but
 * Enter didn't fire" on Windows+Claude (observed with worker-2 on large
 * UTF-8 payloads in v2.7.12) can write the body first, pause one macrotask,
 * then write the submit sequence — giving ConPTY time to flush the body
 * bytes through win32-input-mode before the Enter KEY_EVENT arrives.
 *
 * On POSIX or non-Claude agents there is no observed race, so `submit` is
 * the single `\r` byte and callers can write `body + submit` back-to-back
 * if they prefer. The split API keeps the code path uniform.
 */
export interface SubmitPayloadParts {
  /** Every keystroke except the final submit (includes newline-in-buffer sequences). */
  body: string;
  /** The submit sequence — Win32 Enter KEY_EVENT pair on Windows+Claude, a bare `\r` elsewhere. */
  submit: string;
}

export function splitSubmitPayload(body: string, opts: BuildPayloadOptions): SubmitPayloadParts {
  const trimmed = String(body).replace(/[\r\n]+$/g, '');
  const lines = trimmed.split(/\r?\n/);

  if (needsWin32KeyEvents(opts)) {
    return {
      body: lines.join(WIN32_SHIFT_ENTER),
      submit: WIN32_ENTER_SUBMIT,
    };
  }
  return {
    body: lines.join('\n'),
    submit: '\r',
  };
}

export const __testing = {
  WIN32_ENTER_SUBMIT,
  WIN32_SHIFT_ENTER,
};
