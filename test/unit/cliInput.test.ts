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
  assert.equal(needsWin32KeyEvents({ agent: 'claude', platform: 'win32' }), true);
  assert.equal(needsWin32KeyEvents({ agent: 'claude', platform: 'darwin' }), false);
  assert.equal(needsWin32KeyEvents({ agent: 'claude', platform: 'linux' }), false);
  assert.equal(needsWin32KeyEvents({ agent: 'codex', platform: 'win32' }), false);
  assert.equal(needsWin32KeyEvents({ agent: 'gemini', platform: 'win32' }), false);
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

test('cliInput: KEY_EVENT sequences match MS ConPTY spec (sanity)', () => {
  // vk=13, sc=28, repeat=1; uc=13 & cs=0 for submit; uc=10 & cs=16 for Shift+Enter
  assert.equal(WIN32_ENTER_SUBMIT, '\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_');
  assert.equal(WIN32_SHIFT_ENTER, '\x1b[13;28;10;1;16;1_\x1b[13;28;10;0;16;1_');
});
