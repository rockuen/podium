import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { IdleDetector, isCosmeticLine, isInkNoise } from '../../src/orchestration/core/idleDetector';

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

// ─────────────────────────────────────────────────────────────────────
// v0.8.5 — isInkNoise sanitizer for the drop-file pipeline.
//
// Fixtures are taken verbatim from the 2026-04-24 field drops
// (worker-1-turn4-seq2.md, worker-2-turn6-seq2.md) — the lines the old
// filter let through and that turned a 200-byte real reply into a
// 16-37 KB spinner soup.
// ─────────────────────────────────────────────────────────────────────

test('sanitize: spinner glyph alone is noise', () => {
  assert.equal(isInkNoise('✻'), true);
  assert.equal(isInkNoise('  ✶  '), true);
  assert.equal(isInkNoise('✢'), true);
  assert.equal(isInkNoise('·'), true);
  assert.equal(isInkNoise('✽'), true);
});

test('sanitize: spinner + thinking verb fragments are noise', () => {
  assert.equal(isInkNoise('✶ C'), true);
  assert.equal(isInkNoise('✢    n  l'), true);
  assert.equal(isInkNoise('*      el in'), true);
  assert.equal(isInkNoise('✻         i  …'), true);
});

test('sanitize: thinking verb lines (Channelling / Pouncing / etc.) are noise', () => {
  assert.equal(isInkNoise('Channelling…'), true);
  assert.equal(isInkNoise('✻ Channelling… (3s · ↓ 74 tokens · thinking)'), true);
  assert.equal(isInkNoise('Pouncing…'), true);
  assert.equal(isInkNoise('* Pouncing…           8          thinking'), true);
  assert.equal(isInkNoise('Sautéed'), true);
  assert.equal(isInkNoise('Cooked for 53s'), true);
});

test('sanitize: timing / token status markers are noise', () => {
  assert.equal(isInkNoise(' (2s · thinking)'), true);
  assert.equal(isInkNoise('↓ 13 tokens · thinking)'), true);
  assert.equal(isInkNoise('↑ 6'), true);
  assert.equal(isInkNoise('  thinking'), true);
});

test('sanitize: box drawing and Claude logo are noise', () => {
  assert.equal(isInkNoise('───────────────────────────────'), true);
  assert.equal(isInkNoise(' ▐▛███▜▌   Claude Code v2.1.118'), true);
  assert.equal(isInkNoise('▝▜█████▛▘'), true);
  assert.equal(isInkNoise('  ▘▘ ▝▝'), true);
});

test('sanitize: tool-use chrome is noise', () => {
  assert.equal(isInkNoise('  ⎿  .omc/team/drops/to-worker-1-turn2-seq1.md'), true);
  assert.equal(isInkNoise('● Reading 1 file… (ctrl+o to expand)'), true);
  assert.equal(isInkNoise('Found 1 settings issue · /doctor for details'), true);
  assert.equal(isInkNoise('ctrl+g to edit in Notepad'), true);
});

test('sanitize: cursor-fragmented 1-3 letter scraps are noise', () => {
  // These are literally what Ink produces when drawing "Channelling…"
  // across cursor-positioned rows.
  assert.equal(isInkNoise('Po'), true);
  assert.equal(isInkNoise('u'), true);
  assert.equal(isInkNoise('ci'), true);
  assert.equal(isInkNoise('h n'), false); // has a space — not purely letters
});

test('sanitize: real assistant content passes through', () => {
  assert.equal(isInkNoise('@leader: 구현 완료. 5/5 테스트 통과.'), false);
  assert.equal(isInkNoise('function reverseString(str) {'), false);
  assert.equal(isInkNoise('  return Array.from(str).reverse().join("");'), false);
  assert.equal(isInkNoise('}'), false);
  assert.equal(isInkNoise('1. Intl.Segmenter 기반 grapheme 분할 ✓'), false);
  assert.equal(isInkNoise('apple'), false); // single-word response (5 chars, > 3 threshold)
});

test('sanitize: isCosmeticLine still narrow (does NOT catch Ink thinking)', () => {
  // Regression guard: we intentionally kept isCosmeticLine narrow so
  // IdleDetector.feed's silence timer logic is unchanged. If someone
  // accidentally widens it, this test flags it.
  assert.equal(isCosmeticLine('Channelling…'), false);
  assert.equal(isCosmeticLine('✻'), false);
});

// ─────────────────────────────────────────────────────────────────────
// v0.8.8 — verb additions from the 2026-04-23/24 field drops.
// Extracted with `grep -hoE '[A-Z][a-z]+…' drops/*.md | sort -u`.
// This block is the canonical release tracker: if Claude Code ships
// a new placeholder verb, add it here FIRST (it will fail), then add
// to THINKING_VERB_RE.
// ─────────────────────────────────────────────────────────────────────

test('sanitize v0.8.8: Cooking/Forming/Frosting/Swirling verbs are noise', () => {
  // All four appeared in worker-1-turn*-seq2.md / worker-2-turn*-seq2.md.
  // The 2026-04-24 retrospective flagged Frosting/Swirling specifically —
  // Cooking/Forming showed up in the same drops via release tracker sweep.
  assert.equal(isInkNoise('Frosting…'), true);
  assert.equal(isInkNoise('Frosting…          33'), true);
  assert.equal(isInkNoise('* Frosting…            8'), true);
  assert.equal(isInkNoise('Swirling…'), true);
  assert.equal(isInkNoise('  Swirling…   5'), true);
  assert.equal(isInkNoise('Cooking…'), true);
  assert.equal(isInkNoise('✶ Cooking… (4s · ↓ 120 tokens · thought for 1s)'), true);
  assert.equal(isInkNoise('Forming…'), true);
  assert.equal(isInkNoise('  Forming…  7'), true);
});

// Note: the regex is line-start prefix-match (no `$` anchor, `…?` optional),
// so prose like "Forming a plan..." also matches. That's a pre-existing
// property shared with Thinking/Processing/Pondering etc. — not regressed
// by v0.8.8. If it ever hits real usage, tighten per-verb (some need `…`,
// some stand alone).
