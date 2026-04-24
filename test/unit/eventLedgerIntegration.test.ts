// v0.9.5 — Orchestrator ↔ EventLogger integration tests.
//
// Exercise the real PodiumOrchestrator with an EventLogger wired in and
// verify that each hook point (session start, route commit, drop written,
// ack match/mismatch, redelivery tagged) produces the expected NDJSON
// envelope. The orchestrator runs under `node --test` without any VS Code
// runtime — same pattern as `podiumOrchestrator.test.ts`.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PodiumOrchestrator } from '../../src/orchestration/core/PodiumOrchestrator';
import { EventLogger, type EventEnvelope } from '../../src/orchestration/core/EventLogger';
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
  ctl.firePaneData({ paneId, data: '╰─────╯\n' });
}

function readLedger(cwd: string): EventEnvelope[] {
  const file = path.join(cwd, '.omc', 'team', 'logs', 'orchestrator.ndjson');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EventEnvelope);
}

test('ledger: session.started fires on attach with leader/worker snapshot', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-ledger-'));
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const logger = new EventLogger({ cwd, podiumSessionId: 'podium-sess-1' });
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude', sessionId: 'leader-uuid' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100 },
    ],
    cwd,
    now: clock.now,
    skipAutoTick: true,
    eventLogger: logger,
  });

  const events = readLedger(cwd);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'session.started');
  assert.equal(events[0].podiumSessionId, 'podium-sess-1');
  assert.equal(events[0].source?.kind, 'orchestrator');
  // Leader/worker descriptors carry the provider id as a data field, not as a
  // baked-in type. The ledger must be able to describe a Codex leader with an
  // unchanged schema.
  const p = events[0].payload as any;
  assert.equal(p.leader.provider, 'claude');
  assert.equal(p.workers[0].id, 'worker-1');
  assert.equal(p.workers[0].provider, 'claude');

  orch.dispose();
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('ledger: route.committed fires on leader→worker routing', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-ledger-'));
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const logger = new EventLogger({ cwd, podiumSessionId: 'podium-sess-1' });
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100 },
    ],
    cwd,
    now: clock.now,
    skipAutoTick: true,
    eventLogger: logger,
  });

  feedPrompt(ctl, 'W1');
  clock.advance(200);
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: do something\n' });

  const events = readLedger(cwd);
  const routeCommits = events.filter((e) => e.type === 'route.committed');
  assert.equal(routeCommits.length, 1);
  assert.equal(routeCommits[0].source?.kind, 'leader');
  assert.equal(routeCommits[0].target?.kind, 'worker');
  assert.equal(routeCommits[0].target?.id, 'worker-1');
  assert.equal((routeCommits[0].payload as any).direction, 'leader-to-worker');

  orch.dispose();
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('ledger: drop.written fires for leader→worker spill (every delegation)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-ledger-'));
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const logger = new EventLogger({ cwd, podiumSessionId: 'podium-sess-1' });
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100 },
    ],
    cwd,
    now: clock.now,
    skipAutoTick: true,
    eventLogger: logger,
  });

  feedPrompt(ctl, 'W1');
  clock.advance(200);
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: quick task\n' });

  const events = readLedger(cwd);
  const drops = events.filter((e) => e.type === 'drop.written');
  assert.equal(drops.length, 1);
  const p = drops[0].payload as any;
  assert.equal(p.direction, 'leader-to-worker');
  assert.ok(
    typeof p.dropPath === 'string' && p.dropPath.includes('to-worker-1-turn'),
    `dropPath should point at to-worker-1-turn*.md, got ${p.dropPath}`,
  );
  assert.equal(typeof p.bytes, 'number');
  assert.equal(typeof p.tail_sha8, 'string');

  orch.dispose();
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('ledger: ack.match fires when worker reply echoes the expected fingerprint', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-ledger-'));
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const logger = new EventLogger({ cwd, podiumSessionId: 'podium-sess-1' });
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 50 },
    ],
    cwd,
    now: clock.now,
    skipAutoTick: true,
    enableWorkerRouting: true,
    dispatchDebounceMs: 0,
    eventLogger: logger,
  });

  feedPrompt(ctl, 'L');
  feedPrompt(ctl, 'W1');
  clock.advance(200);

  // Leader delegates — this arms the ACK fingerprint for worker-1.
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: delegated task\n' });
  clock.advance(200);

  // Locate the armed fingerprint by reading the drop file the orch wrote.
  const dropDir = path.join(cwd, '.omc', 'team', 'drops');
  const files = fs.readdirSync(dropDir).filter((f) => f.startsWith('to-worker-1-turn'));
  assert.equal(files.length, 1);
  const dropContent = fs.readFileSync(path.join(dropDir, files[0]), 'utf8');
  const bytesMatch = dropContent.match(/^bytes:\s*(\d+)/m);
  const tailMatch = dropContent.match(/^tail_sha8:\s*([0-9a-f]{8})/m);
  assert.ok(bytesMatch && tailMatch, 'drop file must expose the fingerprint');
  const expectedBytes = bytesMatch![1];
  const expectedTail = tailMatch![1];

  // Worker echoes the ACK verbatim — this triggers maybeConsumeAck → match.
  ctl.firePaneData({
    paneId: 'W1',
    data: `@leader: ACK bytes=${expectedBytes} tail=${expectedTail} understood.\n`,
  });
  clock.advance(200);

  const events = readLedger(cwd);
  const matches = events.filter((e) => e.type === 'ack.match');
  assert.equal(matches.length, 1, `expected 1 ack.match, got ${matches.length}`);
  const p = matches[0].payload as any;
  assert.equal(p.bytes, Number(expectedBytes));
  assert.equal(p.tail_sha8, expectedTail);

  orch.dispose();
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('ledger: ack.mismatch fires with warn level when fingerprints disagree', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-ledger-'));
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const logger = new EventLogger({ cwd, podiumSessionId: 'podium-sess-1' });
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 50 },
    ],
    cwd,
    now: clock.now,
    skipAutoTick: true,
    enableWorkerRouting: true,
    dispatchDebounceMs: 0,
    eventLogger: logger,
  });

  feedPrompt(ctl, 'L');
  feedPrompt(ctl, 'W1');
  clock.advance(200);
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: delegated task\n' });
  clock.advance(200);

  // Worker echoes an intentionally wrong fingerprint.
  ctl.firePaneData({
    paneId: 'W1',
    data: '@leader: ACK bytes=1 tail=deadbeef truncated.\n',
  });
  clock.advance(200);

  const events = readLedger(cwd);
  const mismatches = events.filter((e) => e.type === 'ack.mismatch');
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].level, 'warn');
  const p = mismatches[0].payload as any;
  assert.equal(p.got.tail_sha8, 'deadbeef');
  assert.ok(p.expected.tail_sha8.length === 8);

  orch.dispose();
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('ledger: no-logger mode leaves routing untouched (zero events on disk)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-ledger-'));
  const ctl = makeFakePanel();
  const out = makeOutputChannel();
  const clock = mkClock();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100 },
    ],
    cwd,
    now: clock.now,
    skipAutoTick: true,
    // eventLogger intentionally omitted
  });

  feedPrompt(ctl, 'W1');
  clock.advance(200);
  ctl.firePaneData({ paneId: 'L', data: '● @worker-1: do something\n' });

  const ledgerFile = path.join(cwd, '.omc', 'team', 'logs', 'orchestrator.ndjson');
  assert.equal(fs.existsSync(ledgerFile), false, 'ledger file must not be created when no logger');
  // Routing still worked — at least one write to the worker pane happened.
  assert.ok(ctl.writes.length >= 1, 'routing must still function without a logger');

  orch.dispose();
  fs.rmSync(cwd, { recursive: true, force: true });
});
