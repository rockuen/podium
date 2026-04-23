import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { IdleDetector } from '../../src/orchestration/core/idleDetector';

function mkClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test('idle: starts not idle (no output seen yet)', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 500 });
  assert.equal(d.isIdle, false);
});

test('idle: silence alone is not enough — need prompt pattern too', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 500 });
  d.feed('streaming response continues...\n');
  c.advance(2000);
  assert.equal(d.isIdle, false);
});

test('idle: claude box + silence → idle (legacy boxed UI)', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 500 });
  d.feed('╭──────────────────╮\n│ >                │\n╰──────────────────╯\n');
  c.advance(600);
  assert.equal(d.isIdle, true);
});

test('idle: claude v2.1+ plain `>` prompt + silence → idle', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 500 });
  // Observed v2.1.116 idle footprint: bare `>` row, then OMC status line,
  // then bypass hint.
  d.feed('>\n[OMC#4.12.0] | 5h:28%(2h32m) wk:83%(2d15h) | session:0m | ctx:4%\n⏵⏵ bypass permissions on (shift+tab to cycle)\n');
  c.advance(600);
  assert.equal(d.isIdle, true);
});

test('idle: claude v2.1+ OMC status line alone counts as prompt evidence', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 500 });
  d.feed('[OMC#4.12.0] | session:0m | ctx:4%\n');
  c.advance(600);
  assert.equal(d.isIdle, true);
});

test('idle: claude prompt without silence → still busy', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 500 });
  d.feed('╰───╯\n');
  // 200ms < silenceMs (500)
  c.advance(200);
  assert.equal(d.isIdle, false);
});

test('idle: codex `user>` prompt + silence → idle', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'codex', now: c.now, silenceMs: 300 });
  d.feed('tool ran ok\nuser>\n');
  c.advance(400);
  assert.equal(d.isIdle, true);
});

test('idle: gemini `>` prompt + silence → idle', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'gemini', now: c.now, silenceMs: 300 });
  d.feed('Here you go.\n> \n');
  c.advance(400);
  assert.equal(d.isIdle, true);
});

test('idle: ignores prompt-lookalike text in the middle of long output', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'codex', now: c.now, silenceMs: 300 });
  d.feed('> quoting text\ncontinued output\n');
  c.advance(400);
  // No trailing prompt line → not idle.
  assert.equal(d.isIdle, false);
});

test('idle: new output resets silence window', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 500 });
  d.feed('╰──╯\n');
  c.advance(400);
  d.feed('more output streaming in\n');
  c.advance(400);
  // Silence since *last* feed is 400ms < 500ms.
  assert.equal(d.isIdle, false);
});

test('idle: markBusy clears state', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 500 });
  d.feed('╰──╯\n');
  c.advance(600);
  assert.equal(d.isIdle, true);
  d.markBusy();
  c.advance(400);
  assert.equal(d.isIdle, false);
});

test('idle: strips ANSI before pattern match', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 300 });
  // Pure ANSI noise around the bottom border.
  d.feed('\x1b[38;2;200;100;100m╰─────╯\x1b[0m\n');
  c.advance(400);
  assert.equal(d.isIdle, true);
});

test('idle: OMC status-line refreshes do NOT reset silence timer (v2.7.4 fix)', () => {
  // Reproduces the worker-1 stuck-busy symptom: Claude Ink UI repaints its
  // status row every few seconds. Without cosmetic filtering, every refresh
  // would reset lastOutputAt and the worker never reaches silence.
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 500 });
  // Initial spawn output — real content.
  d.feed('Claude Code v2.1.116\nOpus 4.7\n');
  c.advance(300);
  // 300ms in — status refresh arrives. Should NOT reset silence.
  d.feed('[OMC#4.12.0] | 5h:28%(2h32m) | session:0m | ctx:4%\n');
  c.advance(300);
  // Total 600ms since real content, despite the status refresh in the middle.
  assert.equal(d.isIdle, true);
});

test('idle: real model output DOES reset silence timer (not a regression)', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 500 });
  d.feed('> \n');
  c.advance(300);
  d.feed('actual prose from the model\n');
  c.advance(300);
  // Real content at t=300 + 300ms elapsed = not yet silent (only 300 of 500).
  assert.equal(d.isIdle, false);
});

test('idle: msSinceOutput reflects wall clock', () => {
  const c = mkClock(0);
  const d = new IdleDetector({ agent: 'claude', now: c.now });
  d.feed('x');
  c.advance(1234);
  assert.equal(d.msSinceOutput, 1234);
});

test('idle v0.3.5: Ink alt-screen compact repaint is cosmetic (status + bypass concatenated)', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 500 });
  d.feed('Claude Code v2.1.118\n> \n');
  c.advance(600);
  assert.equal(d.isIdle, true, 'should be idle after boot + silence');
  d.feed('>                                [OMC#4.12.0] | 5h:51%(0h16m) | ctx:4%    ⏵⏵ bypass permissions on (shift+tab to cycle)\n');
  c.advance(100);
  assert.equal(d.isIdle, true, 'Ink compact repaint must not reset silence');
});

test('idle v0.3.5: prompt + OMC status concatenated (no bypass) is cosmetic', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 500 });
  d.feed('Claude Code v2.1.118\n> \n');
  c.advance(600);
  assert.equal(d.isIdle, true);
  d.feed('>      [OMC#4.12.0] | session:0m | ctx:0%\n');
  c.advance(50);
  assert.equal(d.isIdle, true, 'compact prompt+status repaint should be cosmetic');
});

test('idle v0.3.8: Ink compact repaint also satisfies hasPromptPattern', () => {
  // Regression for v0.3.7 field log: silence reached 52s but isIdle stayed
  // false because the only content in rollingTail was an Ink compact
  // repaint (prompt + status + bypass concatenated on one line) and none
  // of the anchored PROMPT_PATTERNS matched. hasPromptPattern needs the
  // contains-form too.
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 500 });
  // Feed ONLY the compact repaint — no preceding boxed/plain prompt.
  d.feed('>                  [OMC#4.12.0] | 5h:11%(4h31m) wk:39%(5d2h) | session:0m | ctx:0%    ⏵⏵ bypass permissions on (shift+tab to cycle)\n');
  c.advance(600);
  assert.equal(d.isIdle, true, 'compact repaint alone should satisfy hasPromptPattern');
});

test('idle v0.3.8: OMC status line as pure contains (no leading prompt) satisfies prompt', () => {
  const c = mkClock(1000);
  const d = new IdleDetector({ agent: 'claude', now: c.now, silenceMs: 500 });
  // Just the status row on its own (common Ink repaint form).
  d.feed('some prefix text   [OMC#4.12.0] | session:1m | ctx:4%\n');
  c.advance(600);
  assert.equal(d.isIdle, true, 'OMC status anywhere on a line should count as prompt');
});
