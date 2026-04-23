import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PodiumOrchestrator } from '../../src/orchestration/core/PodiumOrchestrator';
import type { LiveMultiPanel, PaneDataEvent, PaneExitEvent } from '../../src/orchestration/ui/LiveMultiPanel';

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

function feedPrompt(ctl: FakePanelControl, paneId: string, agent: 'claude' | 'codex' | 'gemini') {
  const prompt = agent === 'claude' ? '╰─────╯\n' : agent === 'codex' ? 'user>\n' : '> \n';
  ctl.firePaneData({ paneId, data: prompt });
}

test('orch: leader assistant token → immediate injection to correct worker', () => {
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
  });

  feedPrompt(ctl, 'W1', 'claude');
  feedPrompt(ctl, 'W2', 'claude');
  clock.advance(200);

  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: hello there\n' });

  assert.equal(ctl.writes.length, 1);
  assert.equal(ctl.writes[0].paneId, 'W1');
  assert.ok(ctl.writes[0].data.startsWith('hello there'));
  assert.equal(orch.snapshot.stats.injected, 1);

  orch.dispose();
});

test('orch: pasted prompt echo does not route before or after leader idle', () => {
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

  feedPrompt(ctl, 'W1', 'claude');
  clock.advance(200);

  ctl.firePaneData({
    paneId: 'L',
    data:
      '> @worker-1: "apple, banana, cherry"를 한글로 번역해서 답해줘.\n' +
      '  @worker-2: 1부터 10까지 합을 계산해서 답만 숫자로 줘.\n' +
      '────────────────────────────────────\n',
  });

  assert.equal(ctl.writes.length, 0, 'prompt echo must be ignored');

  feedPrompt(ctl, 'L', 'claude');
  clock.advance(600);
  orch.tick();

  assert.equal(ctl.writes.length, 0, 'idle flush must not route ignored prompt echo');
  assert.ok(out.log.some((l) => l.includes('suppressed by Claude assistant projector')));

  orch.dispose();
});

test('orch: assistant continuation routes clean worker payloads without border contamination', () => {
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
  });

  feedPrompt(ctl, 'W1', 'claude');
  feedPrompt(ctl, 'W2', 'claude');
  clock.advance(200);

  ctl.firePaneData({
    paneId: 'L',
    data:
      '● @worker-1: "apple, banana, cherry"를 한글로 번역해서 답해줘.\n' +
      '  @worker-2: 1부터 10까지 합을 계산해서 답만 숫자로 줘.\n' +
      '────────────────────────────────────\n',
  });

  assert.equal(ctl.writes.length, 2);
  assert.equal(ctl.writes[0].paneId, 'W1');
  assert.equal(ctl.writes[1].paneId, 'W2');
  assert.ok(ctl.writes[0].data.startsWith('"apple, banana, cherry"를 한글로 번역해서 답해줘.'));
  assert.ok(ctl.writes[1].data.startsWith('1부터 10까지 합을 계산해서 답만 숫자로 줘.'));
  assert.ok(!ctl.writes[1].data.includes('─'));

  orch.dispose();
});

test('orch: busy worker → message queued, drained when idle on next tick', () => {
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

  ctl.firePaneData({ paneId: 'W1', data: 'still thinking...\n' });
  clock.advance(200);

  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: first task\n' });
  assert.equal(ctl.writes.length, 0);

  feedPrompt(ctl, 'W1', 'claude');
  clock.advance(200);
  orch.tick();

  assert.equal(ctl.writes.length, 1);
  assert.equal(ctl.writes[0].paneId, 'W1');

  orch.dispose();
});

test('orch: strips ANSI from leader output before parsing', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 50 }],
    now: clock.now,
    skipAutoTick: true,
  });
  feedPrompt(ctl, 'W1', 'claude');
  clock.advance(200);

  ctl.firePaneData({
    paneId: 'L',
    data: '\x1b[38;5;117m● @worker-1: go\x1b[0m\n',
  });

  assert.equal(ctl.writes.length, 1);
  assert.ok(ctl.writes[0].data.startsWith('go'));

  orch.dispose();
});

test('orch: captureSnapshot surfaces leader + worker sessionIds from attach opts', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: {
      paneId: 'L',
      agent: 'claude',
      sessionId: 'leader-sid-0001',
      label: 'leader test',
    },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude', sessionId: 'w1-sid-aaaa' },
      { id: 'worker-2', paneId: 'W2', agent: 'claude', sessionId: 'w2-sid-bbbb' },
    ],
    cwd: '/fake/workspace',
    now: clock.now,
    skipAutoTick: true,
  });

  const snap = orch.captureSnapshot();
  assert.equal(snap.cwd, '/fake/workspace');
  assert.equal(snap.leader.paneId, 'L');
  assert.equal(snap.leader.sessionId, 'leader-sid-0001');
  assert.equal(snap.leader.label, 'leader test');
  assert.equal(snap.workers.length, 2);
  assert.equal(snap.workers[0].sessionId, 'w1-sid-aaaa');
  assert.equal(snap.workers[1].sessionId, 'w2-sid-bbbb');

  orch.dispose();
});

test('orch: onAutoSnapshot fires with "dissolve" source after dissolve injects summary', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const captured: Array<{ source: string; sid: string | undefined }> = [];
  const orch = new PodiumOrchestrator(ctl.panel, out.channel, async () => '- worker-1: ok\n- worker-2: ok');
  orch.attach({
    leader: { paneId: 'L', agent: 'claude', sessionId: 'L-sid' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude', sessionId: 'W1-sid', silenceMs: 50 },
      { id: 'worker-2', paneId: 'W2', agent: 'claude', sessionId: 'W2-sid', silenceMs: 50 },
    ],
    cwd: '/fake',
    now: clock.now,
    skipAutoTick: true,
    onAutoSnapshot: (snap, source) => {
      captured.push({ source, sid: snap.leader.sessionId });
    },
  });

  feedPrompt(ctl, 'W1', 'claude');
  feedPrompt(ctl, 'W2', 'claude');
  clock.advance(200);

  await orch.dissolve();

  assert.equal(captured.length, 1);
  assert.equal(captured[0].source, 'dissolve');
  assert.equal(captured[0].sid, 'L-sid');

  orch.dispose();
});

test('orch v2.7.22: busyWorkers() uses msSinceOutput-only (prompt-pattern independent)', () => {
  // v2.7.22 regression: under Ink flood, `isIdle`'s prompt-pattern gate
  // could return false for 48s+ even after the worker fell silent, because
  // status-row repaints evicted the `>` line from the rolling tail.
  // busyWorkers() must rely on silence duration only for the UX warn.
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
  });

  // Fresh output → both busy (msSinceOutput = 0).
  ctl.firePaneData({ paneId: 'W1', data: 'still thinking…\n' });
  ctl.firePaneData({ paneId: 'W2', data: 'more output\n' });
  let busy = orch.busyWorkers();
  assert.equal(busy.length, 2);
  assert.deepEqual(busy.map((b) => b.id).sort(), ['worker-1', 'worker-2']);

  // Advance past BUSY_WARN_MS (2000) WITHOUT feeding a prompt line —
  // simulates the Ink-flood scenario where `>` is evicted but silence passed.
  clock.advance(2500);
  assert.equal(orch.busyWorkers().length, 0, 'silence >= 2s → no warning, prompt not required');

  // Fresh burst on W2 only → W2 busy again, W1 still quiet.
  ctl.firePaneData({ paneId: 'W2', data: 'new burst\n' });
  busy = orch.busyWorkers();
  assert.equal(busy.length, 1);
  assert.equal(busy[0].id, 'worker-2');
  assert.ok(busy[0].msSinceOutput < 2000);
  orch.dispose();
});

test('orch v2.7.21: post-dissolve ghost @worker directive is silently ignored (no "unknown worker" log)', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel, async () => 'ok');
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 50 }],
    now: clock.now,
    skipAutoTick: true,
  });

  feedPrompt(ctl, 'W1', 'claude');
  clock.advance(100);

  await orch.dissolve();
  assert.equal(orch.snapshot.stats.dropped, 0, 'dispose baseline — no drops pre-ghost');

  // Ink-style ghost repaint: leader scrollback still shows the @worker-1 directive.
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: ghost payload from scrollback\n' });

  assert.equal(orch.snapshot.stats.dropped, 0, 'no dropped dispatch — parser short-circuited on empty workers');
  const ghostLogs = out.log.filter((l) => l.includes('referenced unknown'));
  assert.equal(ghostLogs.length, 0, 'no "leader referenced unknown" log lines');

  orch.dispose();
});

test('orch: dedup suppresses redraw repeats within the window', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 50 }],
    now: clock.now,
    skipAutoTick: true,
    dedupeWindowMs: 30_000,
  });
  feedPrompt(ctl, 'W1', 'claude');
  clock.advance(200);

  for (let i = 0; i < 5; i++) {
    ctl.firePaneData({ paneId: 'L', data: '● @worker-1: run task X\n' });
  }

  assert.equal(ctl.writes.length, 1);
  assert.equal(orch.snapshot.stats.deduped, 4);

  orch.dispose();
});

test('orch v0.5.1: rapid idle→busy flips within cooldown are coalesced into one turn', () => {
  // Field bug: Claude's Ink TUI takes 500–800ms mid-response pauses
  // (status ticks, internal re-renders) that the 500ms idle detector
  // treats as idle→busy flips. Pre-v0.5.1 each flip bumped turnId,
  // which scattered same-turn dedupe entries across 3–4 turnIds per
  // user prompt and made B strategy useless. The cooldown coalesces
  // those flips into a single logical turn.
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 50 }],
    now: clock.now,
    skipAutoTick: true,
    dedupeWindowMs: 30_000,
  });
  feedPrompt(ctl, 'W1', 'claude');
  clock.advance(200);

  // Simulate the failure mode: force multiple idle→busy transitions by
  // flipping leaderWasIdle manually between pane data events, each one
  // spaced less than the cooldown window (1500ms) apart.
  const anyOrch = orch as any;
  const bumpEdge = (dataHex: string) => {
    anyOrch.leaderWasIdle = true;
    ctl.firePaneData({ paneId: 'L', data: dataHex });
  };

  bumpEdge('● @worker-1: first chunk\n'); // turnId: 0 → 1
  clock.advance(200);
  bumpEdge('● continuation one\n');        // within cooldown → coalesced
  clock.advance(200);
  bumpEdge('● continuation two\n');        // still within cooldown → coalesced
  clock.advance(200);
  bumpEdge('● continuation three\n');      // still within cooldown → coalesced

  const turnLogs = out.log.filter((l) => l.startsWith('[orch.turn]'));
  const advanceLogs = turnLogs.filter((l) => l.includes('turnId advanced'));
  const coalesceLogs = turnLogs.filter((l) => l.includes('coalesced'));

  assert.equal(
    advanceLogs.length,
    1,
    `expected exactly 1 advance log; got ${advanceLogs.length}: ${turnLogs.join(' | ')}`,
  );
  assert.ok(
    coalesceLogs.length >= 1,
    `expected at least 1 coalesce log; got ${coalesceLogs.length}: ${turnLogs.join(' | ')}`,
  );

  // Now advance past the cooldown and fire another edge — this one
  // IS a new turn.
  clock.advance(TURN_COOLDOWN_MS_EXPORTED_FOR_TEST + 100);
  bumpEdge('● new turn content\n');
  const advanceLogsAfter = out.log
    .filter((l) => l.startsWith('[orch.turn]'))
    .filter((l) => l.includes('turnId advanced'));
  assert.equal(advanceLogsAfter.length, 2, 'second real turn should advance again');

  orch.dispose();
});

// The orchestrator's TURN_COOLDOWN_MS is not exported; we mirror the
// value here for test clarity. If the value in the source changes,
// update this constant too — the test above relies on crossing it.
const TURN_COOLDOWN_MS_EXPORTED_FOR_TEST = 1500;

test('orch v0.5.0 (B): same-turn dedupe uses the new "same turn=" log format', () => {
  // The commit log for a dedupe hit now includes the turnId so field
  // debugging can distinguish same-turn suppression (correct) from
  // cross-turn leakage (wrong). Verify the format change is wired.
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 50 }],
    now: clock.now,
    skipAutoTick: true,
    dedupeWindowMs: 30_000,
  });
  feedPrompt(ctl, 'W1', 'claude');
  clock.advance(200);

  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: run task X\n' });
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: run task X\n' });

  assert.equal(ctl.writes.length, 1);
  assert.equal(orch.snapshot.stats.deduped, 1);
  const sameTurnLogs = out.log.filter((l) => l.includes('same turn='));
  assert.ok(
    sameTurnLogs.length >= 1,
    `expected at least one "same turn=" log, got logs: ${out.log.filter((l) => l.includes('[orch.commit]')).join(' | ')}`,
  );

  orch.dispose();
});

test('orch v0.5.0 (P4): round cap flips routingPaused so continued attempts are cheap drops', () => {
  // Pre-v0.5.0, enforceRoundCap logged a notice but left routingPaused
  // alone — the leader often kept trying for several more turns and each
  // attempt re-entered the dedupe/debounce path. v0.5.0 flips the pause
  // flag on cap, converting continued attempts into single-line
  // `[orch.paused]` drops.
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 50 }],
    now: clock.now,
    skipAutoTick: true,
    dedupeWindowMs: 30_000,
    maxRoundsPerTask: 2,
  });
  feedPrompt(ctl, 'W1', 'claude');
  clock.advance(200);

  // Three distinct directives; the cap is 2, so the third should trip it
  // and flip routingPaused.
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: task A\n' });
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: task B\n' });
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: task C\n' });

  assert.equal(
    orch.isPaused,
    true,
    'routingPaused should flip true once round cap is hit',
  );
  // resetRound should auto-resume since the pause came from the round cap.
  orch.resetRound();
  assert.equal(
    orch.isPaused,
    false,
    'resetRound should clear a round-cap-induced pause',
  );

  orch.dispose();
});

test('orch v0.5.0 (P4): manual pause survives resetRound (only round-cap pauses auto-clear)', () => {
  // If the user explicitly pauses routing, a subsequent resetRound must
  // NOT silently resume. Only the round-cap-induced pause is auto-cleared.
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 50 }],
    now: clock.now,
    skipAutoTick: true,
    dedupeWindowMs: 30_000,
    maxRoundsPerTask: 5,
  });
  feedPrompt(ctl, 'W1', 'claude');
  clock.advance(200);

  // User pauses manually.
  orch.pause();
  assert.equal(orch.isPaused, true);

  // resetRound fires — must NOT clear the manual pause.
  orch.resetRound();
  assert.equal(orch.isPaused, true, 'manual pause must survive resetRound');

  orch.dispose();
});
