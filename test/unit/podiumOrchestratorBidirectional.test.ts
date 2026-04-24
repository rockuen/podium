// v0.3.0 — Bidirectional routing + round cap + pause tests.
//
// These exercise the hub-and-spoke extension to PodiumOrchestrator:
//   - Worker emits `@leader: ...` → injected into leader stdin
//   - Worker emits `@worker-2: ...` (from worker-1) → routed to worker-2
//   - Self-route (worker-1 → @worker-1:) is dropped
//   - `maxRoundsPerTask` blocks further routing once hit
//   - `pause()` / `resume()` kill-switch
//
// The test fakes LiveMultiPanel events the same way the existing
// `podiumOrchestrator.test.ts` does. When the orchestrator is configured
// with `enableWorkerRouting: true`, worker-pane data is also parsed for
// directives.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PodiumOrchestrator } from '../../src/orchestration/core/PodiumOrchestrator';
import type {
  LiveMultiPanel,
  PaneDataEvent,
  PaneExitEvent,
} from '../../src/orchestration/ui/LiveMultiPanel';

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
  firePaneData: (e: PaneDataEvent) => void;
  firePaneExit: (e: PaneExitEvent) => void;
  panel: LiveMultiPanel;
}

function makeFakePanel(): FakePanelControl {
  const dataEmit = makeEmitter<PaneDataEvent>();
  const exitEmit = makeEmitter<PaneExitEvent>();
  const writes: Array<{ paneId: string; data: string }> = [];
  const panel = {
    onPaneData: dataEmit.event,
    onPaneExit: exitEmit.event,
    writeToPane(paneId: string, data: string) {
      writes.push({ paneId, data });
    },
    removePane() {},
  } as unknown as LiveMultiPanel;
  return { writes, firePaneData: dataEmit.fire, firePaneExit: exitEmit.fire, panel };
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

function mkClock(start = 1000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function feedPrompt(ctl: FakePanelControl, paneId: string) {
  // Claude box-drawing bottom-edge — enough for IdleDetector to latch prompt.
  ctl.firePaneData({ paneId, data: '╰─────╯\n' });
}

// ────────────────────────────────────────────────────────────────────────

test('bidi: worker @leader: injects into leader stdin', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100, role: 'implementer' },
      { id: 'worker-2', paneId: 'W2', agent: 'claude', silenceMs: 100, role: 'critic' },
    ],
    now: clock.now,
    skipAutoTick: true,
    enableWorkerRouting: true,
  });

  // Prime leader idle so @leader injects don't block on idle gate.
  feedPrompt(ctl, 'L');
  feedPrompt(ctl, 'W1');
  feedPrompt(ctl, 'W2');
  clock.advance(200);

  // Worker-1 emits @leader: reply.
  ctl.firePaneData({
    paneId: 'W1',
    data: '● @leader: implementation complete, 3 functions.\n',
  });

  assert.ok(
    ctl.writes.some(
      (w) => w.paneId === 'L' && w.data.includes('implementation complete'),
    ),
    'leader pane should receive the @leader: payload',
  );
  orch.dispose();
});

test('bidi: worker self-route (@worker-1 from worker-1) is dropped', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100 }],
    now: clock.now,
    skipAutoTick: true,
    enableWorkerRouting: true,
  });

  feedPrompt(ctl, 'L');
  feedPrompt(ctl, 'W1');
  clock.advance(200);

  ctl.firePaneData({
    paneId: 'W1',
    data: '● @worker-1: shouldnt route back to me.\n',
  });

  const matchingWrites = ctl.writes.filter((w) => w.paneId === 'W1');
  assert.equal(matchingWrites.length, 0, 'worker-1 self-route must be dropped');
  assert.ok(
    out.log.some((l) => /self-routed/.test(l)),
    'self-route drop should be logged',
  );
  orch.dispose();
});

test('bidi: worker → peer worker routing works (worker-1 → worker-2)', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100 },
      { id: 'worker-2', paneId: 'W2', agent: 'claude', silenceMs: 100 },
    ],
    now: clock.now,
    skipAutoTick: true,
    enableWorkerRouting: true,
  });

  feedPrompt(ctl, 'W1');
  feedPrompt(ctl, 'W2');
  clock.advance(200);

  ctl.firePaneData({
    paneId: 'W1',
    data: '● @worker-2: please test this function.\n',
  });

  // v0.8.0 — peer routing also spills. Worker-2 receives a path-first
  // notice pointing at a `to-worker-2-turn*.md` drop file; the raw body
  // lives in the file, not in the worker's stdin.
  assert.ok(
    ctl.writes.some(
      (w) => w.paneId === 'W2' && w.data.includes('.omc/team/drops/to-worker-2-turn'),
    ),
    'worker-2 should receive the peer-routed path-first notice',
  );
  orch.dispose();
});

test('round cap: blocks routing once maxRoundsPerTask is hit', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100 }],
    now: clock.now,
    skipAutoTick: true,
    maxRoundsPerTask: 2,
  });

  feedPrompt(ctl, 'W1');
  clock.advance(200);

  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: round 1.\n' });
  feedPrompt(ctl, 'W1');
  clock.advance(200);
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: round 2.\n' });
  feedPrompt(ctl, 'W1');
  clock.advance(200);
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: round 3.\n' });

  const matching = ctl.writes.filter(
    (w) => w.paneId === 'W1' && w.data.includes('round 3'),
  );
  assert.equal(matching.length, 0, 'round 3 should be capped');

  const snap = orch.roundState;
  assert.equal(snap.current, 2, 'round counter stops at cap');
  assert.equal(snap.max, 2);
  assert.ok(
    out.log.some((l) => /roundCap/.test(l) && /round 3/.test(l)),
    'cap breach should be logged',
  );
  orch.dispose();
});

test('round cap: resetRound() re-arms routing', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100 }],
    now: clock.now,
    skipAutoTick: true,
    maxRoundsPerTask: 1,
  });

  feedPrompt(ctl, 'W1');
  clock.advance(200);
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: first.\n' });
  // Second emit should be capped.
  feedPrompt(ctl, 'W1');
  clock.advance(200);
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: second.\n' });
  assert.equal(
    ctl.writes.filter((w) => w.paneId === 'W1' && w.data.includes('second')).length,
    0,
    'second emit is capped',
  );

  orch.resetRound();
  assert.equal(orch.roundState.current, 0);
  const writesBeforeThird = ctl.writes.filter((w) => w.paneId === 'W1').length;

  // Third emit with distinct payload should now succeed.
  // v0.8.0 — body goes to drop file; we assert that a NEW write happened
  // targeting W1 after resetRound (one more than before).
  feedPrompt(ctl, 'W1');
  clock.advance(200);
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: third.\n' });
  const writesAfterThird = ctl.writes.filter((w) => w.paneId === 'W1').length;
  assert.ok(
    writesAfterThird > writesBeforeThird,
    `third emit must route after reset (writes grew from ${writesBeforeThird} to ${writesAfterThird})`,
  );
  orch.dispose();
});

test('pause: drops routing, resume restores it', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100 }],
    now: clock.now,
    skipAutoTick: true,
  });

  feedPrompt(ctl, 'W1');
  clock.advance(200);

  orch.pause();
  assert.equal(orch.isPaused, true);
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: while paused.\n' });
  assert.equal(
    ctl.writes.filter((w) => w.paneId === 'W1' && w.data.includes('while paused'))
      .length,
    0,
    'paused routing is dropped',
  );

  orch.resume();
  assert.equal(orch.isPaused, false);
  const writesBeforeResume = ctl.writes.filter((w) => w.paneId === 'W1').length;
  feedPrompt(ctl, 'W1');
  clock.advance(200);
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: after resume.\n' });
  // v0.8.0 — body goes to drop file; assert write count grew after resume.
  const writesAfterResume = ctl.writes.filter((w) => w.paneId === 'W1').length;
  assert.ok(
    writesAfterResume > writesBeforeResume,
    `resumed routing must deliver (W1 writes grew from ${writesBeforeResume} to ${writesAfterResume})`,
  );
  orch.dispose();
});

test('bidi off: worker output is ignored by the parser (legacy behavior)', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100 }],
    now: clock.now,
    skipAutoTick: true,
    // enableWorkerRouting omitted → legacy one-way mode.
  });
  feedPrompt(ctl, 'L');
  feedPrompt(ctl, 'W1');
  clock.advance(200);
  ctl.firePaneData({ paneId: 'W1', data: '● @leader: no bidi configured.\n' });
  assert.equal(
    ctl.writes.filter((w) => w.paneId === 'L').length,
    0,
    'legacy mode must not route worker directives back',
  );
  orch.dispose();
});
