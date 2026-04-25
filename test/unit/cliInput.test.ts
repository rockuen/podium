import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildSubmitPayload,
  needsWin32KeyEvents,
  submitToPty,
  __testing,
} from '../../src/orchestration/core/cliInput';

const { WIN32_ENTER_SUBMIT, WIN32_SHIFT_ENTER } = __testing;

test('cliInput: needsWin32KeyEvents — claude on win32 + darwin (v0.11.2)', () => {
  // v0.11.2 — Field evidence (2026-04-25, Antigravity + Claude Code v2.1.119):
  // Claude Code v2.1+ activates win32-input-mode on macOS as well. The
  // "win32-only" assumption from v2.7.x silently broke Mac Enter submit
  // (pty.write('\r') was reinterpreted as Shift+Enter, leader stuck Sautéed
  // forever). darwin must take the KEY_EVENT path, same as win32.
  assert.equal(needsWin32KeyEvents({ agent: 'claude', platform: 'win32' }), true);
  assert.equal(needsWin32KeyEvents({ agent: 'claude', platform: 'darwin' }), true);
  // Linux retains the POSIX bare-CR path until field evidence proves otherwise.
  assert.equal(needsWin32KeyEvents({ agent: 'claude', platform: 'linux' }), false);
  // Non-Claude CLIs do not enable win32-input-mode on any platform.
  assert.equal(needsWin32KeyEvents({ agent: 'codex', platform: 'win32' }), false);
  assert.equal(needsWin32KeyEvents({ agent: 'codex', platform: 'darwin' }), false);
  assert.equal(needsWin32KeyEvents({ agent: 'gemini', platform: 'win32' }), false);
  assert.equal(needsWin32KeyEvents({ agent: 'gemini', platform: 'darwin' }), false);
});

test('cliInput: Linux claude single-line — plain CR suffix (POSIX path retained)', () => {
  const p = buildSubmitPayload('hello', { agent: 'claude', platform: 'linux' });
  assert.equal(p, 'hello\r');
});

test('cliInput: Linux claude multi-line — LF separators + CR submit', () => {
  const p = buildSubmitPayload('line one\nline two', { agent: 'claude', platform: 'linux' });
  assert.equal(p, 'line one\nline two\r');
});

test('cliInput: Linux strips trailing CR/LF from body (no double submit)', () => {
  const p = buildSubmitPayload('hello\n\n\r', { agent: 'claude', platform: 'linux' });
  assert.equal(p, 'hello\r');
});

test('cliInput: Windows claude single-line — KEY_EVENT submit, no SHIFT_ENTER', () => {
  const p = buildSubmitPayload('hello', { agent: 'claude', platform: 'win32' });
  assert.equal(p, 'hello' + WIN32_ENTER_SUBMIT);
  assert.ok(!p.includes(WIN32_SHIFT_ENTER));
});

test('cliInput: Windows claude multi-line — SHIFT_ENTER between, ENTER submit at end', () => {
  const p = buildSubmitPayload('a\nb\nc', { agent: 'claude', platform: 'win32' });
  assert.equal(p, 'a' + WIN32_SHIFT_ENTER + 'b' + WIN32_SHIFT_ENTER + 'c' + WIN32_ENTER_SUBMIT);
});

test('cliInput: Windows codex/gemini — raw LF/CR, no KEY_EVENT', () => {
  const p1 = buildSubmitPayload('hi\nthere', { agent: 'codex', platform: 'win32' });
  assert.equal(p1, 'hi\nthere\r');
  const p2 = buildSubmitPayload('hi', { agent: 'gemini', platform: 'win32' });
  assert.equal(p2, 'hi\r');
});

test('cliInput v0.11.2: macOS claude single-line — KEY_EVENT submit (Mac fix)', () => {
  // Mac+Claude must take the same KEY_EVENT path as Windows+Claude. Bare \r
  // gets reinterpreted as Shift+Enter under Claude Code v2.1+ win32-input-mode
  // even on macOS, leaving the directive in the input buffer un-submitted.
  const p = buildSubmitPayload('hello', { agent: 'claude', platform: 'darwin' });
  assert.equal(p, 'hello' + WIN32_ENTER_SUBMIT);
  assert.ok(!p.includes(WIN32_SHIFT_ENTER));
});

test('cliInput v0.11.2: macOS claude multi-line — SHIFT_ENTER between, ENTER submit at end', () => {
  const p = buildSubmitPayload('a\nb\nc', { agent: 'claude', platform: 'darwin' });
  assert.equal(p, 'a' + WIN32_SHIFT_ENTER + 'b' + WIN32_SHIFT_ENTER + 'c' + WIN32_ENTER_SUBMIT);
});

test('cliInput v0.11.2: macOS codex/gemini — bare CR (Mac fix is Claude-specific)', () => {
  // Codex / Gemini CLIs do not enable win32-input-mode anywhere. The Mac
  // KEY_EVENT promotion must remain Claude-scoped to avoid breaking other CLIs.
  const p1 = buildSubmitPayload('hi', { agent: 'codex', platform: 'darwin' });
  assert.equal(p1, 'hi\r');
  const p2 = buildSubmitPayload('hi\nthere', { agent: 'gemini', platform: 'darwin' });
  assert.equal(p2, 'hi\nthere\r');
});

test('cliInput v0.11.2: macOS claude CRLF bodies normalize to KEY_EVENT path', () => {
  const p = buildSubmitPayload('a\r\nb\r\nc', { agent: 'claude', platform: 'darwin' });
  assert.equal(p, 'a' + WIN32_SHIFT_ENTER + 'b' + WIN32_SHIFT_ENTER + 'c' + WIN32_ENTER_SUBMIT);
});

test('cliInput: Linux claude CRLF bodies normalize to LF joins', () => {
  const p = buildSubmitPayload('a\r\nb\r\nc', { agent: 'claude', platform: 'linux' });
  assert.equal(p, 'a\nb\nc\r');
});

test('cliInput: submitToPty Linux claude writes bare-CR payload', () => {
  const log: string[] = [];
  const fakePty = {
    write(d: string) {
      log.push(d);
    },
  };
  const r = submitToPty(fakePty, 'hello', { agent: 'claude', platform: 'linux' });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(log, ['hello\r']);
});

test('cliInput v0.11.2: submitToPty macOS claude writes KEY_EVENT payload', () => {
  const log: string[] = [];
  const fakePty = {
    write(d: string) {
      log.push(d);
    },
  };
  const r = submitToPty(fakePty, 'hello', { agent: 'claude', platform: 'darwin' });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(log, ['hello' + WIN32_ENTER_SUBMIT]);
});

test('cliInput: submitToPty captures thrown errors', () => {
  const fakePty = {
    write() {
      throw new Error('broken pipe');
    },
  };
  const r = submitToPty(fakePty, 'x', { agent: 'claude', platform: 'linux' });
  assert.deepEqual(r, { ok: false, error: 'broken pipe' });
});

test('cliInput: KEY_EVENT sequences match MS ConPTY spec (sanity)', () => {
  // vk=13, sc=28, repeat=1; uc=13 & cs=0 for submit; uc=10 & cs=16 for Shift+Enter
  assert.equal(WIN32_ENTER_SUBMIT, '\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_');
  assert.equal(WIN32_SHIFT_ENTER, '\x1b[13;28;10;1;16;1_\x1b[13;28;10;0;16;1_');
});
