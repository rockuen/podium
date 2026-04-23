import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PodiumOrchestrator } from '../../src/orchestration/core/PodiumOrchestrator';
import type {
  LiveMultiPanel,
  PaneDataEvent,
  PaneExitEvent,
} from '../../src/orchestration/ui/LiveMultiPanel';
import type { Summarizer } from '../../src/orchestration/core/summarizer';
import {
  buildSummaryPrompt,
  claudeBareSummarizer,
  extractLastAssistantBullet,
  filterTranscriptChrome,
} from '../../src/orchestration/core/summarizer';

// ─── Test doubles (mirrors podiumOrchestrator.test.ts) ───

type Listener<T> = (e: T) => void;

function makeEmitter<T>() {
  const ls = new Set<Listener<T>>();
  const event = (l: Listener<T>) => {
    ls.add(l);
    return { dispose: () => ls.delete(l) };
  };
  const fire = (e: T) => ls.forEach((l) => l(e));
  return { event, fire };
}

interface FakePanelControl {
  writes: Array<{ paneId: string; data: string }>;
  removed: string[];
  firePaneData: (e: PaneDataEvent) => void;
  firePaneExit: (e: PaneExitEvent) => void;
  panel: LiveMultiPanel;
}

function makeFakePanel(): FakePanelControl {
  const dataEmit = makeEmitter<PaneDataEvent>();
  const exitEmit = makeEmitter<PaneExitEvent>();
  const writes: Array<{ paneId: string; data: string }> = [];
  const removed: string[] = [];
  const panel = {
    onPaneData: dataEmit.event,
    onPaneExit: exitEmit.event,
    writeToPane(paneId: string, data: string) {
      writes.push({ paneId, data });
    },
    removePane(paneId: string) {
      removed.push(paneId);
    },
  } as unknown as LiveMultiPanel;
  return { writes, removed, firePaneData: dataEmit.fire, firePaneExit: exitEmit.fire, panel };
}

function makeOutputChannel(): { log: string[]; channel: any } {
  const log: string[] = [];
  return {
    log,
    channel: {
      appendLine(s: string) {
        log.push(s);
      },
    },
  };
}

// ─── Tests ───

test('dissolve: captures stripped transcript per worker', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  let sumCalled: any = null;
  const fakeSummarizer: Summarizer = async (items) => {
    sumCalled = items;
    return 'stub summary';
  };
  const orch = new PodiumOrchestrator(ctl.panel, out.channel, fakeSummarizer);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude' },
      { id: 'worker-2', paneId: 'W2', agent: 'claude' },
    ],
    skipAutoTick: true,
  });

  // Feed worker output with ANSI that should be stripped in the transcript.
  // v0.7.4: transcript now runs through the assistant-only projector, so
  // the input must be shaped as real Claude assistant output ("● " bullet)
  // to land in the transcript. Non-bullet lines correctly classify as UI
  // chrome or narration and are filtered out.
  ctl.firePaneData({ paneId: 'W1', data: '\x1b[31m● answer from w1\x1b[0m\n' });
  ctl.firePaneData({ paneId: 'W2', data: '● answer from w2\n' });

  const summary = await orch.dissolve();
  assert.equal(summary, 'stub summary');
  assert.ok(sumCalled);
  assert.equal(sumCalled.length, 2);
  assert.equal(sumCalled[0].workerId, 'worker-1');
  assert.ok(sumCalled[0].transcript.includes('answer from w1'));
  assert.ok(!sumCalled[0].transcript.includes('\x1b'), 'ANSI must be stripped from transcript');
  assert.equal(sumCalled[1].workerId, 'worker-2');
  assert.ok(sumCalled[1].transcript.includes('answer from w2'));

  orch.dispose();
});

test('dissolve: kills all worker panes and injects summary into leader', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const fakeSummarizer: Summarizer = async () => '- worker-1: 5 numbers\n- worker-2: 3 words';
  const orch = new PodiumOrchestrator(ctl.panel, out.channel, fakeSummarizer);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude' },
      { id: 'worker-2', paneId: 'W2', agent: 'claude' },
    ],
    skipAutoTick: true,
  });

  ctl.firePaneData({ paneId: 'W1', data: '1 2 3 4 5\n' });
  ctl.firePaneData({ paneId: 'W2', data: '사과, 바다, 하늘\n' });

  await orch.dissolve();

  assert.deepEqual(ctl.removed.sort(), ['W1', 'W2']);
  // Exactly one write (into leader) — the summary injection.
  assert.equal(ctl.writes.length, 1);
  assert.equal(ctl.writes[0].paneId, 'L');
  assert.ok(ctl.writes[0].data.includes('Team dissolved'));
  assert.ok(ctl.writes[0].data.includes('worker-1: 5 numbers'));
  assert.ok(ctl.writes[0].data.includes('worker-2: 3 words'));
  assert.equal(orch.snapshot.stats.dissolved, 2);
  assert.equal(orch.snapshot.workers.length, 0, 'workers map cleared');
  assert.ok(out.log.some((l) => l.includes('killed 2 worker pane(s)')));

  orch.dispose();
});

test('dissolve: summarizer failure falls back to raw transcript tails', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const failing: Summarizer = async () => {
    throw new Error('network down');
  };
  const orch = new PodiumOrchestrator(ctl.panel, out.channel, failing);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude' }],
    skipAutoTick: true,
  });

  ctl.firePaneData({ paneId: 'W1', data: '● raw answer from worker\n' });

  const summary = await orch.dissolve();
  assert.ok(summary && summary.includes('worker-1'));
  assert.ok(summary.includes('(raw tail)'));
  assert.ok(summary.includes('raw answer from worker'));
  assert.ok(out.log.some((l) => l.includes('summarizer FAILED — network down')));
  // Workers still killed even on summarizer failure.
  assert.deepEqual(ctl.removed, ['W1']);
  assert.equal(ctl.writes.length, 1, 'fallback summary still injected');

  orch.dispose();
});

test('dissolve: no-op when no workers are attached', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const fakeSummarizer: Summarizer = async () => 'should not run';
  const orch = new PodiumOrchestrator(ctl.panel, out.channel, fakeSummarizer);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [],
    skipAutoTick: true,
  });

  const summary = await orch.dissolve();
  assert.equal(summary, null);
  assert.equal(ctl.writes.length, 0);
  assert.equal(ctl.removed.length, 0);
  assert.ok(out.log.some((l) => l.includes('no workers to dissolve')));

  orch.dispose();
});

test('dissolve: transcript cap at 50KB keeps only the tail', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  let received: any = null;
  const grab: Summarizer = async (items) => {
    received = items;
    return 'ok';
  };
  const orch = new PodiumOrchestrator(ctl.panel, out.channel, grab);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude' }],
    skipAutoTick: true,
  });

  // Feed 60KB of filler then a distinctive final marker.
  // v0.7.4: transcript runs through the assistant-only projector, so
  // the filler lines need a bullet (`● `) to classify as assistant-
  // start, and the marker line needs a 2-space indent to classify as
  // assistant-cont. We also split the filler into many lines so each
  // stays well under the projector's MAX_PARTIAL (8KB) buffer cap,
  // which would otherwise force-flush + close the assistant block.
  const fillerLine = '● ' + 'x'.repeat(500);
  const lines: string[] = [];
  for (let i = 0; i < 130; i++) lines.push(fillerLine);
  lines.push('  FINAL_ANSWER_MARKER');
  ctl.firePaneData({ paneId: 'W1', data: lines.join('\n') + '\n' });

  await orch.dissolve();
  assert.ok(received);
  const t = received[0].transcript as string;
  assert.ok(t.length <= 50_000, `transcript capped (got ${t.length})`);
  assert.ok(t.includes('FINAL_ANSWER_MARKER'), 'tail preserved');

  orch.dispose();
});

test('summarizer: buildSummaryPrompt truncates long transcripts per worker', () => {
  const items = [
    { workerId: 'worker-1', transcript: 'a'.repeat(5000) + '\nFINAL' },
    { workerId: 'worker-2', transcript: 'short' },
  ];
  const prompt = buildSummaryPrompt(items);
  // Worker-1 tail truncated to 1500 chars (MAX_CHARS_PER_WORKER) — FINAL is in there.
  assert.ok(prompt.includes('FINAL'));
  // The full 5000-char 'a' run should NOT fit — only the tail window does.
  const aRun = prompt.match(/a+/g)?.sort((x, y) => y.length - x.length)[0] ?? '';
  assert.ok(aRun.length < 2000, `a-run truncated (got ${aRun.length})`);
  // Worker-2 short content included verbatim.
  assert.ok(prompt.includes('short'));
});

test('summarizer: empty transcripts produce a readable placeholder', () => {
  const items = [{ workerId: 'worker-1', transcript: '' }];
  const prompt = buildSummaryPrompt(items);
  assert.ok(prompt.includes('(no output captured)'));
});

// v2.7.20: spinner-row filter + consecutive-dup collapse.
test('filter v2.7.20: Ink spinner status rows (Processing…/Shenaniganing…) are dropped', () => {
  const raw = [
    '⠋ Processing…',
    '⠙ Shenaniganing… (3s · esc to interrupt)',
    '⠸ Synthesizing…',
    '●  빨강, 파랑, 초록',
    '⠦ Percolating…',
  ].join('\n');
  const out = filterTranscriptChrome(raw);
  assert.ok(out.includes('빨강, 파랑, 초록'), 'answer bullet preserved');
  assert.ok(!/Processing…|Shenaniganing…|Synthesizing…|Percolating…/.test(out),
    'all spinner rows dropped');
});

test('filter v2.7.23: spinner word without Braille glyph is also dropped (Osmosing…/Quantumizing…)', () => {
  // v2.7.23 regression: Ink emits status words on their own line when the
  // Braille glyph falls on a prior chunk boundary, or during specific cycle
  // variants. v2.7.20's Braille-required regex missed these, reviving the
  // "can't extract final answer" failure.
  const raw = [
    'Osmosing…',
    'Quantumizing… (5s)',
    '  Synthesizing…',
    '●  빨강, 파랑, 초록',
    'Percolating…',
  ].join('\n');
  const out = filterTranscriptChrome(raw);
  assert.ok(out.includes('빨강, 파랑, 초록'), 'answer bullet preserved');
  assert.ok(!/Osmosing…|Quantumizing…|Synthesizing…|Percolating…/.test(out),
    'bare-word spinner rows dropped even without Braille prefix');
});

test('filter v2.7.23: numeric + Korean answers are NOT misclassified as spinner', () => {
  // Regression guard: the broadened regex must not swallow legitimate
  // worker answers. "110" is a numeric answer; Korean prose has no trailing
  // ellipsis; short phrases with `…` but non-ASCII leading chars must pass.
  const raw = [
    '●  110',
    '●  빨강, 파랑, 초록',
    '결과만 적어주세요.',
    '…앞뒤 말줄임표 있는 한글',
  ].join('\n');
  const out = filterTranscriptChrome(raw);
  assert.ok(out.includes('110'), 'numeric answer preserved');
  assert.ok(out.includes('빨강, 파랑, 초록'), 'korean answer preserved');
  assert.ok(out.includes('결과만 적어주세요'), 'korean prose preserved');
  assert.ok(out.includes('앞뒤 말줄임표 있는 한글'), 'non-ASCII leading line preserved');
});

test('filter v2.7.20: "(esc to interrupt ...)" keyboard hint banner is dropped', () => {
  const raw = [
    '●  빨강, 파랑, 초록',
    '(esc to interrupt · ctrl+t to show todos)',
    '(  esc to interrupt  )',
  ].join('\n');
  const out = filterTranscriptChrome(raw);
  assert.ok(out.includes('빨강, 파랑, 초록'));
  assert.ok(!out.includes('esc to interrupt'), 'hint banner stripped');
});

test('filter v2.7.20: consecutive identical non-empty lines are collapsed to one', () => {
  const raw = [
    '●  110',
    '●  110',
    '●  110',
    '', // blank preserved
    '●  110', // non-consecutive repeat stays
    'tail',
  ].join('\n');
  const out = filterTranscriptChrome(raw);
  const bullets = out.split('\n').filter((l) => l.trim() === '●  110');
  assert.equal(bullets.length, 2, 'runs collapsed, post-blank repeat kept');
});

test('filter v2.7.20: realistic Ink-flooded transcript preserves answer in -1500 tail', () => {
  // Simulate what actually happens: answer bullet appears once, then Ink
  // repaints the status row hundreds of times while the input prompt idles.
  const noise = Array.from({ length: 200 }, () => '⠙ Shenaniganing… (idle)').join('\n');
  const raw = `some preamble\n●  빨강, 파랑, 초록\n${noise}\n`;
  const filtered = filterTranscriptChrome(raw);
  // With v2.7.19 filter: 200×'Shenaniganing…' (~5000 chars) pushes the answer
  // out of the -1500 tail. With v2.7.20: the noise lines are dropped upstream,
  // so the answer survives into the tail window used by buildSummaryPrompt.
  const tail = filtered.slice(-1500);
  assert.ok(tail.includes('빨강, 파랑, 초록'), 'answer survives into -1500 tail');
});

// v2.7.24: Deterministic `●` bullet extraction + hybrid summarizer.

test('extract v2.7.24: single-line `● <content>` returns content only', () => {
  const out = extractLastAssistantBullet('user prompt echo\n\n●  빨강, 파랑, 초록\n\n>');
  assert.equal(out, '빨강, 파랑, 초록');
});

test('extract v2.7.24: numeric single-token bullet (` ●  110 `)', () => {
  const out = extractLastAssistantBullet('user asked for sum\n\n●  110\n\n>');
  assert.equal(out, '110');
});

test('extract v2.7.24: multi-line indented continuation is joined with spaces', () => {
  const raw = [
    '●  The translations:',
    '   red: 빨강',
    '   blue: 파랑',
    '   green: 초록',
    '',
    '>',
  ].join('\n');
  const out = extractLastAssistantBullet(raw);
  assert.equal(out, 'The translations: red: 빨강 blue: 파랑 green: 초록');
});

test('extract v2.7.24: returns LAST bullet when multiple are present', () => {
  const raw = [
    '●  intermediate thought',
    '',
    '●  final answer',
    '',
    '>',
  ].join('\n');
  assert.equal(extractLastAssistantBullet(raw), 'final answer');
});

test('extract v2.7.24: returns null when no bullet present', () => {
  const raw = 'just user text\nno assistant output\n>';
  assert.equal(extractLastAssistantBullet(raw), null);
});

test('summarizer v2.7.24: skips Haiku entirely when every worker has a bullet', async () => {
  // Use the real claudeBareSummarizer. Since both workers have `●` bullets,
  // no CLI call should happen — the summary is constructed deterministically.
  // If Haiku were called in this test env it would fail (no claude CLI in PATH
  // of the test runner), so a fast successful return proves the happy path.
  const items = [
    {
      workerId: 'worker-1',
      transcript: 'user asked to translate\n●  빨강, 파랑, 초록\n>\n[OMC#4.12.0] | status',
    },
    {
      workerId: 'worker-2',
      transcript: 'user asked for even sum\n●  110\n>\n[OMC#4.12.0] | status',
    },
  ];
  const t0 = Date.now();
  const out = await claudeBareSummarizer(items);
  const elapsed = Date.now() - t0;
  assert.equal(out, '- worker-1: 빨강, 파랑, 초록\n- worker-2: 110');
  assert.ok(elapsed < 500, `deterministic path should be instant (took ${elapsed}ms)`);
});
