import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { stripAnsi, stripAnsiLines } from '../../src/orchestration/core/ansi';

test('ansi: strips SGR color codes', () => {
  const red = '\x1b[31mERROR\x1b[0m';
  assert.equal(stripAnsi(red), 'ERROR');
});

test('ansi: erase-in-display is dropped; cursor position converts to newline', () => {
  // ESC[2J (erase in display) — dropped.
  // ESC[5;10H (cursor absolute position) — v2.7.7 converts to \n so row
  // boundaries survive stripping.
  const s = 'before\x1b[2Jafter\x1b[5;10H!';
  assert.equal(stripAnsi(s), 'beforeafter\n!');
});

test('ansi: cursor home ESC[H → newline (v2.7.7)', () => {
  const s = 'a\x1b[Hb';
  assert.equal(stripAnsi(s), 'a\nb');
});

test('ansi: cursor forward ESC[nC → N spaces (v2.7.7)', () => {
  // Default count = 1.
  assert.equal(stripAnsi('a\x1b[Cb'), 'a b');
  // Explicit count.
  assert.equal(stripAnsi('a\x1b[3Cb'), 'a   b');
  // Runaway values are capped so a malicious stream cannot balloon memory.
  const big = stripAnsi('a\x1b[9999Cb');
  assert.ok(big.length < 250, 'cursor-forward spaces are capped');
  assert.ok(big.startsWith('a '));
  assert.ok(big.endsWith(' b'));
});

test('ansi: cursor down / next-line → newline (v2.7.7)', () => {
  assert.equal(stripAnsi('x\x1b[2By'), 'x\ny');
  assert.equal(stripAnsi('x\x1b[Ey'), 'x\ny');
});

test('ansi: cursor position variants → newline (v2.7.7)', () => {
  assert.equal(stripAnsi('row1\x1b[5Hrow5'), 'row1\nrow5');
  assert.equal(stripAnsi('row1\x1b[5;1Hrow5'), 'row1\nrow5');
});

test('ansi: strips OSC title sequences (BEL and ST terminated)', () => {
  const belTerm = '\x1b]0;window title\x07content';
  const stTerm = '\x1b]0;window title\x1b\\content';
  assert.equal(stripAnsi(belTerm), 'content');
  assert.equal(stripAnsi(stTerm), 'content');
});

test('ansi: strips DEC private mode set/reset', () => {
  const s = '\x1b[?25lhidden cursor\x1b[?25h';
  assert.equal(stripAnsi(s), 'hidden cursor');
});

test('ansi: alt-screen toggles drop; embedded ESC[H still converts to newline', () => {
  const s = '\x1b[?1049h\x1b[Hhello\x1b[?1049l';
  // ?1049h / ?1049l are DEC private-mode CSI — dropped.
  // ESC[H is cursor home — v2.7.7 converts to \n (leading \n here).
  assert.equal(stripAnsi(s), '\nhello');
});

test('ansi: keeps TAB / CR / LF', () => {
  const s = 'a\tb\r\nc\nd';
  assert.equal(stripAnsi(s), 'a\tb\r\nc\nd');
});

test('ansi: drops C0 controls other than TAB/CR/LF', () => {
  const s = 'a\x07b\x00c\x08d';
  assert.equal(stripAnsi(s), 'abcd');
});

test('ansi: strips 2-byte ESC charset designators', () => {
  const s = '\x1b(B\x1b)0hello';
  assert.equal(stripAnsi(s), 'hello');
});

test('ansi: strips solo ESC commands (ESC =, ESC >, ESC 7, ESC 8)', () => {
  const s = '\x1b=\x1b7before\x1b8\x1b>after';
  assert.equal(stripAnsi(s), 'beforeafter');
});

test('ansi: stripAnsiLines preserves line structure', () => {
  const s = '\x1b[31mline1\x1b[0m\nline2  \r\nline3';
  const lines = stripAnsiLines(s);
  assert.deepEqual(lines, ['line1', 'line2', 'line3']);
});

test('ansi: realistic claude-ish box row round-trip keeps glyphs', () => {
  const s = '\x1b[38;2;255;255;255m│ > hello world\x1b[0m';
  assert.equal(stripAnsi(s), '│ > hello world');
});

test('ansi: empty/undefined input returns empty string', () => {
  assert.equal(stripAnsi(''), '');
  assert.equal(stripAnsi(undefined as unknown as string), '');
});

test('ansi: regression — Claude Ink compact form separates worker tokens (v2.7.7)', () => {
  // Simulates the 2026-04-21 worker-2 pollution case: Claude renders user's
  // two `@worker-N:` lines at different absolute rows via ESC[r;cH, then
  // drops a "thinking" indicator below via another absolute positioning.
  // After v2.7.7's stripAnsi, the parser sees a clean \n between them.
  const raw =
    '\x1b[5;3H@worker-1: first task' +
    '\x1b[6;3H@worker-2: second task' +
    '\x1b[7;3H*Manifesting…';
  const stripped = stripAnsi(raw);
  const lines = stripped.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(lines, [
    '@worker-1: first task',
    '@worker-2: second task',
    '*Manifesting…',
  ]);
});

test('ansi: regression — cursor-forward between words preserves spaces (v2.7.7)', () => {
  // Observed 2026-04-21: Claude Ink uses ESC[nC between Korean words for
  // visual spacing. Without conversion, stripAnsi collapsed them into one
  // run-on string. Now N spaces are emitted.
  const raw = '1부터\x1b[C5까지\x1b[C숫자';
  assert.equal(stripAnsi(raw), '1부터 5까지 숫자');
});
