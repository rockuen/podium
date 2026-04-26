import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildSubmitPayload,
  needsWin32KeyEvents,
  submitToPty,
  __testing,
} from '../../src/orchestration/core/cliInput';

const { WIN32_ENTER_SUBMIT, WIN32_SHIFT_ENTER } = __testing;

test('cliInput: needsWin32KeyEvents — claude on win32 only', () => {
  // v0.11.2 final — darwin REVERTED to the bare-CR POSIX path. A mid-cycle
  // hypothesis promoted darwin to the KEY_EVENT path on the assumption that
  // Claude Code v2.1+ activated win32-input-mode on macOS, but field testing
  // 2026-04-25 falsified that: Mac+Claude accepts bare \r as submit and
  // silently drops KEY_EVENT bytes (treats them as a no-op ANSI escape),
  // which is why textarea-Send under the broken hypothesis showed "text
  // arrived but Enter never fired" while xterm direct \r worked. The
  // race fix that does live in autoSend.js (writePtyChunked + setTimeout
  // submit) handles the separate body/submit flush race seen even on POSIX.
  assert.equal(needsWin32KeyEvents({ agent: 'claude', platform: 'win32' }), true);
  assert.equal(needsWin32KeyEvents({ agent: 'claude', platform: 'darwin' }), false);
  assert.equal(needsWin32KeyEvents({ agent: 'claude', platform: 'linux' }), false);
  assert.equal(needsWin32KeyEvents({ agent: 'codex', platform: 'win32' }), false);
  assert.equal(needsWin32KeyEvents({ agent: 'codex', platform: 'darwin' }), false);
  assert.equal(needsWin32KeyEvents({ agent: 'gemini', platform: 'win32' }), false);
  assert.equal(needsWin32KeyEvents({ agent: 'gemini', platform: 'darwin' }), false);
});

test('cliInput: POSIX claude single-line — plain CR suffix', () => {
  const p = buildSubmitPayload('hello', { agent: 'claude', platform: 'darwin' });
  assert.equal(p, 'hello\r');
});

test('cliInput: POSIX claude multi-line — LF separators + CR submit', () => {
  const p = buildSubmitPayload('line one\nline two', { agent: 'claude', platform: 'linux' });
  assert.equal(p, 'line one\nline two\r');
});

test('cliInput: POSIX strips trailing CR/LF from body (no double submit)', () => {
  const p = buildSubmitPayload('hello\n\n\r', { agent: 'claude', platform: 'darwin' });
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

test('cliInput: CRLF bodies normalized to LF joins', () => {
  const p = buildSubmitPayload('a\r\nb\r\nc', { agent: 'claude', platform: 'darwin' });
  assert.equal(p, 'a\nb\nc\r');
});

test('cliInput v0.11.2: macOS claude single-line uses bare CR (no KEY_EVENT)', () => {
  // Regression marker for the reverted hypothesis — explicitly assert that
  // Mac+Claude does NOT take the KEY_EVENT path. If a future patch promotes
  // darwin again, this test must change in lockstep with cliInput.ts and a
  // companion autoSend.js change.
  const p = buildSubmitPayload('hello', { agent: 'claude', platform: 'darwin' });
  assert.equal(p, 'hello\r');
  assert.ok(!p.includes(WIN32_ENTER_SUBMIT));
  assert.ok(!p.includes(WIN32_SHIFT_ENTER));
});

test('cliInput v0.11.2: macOS claude multi-line uses LF + CR (no KEY_EVENT)', () => {
  const p = buildSubmitPayload('a\nb\nc', { agent: 'claude', platform: 'darwin' });
  assert.equal(p, 'a\nb\nc\r');
  assert.ok(!p.includes(WIN32_SHIFT_ENTER));
});

test('cliInput v0.11.2: macOS codex/gemini bare CR (Mac path is uniform)', () => {
  const p1 = buildSubmitPayload('hi', { agent: 'codex', platform: 'darwin' });
  assert.equal(p1, 'hi\r');
  const p2 = buildSubmitPayload('hi\nthere', { agent: 'gemini', platform: 'darwin' });
  assert.equal(p2, 'hi\nthere\r');
});

test('cliInput: submitToPty writes payload and returns ok', () => {
  const log: string[] = [];
  const fakePty = {
    write(d: string) {
      log.push(d);
    },
  };
  const r = submitToPty(fakePty, 'hello', { agent: 'claude', platform: 'darwin' });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(log, ['hello\r']);
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

test('cliInput: KEY_EVENT sequences match MS ConPTY spec (sanity, retained from v2.7.x)', () => {
  // vk=13, sc=28, repeat=1; uc=13 & cs=0 for submit; uc=10 & cs=16 for Shift+Enter
  assert.equal(WIN32_ENTER_SUBMIT, '\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_');
  assert.equal(WIN32_SHIFT_ENTER, '\x1b[13;28;10;1;16;1_\x1b[13;28;10;0;16;1_');
});
