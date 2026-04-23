// Phase 4.B · v2.7.25 — Dynamic Worker Management tests.
//
// Covers PodiumOrchestrator.addWorker/removeWorker/renameWorker/
// scheduleLeaderNotify/listWorkers and the id-recycle regression.
// Also exercises dissolve × runtime-worker roundtrips (add+dissolve,
// remove+dissolve, add×3 + remove×1 + dissolve).
//
// Style mirrors `podiumOrchestrator.test.ts` — same FakePanel + mkClock.
// FakePanel is extended with a `hasPane` helper (invariant for ADR-1 rollback)
// and a `failNextAddPane` knob to simulate the silent-spawn-failure path.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  MAX_RUNTIME_WORKERS,
  PodiumOrchestrator,
} from '../../src/orchestration/core/PodiumOrchestrator';
import type {
  LiveMultiPanel,
  LivePaneSpec,
  PaneDataEvent,
  PaneExitEvent,
} from '../../src/orchestration/ui/LiveMultiPanel';
import type { Summarizer } from '../../src/orchestration/core/summarizer';

// ─── Test doubles ────────────────────────────────────────────────────────

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
  added: LivePaneSpec[];
  removed: string[];
  hasPaneMap: Map<string, boolean>;
  /** When set, the next `addPane` call registers the pane as NOT present (silent spawn failure). */
  failNextAddPane: boolean;
  firePaneData: (e: PaneDataEvent) => void;
  firePaneExit: (e: PaneExitEvent) => void;
  panel: LiveMultiPanel;
}

function makeFakePanel(seedPanes: string[] = []): FakePanelControl {
  const dataEmit = makeEmitter<PaneDataEvent>();
  const exitEmit = makeEmitter<PaneExitEvent>();
  const writes: Array<{ paneId: string; data: string }> = [];
  const added: LivePaneSpec[] = [];
  const removed: string[] = [];
  const hasPaneMap = new Map<string, boolean>();
  for (const id of seedPanes) hasPaneMap.set(id, true);

  const ctl: FakePanelControl = {
    writes,
    added,
    removed,
    hasPaneMap,
    failNextAddPane: false,
    firePaneData: dataEmit.fire,
    firePaneExit: exitEmit.fire,
    panel: {} as LiveMultiPanel,
  };

  ctl.panel = {
    onPaneData: dataEmit.event,
    onPaneExit: exitEmit.event,
    writeToPane(paneId: string, data: string) {
      writes.push({ paneId, data });
    },
    addPane(spec: LivePaneSpec) {
      added.push(spec);
      if (ctl.failNextAddPane) {
        // Simulate addPane swallowing a spawn error: the pane is NOT present.
        ctl.failNextAddPane = false;
        return;
      }
      hasPaneMap.set(spec.paneId, true);
    },
    hasPane(paneId: string): boolean {
      return hasPaneMap.get(paneId) === true;
    },
    removePane(paneId: string) {
      removed.push(paneId);
      hasPaneMap.delete(paneId);
    },
  } as unknown as LiveMultiPanel;
  return ctl;
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

/** Attach with 2 workers (worker-1/W1, worker-2/W2) under a claude leader. */
function attach2(
  orch: PodiumOrchestrator,
  ctl: FakePanelControl,
  clock: { now: () => number },
  extra: Partial<Parameters<PodiumOrchestrator['attach']>[0]> = {},
) {
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100 },
      { id: 'worker-2', paneId: 'W2', agent: 'claude', silenceMs: 100 },
    ],
    now: clock.now,
    skipAutoTick: true,
    ...extra,
  });
  // Seed attach panes as present in the fake panel.
  ctl.hasPaneMap.set('L', true);
  ctl.hasPaneMap.set('W1', true);
  ctl.hasPaneMap.set('W2', true);
}

function leaderWrites(ctl: FakePanelControl): Array<{ paneId: string; data: string }> {
  return ctl.writes.filter((w) => w.paneId === 'L');
}

// ─── 9.1 · add: happy path ──────────────────────────────────────────────

test('addWorker v2.7.25: happy path — map grows, log present, notify scheduled', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  attach2(orch, ctl, clock);

  // Simulate leader idle so scheduleLeaderNotify commits the notify synchronously.
  feedPrompt(ctl, 'L', 'claude');
  clock.advance(800);

  const sizeBefore = orch.listWorkers().length;
  await orch.addWorker({
    id: 'worker-3',
    paneId: 'worker-3',
    agent: 'claude',
    sessionId: 'abc',
  });

  assert.equal(orch.listWorkers().length, 3, 'list must grow to 3');
  assert.equal(orch.listWorkers().length - sizeBefore, 1);
  const added = orch.listWorkers().find((w) => w.cfg.id === 'worker-3');
  assert.ok(added, 'worker-3 added');
  assert.equal(added!.cfg.paneId, 'worker-3');
  assert.equal(added!.cfg.agent, 'claude');
  assert.equal(added!.cfg.sessionId, 'abc');
  // Fresh IdleDetector + empty queue/recentPayloads.
  assert.equal(added!.queue.length, 0);
  assert.equal(added!.recentPayloads.size, 0);
  assert.ok(added!.idle, 'IdleDetector constructed for new worker');
  assert.equal(added!.transcript, '');

  // addPane spec carried the cwd + sessionId.
  const spec = ctl.added.find((s) => s.paneId === 'worker-3');
  assert.ok(spec, 'addPane invoked with worker-3 spec');
  assert.equal(spec!.agent, 'claude');

  // Log line emitted.
  assert.ok(
    out.log.some((l) => l.includes('[orch] addWorker worker-3')),
    '[orch] addWorker log present',
  );

  // Leader notify scheduled → body write to leader pane (L) contains the join phrase.
  // Substring-only assertion (Windows splits body + submit via setTimeout).
  const lWrites = leaderWrites(ctl);
  assert.ok(lWrites.length >= 1, 'leader notify wrote at least the body frame');
  const bodyText = lWrites.map((w) => w.data).join('');
  assert.ok(bodyText.includes('[system]'), 'body contains [system] prefix');
  assert.ok(bodyText.includes('worker-3 joined'), 'body contains worker-3 joined');
  assert.ok(
    !bodyText.includes('@worker-'),
    'notify body MUST NOT contain @worker- (substring assertion invariant)',
  );

  orch.dispose();
});

// ─── 9.1b · listWorkers returns current entries ──────────────────────────

test('addWorker v2.7.25: listWorkers reflects the live map', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  attach2(orch, ctl, clock);
  feedPrompt(ctl, 'L', 'claude');
  clock.advance(800);

  assert.equal(orch.listWorkers().length, 2);
  await orch.addWorker({ id: 'worker-3', paneId: 'worker-3', agent: 'claude' });
  const ids = orch.listWorkers().map((w) => w.cfg.id);
  assert.deepEqual(ids.sort(), ['worker-1', 'worker-2', 'worker-3']);
  orch.dispose();
});

// ─── 9.2 · add: rollback on pane spawn failure ──────────────────────────

test('addWorker v2.7.25: rollback when addPane silently fails (hasPane returns false)', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  attach2(orch, ctl, clock);
  feedPrompt(ctl, 'L', 'claude');
  clock.advance(800);

  ctl.failNextAddPane = true;

  await assert.rejects(
    orch.addWorker({ id: 'worker-3', paneId: 'worker-3', agent: 'claude' }),
    /pane spawn failed|spawn failed/i,
    'addWorker must throw when hasPane returns false after addPane',
  );

  // Map not mutated — still the original 2 workers.
  const ids = orch.listWorkers().map((w) => w.cfg.id).sort();
  assert.deepEqual(ids, ['worker-1', 'worker-2'], 'workers Map unchanged');
  assert.equal(orch.listWorkers().find((w) => w.cfg.id === 'worker-3'), undefined);

  // No leader-notify body landed for a failed add.
  const lWrites = leaderWrites(ctl);
  const notifyText = lWrites.map((w) => w.data).join('');
  assert.ok(
    !notifyText.includes('worker-3 joined'),
    'no join notify when rollback triggered',
  );

  orch.dispose();
});

// ─── 9.3 · add: cap enforcement ─────────────────────────────────────────

test('addWorker v2.7.25: cap enforcement throws on the MAX+1 attempt', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  // Attach with ZERO workers so we can populate to exactly the cap.
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [],
    now: clock.now,
    skipAutoTick: true,
  });
  ctl.hasPaneMap.set('L', true);
  feedPrompt(ctl, 'L', 'claude');
  clock.advance(800);

  assert.equal(MAX_RUNTIME_WORKERS, 10, 'cap constant matches the plan');
  for (let i = 1; i <= MAX_RUNTIME_WORKERS; i++) {
    await orch.addWorker({ id: `worker-${i}`, paneId: `worker-${i}`, agent: 'claude' });
  }
  assert.equal(orch.listWorkers().length, MAX_RUNTIME_WORKERS);

  await assert.rejects(
    orch.addWorker({ id: `worker-${MAX_RUNTIME_WORKERS + 1}`, paneId: 'worker-11', agent: 'claude' }),
    /cap|MAX_RUNTIME_WORKERS|10/i,
    `${MAX_RUNTIME_WORKERS + 1}th addWorker must reject with cap message`,
  );
  // Map size did not grow.
  assert.equal(orch.listWorkers().length, MAX_RUNTIME_WORKERS);

  orch.dispose();
});

// ─── 9.4 (plan 3 expanded) · remove: drop count accuracy ─────────────────

test('removeWorker v2.7.25: drop-count notify reports queue + pending totals', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  attach2(orch, ctl, clock);
  // Make the leader look idle so the remove notify commits promptly.
  feedPrompt(ctl, 'L', 'claude');
  clock.advance(800);

  // Seed queue with 2 payloads directly on the WorkerRuntime (via public
  // listWorkers() — mutating the returned runtime's queue is acceptable here
  // because the orchestrator exposes it for test inspection & the drop-count
  // arithmetic operates on `worker.queue.length`).
  const worker1 = orch.listWorkers().find((w) => w.cfg.id === 'worker-1')!;
  worker1.queue.push('payload-a');
  worker1.queue.push('payload-b');

  // Inject a fake pendingRoute entry via private-field access. We can't avoid
  // this without a production-code test seam; access is isolated inside the
  // test to read behavior, not to alter it.
  const fakeTimer = setTimeout(() => {}, 10_000);
  (orch as any).pendingRoute.set('worker-1', { payload: 'pending-x', timer: fakeTimer });

  // Snapshot leader writes before the remove (there may already be body/submit
  // fragments from join notifies during attach if any — filter by substring).
  const lWritesBefore = leaderWrites(ctl).length;

  await orch.removeWorker('worker-1');

  // Worker gone.
  assert.equal(
    orch.listWorkers().find((w) => w.cfg.id === 'worker-1'),
    undefined,
    'worker-1 removed from map',
  );
  assert.equal(
    (orch as any).pendingRoute.has('worker-1'),
    false,
    'pendingRoute entry cleared (clearTimeout called)',
  );

  // Leader notify body contains the drop count (2 queue + 1 pending = 3).
  const lWritesAfter = leaderWrites(ctl).slice(lWritesBefore);
  const notifyBody = lWritesAfter.map((w) => w.data).join('');
  assert.ok(
    notifyBody.includes('(3 pending dropped)'),
    `expected "(3 pending dropped)" in notify, got: ${JSON.stringify(notifyBody)}`,
  );
  // Also log reflects the arithmetic.
  assert.ok(
    out.log.some((l) => l.includes('removeWorker worker-1 droppedCount=3')),
    'log line reflects droppedCount=3',
  );

  orch.dispose();
});

// ─── 9.5 · remove: no-pending notify text ───────────────────────────────

test('removeWorker v2.7.25: notify says "no pending" when queue + pendingRoute are empty', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  attach2(orch, ctl, clock);
  feedPrompt(ctl, 'L', 'claude');
  clock.advance(800);

  await orch.addWorker({ id: 'worker-3', paneId: 'worker-3', agent: 'claude' });
  const beforeCount = leaderWrites(ctl).length;

  await orch.removeWorker('worker-3');

  const notify = leaderWrites(ctl).slice(beforeCount).map((w) => w.data).join('');
  assert.ok(
    notify.includes('(no pending)'),
    `expected "(no pending)" in notify, got: ${JSON.stringify(notify)}`,
  );
  assert.equal(orch.listWorkers().length, 2, 'back down to 2 workers');

  orch.dispose();
});

// ─── 9.6 · remove: missing id is no-op ──────────────────────────────────

test('removeWorker v2.7.25: missing id is a warn-log no-op (no throw, no panel mutation)', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  attach2(orch, ctl, clock);
  feedPrompt(ctl, 'L', 'claude');
  clock.advance(800);

  const removedBefore = ctl.removed.length;
  const writesBefore = ctl.writes.length;

  // Must not throw.
  await orch.removeWorker('worker-999');

  assert.ok(
    out.log.some((l) => l.includes('removeWorker') && l.includes('worker-999')),
    'warn log for unknown id present',
  );
  assert.equal(ctl.removed.length, removedBefore, 'no removePane call');
  assert.equal(ctl.writes.length, writesBefore, 'no leader writes');
  assert.equal(orch.listWorkers().length, 2, 'map unchanged');

  orch.dispose();
});

// ─── 9.7 · rename: label-only, routing-key unchanged ────────────────────

test('renameWorker v2.7.25: label-only — cfg.id untouched, routing by id still works, snapshot carries label', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  attach2(orch, ctl, clock);

  // Ready worker-1 for a route dispatch.
  feedPrompt(ctl, 'W1', 'claude');
  clock.advance(200);

  orch.renameWorker('worker-1', 'summarizer');

  const w1 = orch.listWorkers().find((w) => w.cfg.id === 'worker-1');
  assert.ok(w1, 'worker-1 still present under the same id');
  assert.equal(w1!.cfg.id, 'worker-1', 'routing key (cfg.id) unchanged');
  assert.equal(w1!.cfg.label, 'summarizer', 'label applied');

  // Route via @worker-1: — the label must not break routing.
  const writesBefore = ctl.writes.length;
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: hello\n' });
  const writesAfter = ctl.writes.slice(writesBefore);
  const w1Writes = writesAfter.filter((w) => w.paneId === 'W1');
  assert.ok(w1Writes.length >= 1, 'worker-1 still receives routed payload');
  assert.ok(w1Writes[0].data.startsWith('hello'), 'payload content routed correctly');

  // captureSnapshot serializes the label.
  const snap = orch.captureSnapshot();
  const snapWorker1 = snap.workers.find((w) => w.id === 'worker-1');
  assert.ok(snapWorker1);
  assert.equal(snapWorker1!.label, 'summarizer', 'snapshot carries the renamed label');

  orch.dispose();
});

// ─── 9.8 · rename: empty/whitespace label throws ────────────────────────

test('renameWorker v2.7.25: throws on empty/whitespace label, current label untouched', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  attach2(orch, ctl, clock);

  // First set a known label.
  orch.renameWorker('worker-1', 'original');
  const labelBefore = orch.listWorkers().find((w) => w.cfg.id === 'worker-1')!.cfg.label;
  assert.equal(labelBefore, 'original');

  assert.throws(() => orch.renameWorker('worker-1', ''), /label required/i);
  assert.throws(() => orch.renameWorker('worker-1', '   '), /label required/i);

  const labelAfter = orch.listWorkers().find((w) => w.cfg.id === 'worker-1')!.cfg.label;
  assert.equal(labelAfter, 'original', 'failed rename left the label untouched');

  orch.dispose();
});

// ─── 9.9 · rename: missing id is warn-log no-op ─────────────────────────

test('renameWorker v2.7.25: missing id is warn-log no-op (no throw, no mutation)', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  attach2(orch, ctl, clock);

  const idsBefore = orch.listWorkers().map((w) => w.cfg.id).sort();

  // Must not throw.
  orch.renameWorker('worker-999', 'ghost');

  assert.ok(
    out.log.some((l) => l.includes('renameWorker') && l.includes('worker-999')),
    'warn log for unknown id present',
  );
  const idsAfter = orch.listWorkers().map((w) => w.cfg.id).sort();
  assert.deepEqual(idsAfter, idsBefore, 'map shape unchanged');
  orch.dispose();
});

// ─── 9.10 · id recycle regression ───────────────────────────────────────

test('addWorker v2.7.25: id recycle after remove yields a FRESH runtime (no residual state)', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  attach2(orch, ctl, clock);
  feedPrompt(ctl, 'L', 'claude');
  clock.advance(800);

  // Add worker-3 first time.
  await orch.addWorker({ id: 'worker-3', paneId: 'worker-3', agent: 'claude' });
  const firstIncarnation = orch.listWorkers().find((w) => w.cfg.id === 'worker-3')!;

  // Seed queue + recentPayloads + pendingRoute on the first incarnation.
  firstIncarnation.queue.push('stale-queued');
  firstIncarnation.recentPayloads.set('stale-recent', { turnId: 0, ts: 1500 });
  const staleTimer = setTimeout(() => {}, 10_000);
  (orch as any).pendingRoute.set('worker-3', { payload: 'stale-pending', timer: staleTimer });

  const oldIdleRef = firstIncarnation.idle;

  // Remove it.
  await orch.removeWorker('worker-3');
  assert.equal(orch.listWorkers().find((w) => w.cfg.id === 'worker-3'), undefined);
  assert.equal((orch as any).pendingRoute.has('worker-3'), false, 'pendingRoute cleared on remove');

  // Re-add under the same id.
  await orch.addWorker({ id: 'worker-3', paneId: 'worker-3', agent: 'claude' });
  const secondIncarnation = orch.listWorkers().find((w) => w.cfg.id === 'worker-3')!;

  // Assertions on the NEW incarnation.
  assert.equal(secondIncarnation.queue.length, 0, 'fresh queue');
  assert.equal(secondIncarnation.recentPayloads.size, 0, 'fresh recentPayloads');
  assert.equal(
    (orch as any).pendingRoute.has('worker-3'),
    false,
    'fresh pendingRoute (nothing left behind)',
  );
  assert.notEqual(
    secondIncarnation.idle,
    oldIdleRef,
    'IdleDetector is a NEW instance — identity differs from the first incarnation',
  );

  orch.dispose();
});

// ─── 9.11 · scheduleLeaderNotify: substring assertion ───────────────────

test('scheduleLeaderNotify v2.7.25: forbidden substring @worker- throws', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  attach2(orch, ctl, clock);

  // The substring assertion is the FIRST thing the helper checks. Any body
  // containing `@worker-` must throw synchronously, regardless of leader
  // idle state. We call the private helper via `(orch as any)` because this
  // is an internal invariant — production callers phrase notifies without `@`.
  assert.throws(
    () => (orch as any).scheduleLeaderNotify('reference to @worker-1 in body'),
    /forbidden substring @worker-|@worker-/i,
    'body containing @worker- must throw',
  );

  // Safe notify bodies do not throw (and produce a leader write).
  (orch as any).scheduleLeaderNotify('worker-3 joined. Route it normally.');

  orch.dispose();
});

// ─── 9.12 · scheduleLeaderNotify: idle-gated commit ─────────────────────

test('scheduleLeaderNotify v2.7.25: idle-gated — does NOT commit until leader becomes idle', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  attach2(orch, ctl, clock);

  // Make the leader NOT idle — feed recent data so silenceMs hasn't elapsed.
  ctl.firePaneData({ paneId: 'L', data: 'streaming chunk...\n' });
  // No clock advance → msSinceOutput = 0, below leader silenceMs=500 → not idle.
  assert.equal((orch as any).leaderIdle.isIdle, false, 'leader starts busy');

  const writesBefore = leaderWrites(ctl).length;
  (orch as any).scheduleLeaderNotify('worker-3 joined. Route it normally.');

  // First arm() ran sync, saw not-idle, scheduled setTimeout(arm, 250ms).
  // No real time has advanced → no commit yet.
  assert.equal(
    leaderWrites(ctl).length,
    writesBefore,
    'no commit on initial sync arm() when leader is busy',
  );

  // Tick the mock timer by 250ms and 500ms. Each tick fires arm(); both see
  // still-not-idle, elapsed < 2000 → re-arm without committing.
  t.mock.timers.tick(250);
  assert.equal(
    leaderWrites(ctl).length,
    writesBefore,
    'still no commit at 250ms while leader busy',
  );
  t.mock.timers.tick(250);
  assert.equal(
    leaderWrites(ctl).length,
    writesBefore,
    'still no commit at 500ms while leader busy',
  );

  // Flip leader to idle: advance the fake clock past silenceMs and feed a
  // prompt pattern. Also advance the fake clock used by scheduleLeaderNotify
  // for its elapsed calculation.
  feedPrompt(ctl, 'L', 'claude');
  clock.advance(800);
  assert.equal((orch as any).leaderIdle.isIdle, true, 'leader now idle');

  // Tick the mock timer so the next arm() fires. Idle check passes → commit.
  t.mock.timers.tick(250);

  const lWritesAfter = leaderWrites(ctl);
  assert.ok(
    lWritesAfter.length > writesBefore,
    'leader write(s) appeared after leader became idle',
  );
  const commitText = lWritesAfter.slice(writesBefore).map((w) => w.data).join('');
  assert.ok(commitText.includes('worker-3 joined'), 'notify committed on idle');
  assert.ok(
    out.log.some((l) => l.includes('[orch.leaderNotify] committed')),
    'committed log line emitted',
  );

  t.mock.timers.reset();
  orch.dispose();
});

// ─── 9.13 · scheduleLeaderNotify: 2s deadline fallback ──────────────────

test('scheduleLeaderNotify v2.7.25: 2s deadline commits even if leader never idles', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  attach2(orch, ctl, clock);

  // Keep leader busy for the entire duration: feed data and never flip to idle.
  ctl.firePaneData({ paneId: 'L', data: 'long assistant turn...\n' });
  assert.equal((orch as any).leaderIdle.isIdle, false);

  const writesBefore = leaderWrites(ctl).length;
  (orch as any).scheduleLeaderNotify('worker-3 joined. Route it normally.');

  // Sync arm did not commit (busy, elapsed=0).
  assert.equal(leaderWrites(ctl).length, writesBefore);

  // Simulate the gate polling. Each tick: advance BOTH the mock timer AND
  // the fake clock so `nowFn() - t0` measurable progress is visible to arm().
  // Re-feed data each time to keep leaderIdle busy (msSinceOutput stays low).
  for (let elapsed = 250; elapsed < 2000; elapsed += 250) {
    clock.advance(250);
    ctl.firePaneData({ paneId: 'L', data: 'more output\n' });
    t.mock.timers.tick(250);
    assert.equal(
      leaderWrites(ctl).length,
      writesBefore,
      `still busy + elapsed=${elapsed} < deadline → no commit`,
    );
  }

  // Cross the 2000ms deadline: clock.advance pushes elapsed past the cap.
  clock.advance(250); // now elapsed = 2000ms by fake clock
  ctl.firePaneData({ paneId: 'L', data: 'still streaming\n' });
  t.mock.timers.tick(250);

  const lWritesAfter = leaderWrites(ctl);
  assert.ok(
    lWritesAfter.length > writesBefore,
    'commit fired after 2s deadline even with leader still busy',
  );
  const commitText = lWritesAfter.slice(writesBefore).map((w) => w.data).join('');
  assert.ok(commitText.includes('worker-3 joined'), 'notify body committed at deadline');

  // Observability log: `waited=…ms`.
  const waitedLog = out.log.find((l) => l.includes('[orch.leaderNotify] committed'));
  assert.ok(waitedLog, 'committed log present');
  // The waited value should be ≥ 2000 (deadline) or at least in the 1750+ range.
  const match = /waited=(\d+)ms/.exec(waitedLog!);
  assert.ok(match, 'waited=Nms segment present in the commit log');
  const waited = Number(match![1]);
  assert.ok(waited >= 1750, `waited (${waited}ms) >= 1750ms (around the 2s deadline)`);

  t.mock.timers.reset();
  orch.dispose();
});

// ─── 9.B.11 · Dissolve × runtime-add ────────────────────────────────────

test('dissolve v2.7.25: add+dissolve includes runtime-added worker in summary input', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  type CapturedItem = { workerId: string; transcript: string };
  let capturedItems: CapturedItem[] | null = null;
  const stubSummarizer: Summarizer = async (items) => {
    const mapped: CapturedItem[] = items.map((i) => ({ workerId: i.workerId, transcript: i.transcript }));
    capturedItems = mapped;
    return '- worker-1: ok\n- worker-2: ok\n- worker-3: ok';
  };
  const orch = new PodiumOrchestrator(ctl.panel, out.channel, stubSummarizer);
  attach2(orch, ctl, clock);
  feedPrompt(ctl, 'L', 'claude');
  clock.advance(800);

  await orch.addWorker({ id: 'worker-3', paneId: 'worker-3', agent: 'claude' });

  // Feed each pane a distinctive transcript.
  // v0.7.4: transcript uses the assistant-only projector; prefix with
  // the `● ` bullet so the lines classify as assistant-start and land
  // in each worker's transcript.
  ctl.firePaneData({ paneId: 'W1', data: '● w1-transcript-marker\n' });
  ctl.firePaneData({ paneId: 'W2', data: '● w2-transcript-marker\n' });
  ctl.firePaneData({ paneId: 'worker-3', data: '● w3-transcript-marker\n' });

  const removedBefore = ctl.removed.length;
  await orch.dissolve();

  const items = capturedItems as CapturedItem[] | null;
  assert.ok(items, 'summarizer was called');
  const ids = (items as CapturedItem[]).map((i) => i.workerId).sort();
  assert.deepEqual(ids, ['worker-1', 'worker-2', 'worker-3'], 'all 3 workers summarized');

  const w3Item = (items as CapturedItem[]).find((i) => i.workerId === 'worker-3');
  assert.ok(w3Item, 'worker-3 present in summarizer input');
  assert.ok(
    (w3Item as CapturedItem).transcript.includes('w3-transcript-marker'),
    'worker-3 transcript captured for dissolve',
  );

  // Pane removed for worker-3 too.
  assert.ok(
    ctl.removed.includes('worker-3'),
    'worker-3 pane removed by dissolve',
  );
  assert.equal(
    ctl.removed.length - removedBefore,
    3,
    'all 3 worker panes removed',
  );
  assert.equal(orch.listWorkers().length, 0, 'workers map cleared post-dissolve');

  orch.dispose();
});

// ─── 9.B.12 · Dissolve × runtime-remove ─────────────────────────────────

test('dissolve v2.7.25: remove+dissolve excludes the removed worker from summary input', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  type CapturedItem = { workerId: string; transcript: string };
  let capturedItems: CapturedItem[] | null = null;
  const stubSummarizer: Summarizer = async (items) => {
    const mapped: CapturedItem[] = items.map((i) => ({ workerId: i.workerId, transcript: i.transcript }));
    capturedItems = mapped;
    return '- worker-2: ok';
  };
  const orch = new PodiumOrchestrator(ctl.panel, out.channel, stubSummarizer);
  attach2(orch, ctl, clock);
  feedPrompt(ctl, 'L', 'claude');
  clock.advance(800);

  // Feed worker-1 some data; then remove it.
  ctl.firePaneData({ paneId: 'W1', data: 'w1-old-transcript\n' });
  ctl.firePaneData({ paneId: 'W2', data: 'w2-transcript-survives\n' });

  await orch.removeWorker('worker-1');
  assert.equal(orch.listWorkers().length, 1);

  // Now dissolve the remaining team.
  await orch.dissolve();

  const items = capturedItems as CapturedItem[] | null;
  assert.ok(items);
  const ids = (items as CapturedItem[]).map((i) => i.workerId);
  assert.deepEqual(ids, ['worker-2'], 'only worker-2 in summarizer input');
  assert.equal(
    (items as CapturedItem[]).find((i) => i.workerId === 'worker-1'),
    undefined,
    'worker-1 NOT present (was removed before dissolve)',
  );

  // captureSnapshot after dissolve: workers cleared.
  const snap = orch.captureSnapshot();
  assert.equal(snap.workers.length, 0, 'snapshot workers array is empty after dissolve');

  orch.dispose();
});

// ─── 9.B.13 · add×3 + remove×1 + dissolve roundtrip ─────────────────────

test('dissolve v2.7.25: add×3 + remove×1 + dissolve passes exactly the remaining 4 workers to summarizer', async () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  let capturedIds: string[] | null = null;
  const stubSummarizer: Summarizer = async (items) => {
    const ids: string[] = items.map((i) => i.workerId);
    capturedIds = ids;
    return '- ok';
  };
  const orch = new PodiumOrchestrator(ctl.panel, out.channel, stubSummarizer);
  attach2(orch, ctl, clock); // starts with worker-1 + worker-2
  feedPrompt(ctl, 'L', 'claude');
  clock.advance(800);

  await orch.addWorker({ id: 'worker-3', paneId: 'worker-3', agent: 'claude' });
  await orch.addWorker({ id: 'worker-4', paneId: 'worker-4', agent: 'claude' });
  await orch.addWorker({ id: 'worker-5', paneId: 'worker-5', agent: 'claude' });
  assert.equal(orch.listWorkers().length, 5);

  await orch.removeWorker('worker-2');
  assert.equal(orch.listWorkers().length, 4);
  const remainingIds = orch.listWorkers().map((w) => w.cfg.id).sort();
  assert.deepEqual(remainingIds, ['worker-1', 'worker-3', 'worker-4', 'worker-5']);

  // Feed each remaining pane a distinctive transcript.
  for (const id of remainingIds) {
    const paneId = id === 'worker-1' ? 'W1' : id;
    ctl.firePaneData({ paneId, data: `${id}-marker\n` });
  }

  await orch.dissolve();

  const ids = capturedIds as string[] | null;
  assert.ok(ids);
  const sorted = [...(ids as string[])].sort();
  assert.deepEqual(
    sorted,
    ['worker-1', 'worker-3', 'worker-4', 'worker-5'],
    'summarizer got exactly the 4 surviving workers (order-agnostic)',
  );
  assert.equal(
    (ids as string[]).length,
    4,
    'exactly 4 entries — no worker-2 leakage, no phantom entries',
  );

  orch.dispose();
});

test('v2.7.27: isDisposed getter starts false after attach, flips true after dispose()', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude' }],
    skipAutoTick: true,
  });

  assert.equal(orch.isDisposed, false, 'orchestrator attached — not disposed');

  orch.dispose();

  assert.equal(orch.isDisposed, true, 'after dispose() — isDisposed is true');
});

test('v2.7.27: dispose() is idempotent — second call is no-op', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude' }],
    skipAutoTick: true,
  });

  orch.dispose();
  assert.equal(orch.isDisposed, true);

  assert.doesNotThrow(() => orch.dispose());
  assert.equal(orch.isDisposed, true, 'second dispose is a no-op, state stays disposed');
});

test('v2.7.27: listWorkers empty after dispose (registry cleanup invariant)', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude' },
      { id: 'worker-2', paneId: 'W2', agent: 'claude' },
    ],
    skipAutoTick: true,
  });

  assert.equal(orch.listWorkers().length, 2, 'two workers registered');

  orch.dispose();

  assert.equal(orch.listWorkers().length, 0, 'workers cleared on dispose');
  assert.equal(orch.isDisposed, true);
});

test('v2.7.28: restoreGraceMs drops routing directives emitted inside grace window (scrollback replay)', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude' }],
    skipAutoTick: true,
    now: clock.now,
    restoreGraceMs: 3000,
  });

  // Simulate Ink repaint of the leader's resumed scrollback:
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: hello-from-past\n' });

  // Within the grace window — must NOT write to worker-1's pty.
  clock.advance(1000);
  orch.tick();
  const writes = ctl.writes.filter((w) => w.paneId === 'W1');
  assert.equal(writes.length, 0, 'no worker-1 write inside grace window');
  // stats.dropped bumps via the restoreGrace branch.
  assert.ok(orch.snapshot.stats.dropped >= 1, 'at least one directive dropped by grace');

  orch.dispose();
});

test('v2.7.32: grace holds through leader silence + prompt pattern until wall-clock deadline', () => {
  // Regression against v2.7.29 + v2.7.31 design failures:
  //
  //  - v2.7.29 used `msSinceOutput >= 1s` → closed during post-spawn silence
  //    before scrollback burst arrived.
  //  - v2.7.31 used `isIdle` (prompt pattern + silence) → closed during
  //    post-welcome silence because Claude CLI paints the prompt box
  //    immediately on spawn, so hasPromptPattern() returns true from t=0.
  //
  // v2.7.32 closes on wall-clock deadline ONLY. This test proves the gate
  // can't be tripped by any combination of silence + prompt-patterned
  // output in the rolling tail before the deadline.
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude' }],
    skipAutoTick: true,
    now: clock.now,
    restoreGraceMs: 15000,
  });

  // Simulate Claude CLI's post-spawn welcome UI: prompt box painted first,
  // THEN a long silent gap while --resume loads the session. Pre-v2.7.32
  // this combination fired isIdle and closed grace with `dropped 0`.
  ctl.firePaneData({ paneId: 'L', data: '> \n[OMC#4.12.0] | ctx:4%\n⏵⏵ bypass permissions on\n' });
  for (let i = 0; i < 20; i++) {
    clock.advance(500); // 10s total of silence with prompt pattern visible
    orch.tick();
  }
  const closedTooEarly = out.log.filter((l) =>
    l.includes('[orch.restoreGrace] window closed'),
  );
  assert.equal(closedTooEarly.length, 0,
    'grace stays open despite prompt pattern + 10s silence (wall-clock < 15s)');

  // Scrollback replay finally lands. Directives must still be dropped.
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: replayed-late\n' });
  assert.ok(orch.snapshot.stats.dropped >= 1,
    'late-arriving scrollback directive dropped by grace');

  // Advance past the 15s wall-clock deadline (10s + 5.5s = 15.5s total).
  clock.advance(5500);
  orch.tick();
  const closeLogs = out.log.filter((l) =>
    l.includes('[orch.restoreGrace] window closed (deadline)'),
  );
  assert.equal(closeLogs.length, 1, 'grace closes via wall-clock deadline');
  assert.ok(
    closeLogs[0].includes('dropped 1 directive(s)') ||
      closeLogs[0].match(/dropped \d+ directive\(s\)/),
    'close message reports accurate drop count',
  );

  orch.dispose();
});

test('v2.7.33: grace-dropped directives are seeded into dedupe cache; post-close Ink redraws do NOT re-route', () => {
  // Field log 2026-04-22 after v2.7.32 shipped the wall-clock-only grace:
  //   [orch.restoreGrace] window closed (deadline) — dropped 2 directive(s)
  //   [parser yielded 2 msg(s)] banana, 1-to-5  <- user's NEW leader turn
  //   [orch] → worker-1: banana
  //   [orch] → worker-2: 1부터 5
  //   [parser yielded 4 msg(s)] apple, 1-to-10, banana, 1-to-5  <- Ink redraw
  //   [orch] queue worker-1 (busy, queue=1): "apple"  <- OLD re-routes!
  //   [orch] queue worker-2 (busy, queue=1): 1부터 10
  //
  // Root cause: Claude CLI's Ink UI repaints the full alt-screen on every
  // keystroke. Each repaint restreams the entire visible buffer, including
  // the PREVIOUS assistant response above the input box. The parser yields
  // those replayed `@worker-N: X` lines as fresh directives; dedupe had no
  // record of them (they were dropped, not routed), so they passed through
  // and got queued behind the genuinely new directives.
  //
  // Fix: when grace drops a directive, also seed
  // `worker.recentPayloads.set(payload, now)`. commitRoute() consults that
  // map and silently dedupes any payload found within `dedupeWindowMs`
  // (default 30s, well past the 15s grace window).
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude' },
      { id: 'worker-2', paneId: 'W2', agent: 'claude' },
    ],
    skipAutoTick: true,
    now: clock.now,
    restoreGraceMs: 1000,
  });

  // Scrollback replay: grace drops these.
  ctl.firePaneData({
    paneId: 'L',
    data: '● @worker-1: "apple"을 한글로 번역해줘\n@worker-2: 1부터 10까지의 합을 구해줘\n',
  });
  assert.equal(orch.snapshot.stats.dropped, 2, 'both replayed directives dropped by grace');

  // Close grace via wall-clock.
  clock.advance(1100);
  orch.tick();
  const closeLogs = out.log.filter((l) =>
    l.includes('[orch.restoreGrace] window closed (deadline)'),
  );
  assert.equal(closeLogs.length, 1, 'grace closed via deadline');

  const droppedBefore = orch.snapshot.stats.dropped;
  const dedupedBefore = orch.snapshot.stats.deduped ?? 0;
  const injectedBefore = orch.snapshot.stats.injected;
  const queuedBefore = orch.snapshot.stats.queued;

  // Simulate Ink redraw re-emitting the same scrollback content after grace
  // has closed (user typed a key, Ink repainted alt-screen which still
  // contains the prior assistant turn above the input box).
  ctl.firePaneData({
    paneId: 'L',
    data: '● @worker-1: "apple"을 한글로 번역해줘\n@worker-2: 1부터 10까지의 합을 구해줘\n',
  });

  const snap = orch.snapshot.stats;
  assert.equal(
    snap.injected,
    injectedBefore,
    'NO new injections after grace close (redraw must be deduped, not delivered)',
  );
  assert.equal(
    snap.queued,
    queuedBefore,
    'NO new queue entries after grace close (redraw must be deduped, not queued)',
  );
  assert.equal(
    snap.dropped,
    droppedBefore,
    'drop counter unchanged (grace is closed, drops stop)',
  );
  assert.ok(
    (snap.deduped ?? 0) >= dedupedBefore + 2,
    `deduped counter bumped by 2 for the redrawn directives (was ${dedupedBefore}, got ${snap.deduped})`,
  );

  const queueLogs = out.log.filter((l) =>
    l.match(/\[orch\] queue worker-[12] \(busy/),
  );
  assert.equal(queueLogs.length, 0, 'no worker queued from a replayed scrollback redraw');

  orch.dispose();
});

test('v2.7.32: grace closes via wall-clock deadline even when leader is actively emitting', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude' }],
    skipAutoTick: true,
    now: clock.now,
    restoreGraceMs: 3000,
  });

  // Leader continuously emits content every 500ms. v2.7.32 has no idle gate
  // at all — only wall-clock (restoreGraceMs=3000) closes the window.
  // Directives dropped throughout the 3s grace; routing activates on close.
  for (let i = 0; i < 8; i++) {
    ctl.firePaneData({ paneId: 'L', data: `● @worker-1: chunk-${i}\n` });
    clock.advance(500);
    orch.tick();
  }

  // By now ~4000ms elapsed — past the 3000ms deadline.
  const deadlineCloseLogs = out.log.filter((l) =>
    l.includes('[orch.restoreGrace] window closed (deadline)'),
  );
  assert.equal(deadlineCloseLogs.length, 1, 'grace closed via deadline reason (leader never settled)');

  orch.dispose();
});

test('v2.7.28: restoreGraceMs=0 leaves grace disarmed (isDisposed invariant sanity)', () => {
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [{ id: 'worker-1', paneId: 'W1', agent: 'claude' }],
    skipAutoTick: true,
    now: clock.now,
    restoreGraceMs: 0,
  });

  // With grace disarmed, stats.dropped must remain 0 even when the leader
  // emits a chunk that would have been replay-filtered in a restore context.
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: no-grace\n' });
  assert.equal(
    orch.snapshot.stats.dropped,
    0,
    'grace=0 never touches stats.dropped via restoreGrace branch',
  );

  orch.dispose();
});
