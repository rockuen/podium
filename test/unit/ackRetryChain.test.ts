// v0.9.4 — ACK-mismatch-keyed redelivery detection.
//
// v0.9.3 shipped the redelivery infrastructure (header fields, chain
// counting, 5-min window). Its trigger — identical `tail_sha8` across
// two spills to the same worker — rarely fires in production because
// real-world retries ALWAYS slightly rewrite the payload (leader adds
// "retry:" prefix or appends an EOI marker). v0.9.4 adds a second,
// stronger trigger keyed on the v0.9.2 ACK-mismatch signal: when the
// worker echoed a fingerprint that didn't match the spilled one, the
// NEXT spill to that worker is presumably the leader's retry — tag
// it regardless of content similarity.
//
// The two triggers compose: whichever fires first tags the drop.
// Content-hash match stays for diagnostic completeness (catches
// synthetic / orchestrator-initiated re-sends); mismatch-keyed is the
// real-world catch.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
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
  return { event, fire: (e: T) => ls.forEach((l) => l(e)) };
}

interface FakePanelControl {
  writes: Array<{ paneId: string; data: string }>;
  firePaneData: (e: PaneDataEvent) => void;
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
  return { writes, firePaneData: dataEmit.fire, panel };
}

function makeOutput(): { log: string[]; channel: any } {
  const log: string[] = [];
  return {
    log,
    channel: {
      appendLine(s: string): void {
        log.push(s);
      },
    },
  };
}

function mkClock(start = 1000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function mkTmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'podium-retry-chain-'));
}

function expectedTail8(payload: string): string {
  const tail = payload.length <= 40 ? payload : payload.slice(-40);
  return createHash('sha256').update(tail, 'utf8').digest('hex').slice(0, 8);
}

function feedPrompt(ctl: FakePanelControl, paneId: string) {
  ctl.firePaneData({ paneId, data: '╰─────╯\n' });
}

function setupOrch(cwd: string) {
  const clock = mkClock();
  const ctl = makeFakePanel();
  const out = makeOutput();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude', sessionId: 'abc12345-rest' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100, role: 'implementer' },
      { id: 'worker-2', paneId: 'W2', agent: 'claude', silenceMs: 100, role: 'critic' },
    ],
    cwd,
    now: clock.now,
    skipAutoTick: true,
    enableWorkerRouting: true,
    enforceArtifactGate: false,
    // Disable cross-turn dedupe for tests — see dropRedelivery.test.ts
    // for the full rationale. Retry scenarios can have repeated content
    // in narrow time windows that production's dedupe would drop.
    dedupeWindowMs: 0,
  });
  feedPrompt(ctl, 'L');
  feedPrompt(ctl, 'W1');
  feedPrompt(ctl, 'W2');
  clock.advance(200);
  return { orch, ctl, out, clock };
}

function spill(
  ctl: FakePanelControl,
  clock: { advance: (ms: number) => void },
  workerId: string,
  payload: string,
) {
  // Use `● ` bullet prefix so the Claude projector classifies as
  // assistant-block-start reliably across consecutive spills. Without
  // it, after a prompt/chrome line the projector can stay in a
  // non-assistant state and drop the next plain `@target:` line.
  ctl.firePaneData({ paneId: 'L', data: `● @${workerId}: ${payload}\n` });
  clock.advance(2500);
  feedPrompt(ctl, 'L');
  const paneId = workerId === 'worker-1' ? 'W1' : 'W2';
  feedPrompt(ctl, paneId);
  clock.advance(200);
}

/**
 * Simulate the worker's reply with an ACK that either matches or
 * mismatches the spilled fingerprint. The match/mismatch is what the
 * orchestrator key off to start, extend, or break a retry chain.
 */
function replyWithAck(
  ctl: FakePanelControl,
  clock: { advance: (ms: number) => void },
  workerId: string,
  ack: { bytes: number; tail: string },
  tail = 'reply body here.',
) {
  const paneId = workerId === 'worker-1' ? 'W1' : 'W2';
  ctl.firePaneData({
    paneId,
    data: `@leader: ACK bytes=${ack.bytes} tail=${ack.tail} ${tail}\n`,
  });
  clock.advance(2500);
  feedPrompt(ctl, paneId);
  clock.advance(200);
}

function listDrops(cwd: string, prefix: string): string[] {
  const dir = path.join(cwd, '.omc/team/artifacts');
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
    .sort()
    .map((f) => path.join(dir, f));
}

// v0.12.0 — redelivery metadata moved out of file headers; tagged spills
// emit `[orch.redelivery] <worker> <mode> tagged redelivery_count=N
// (prior=<path>)` to the orchestrator's output channel.
function redeliveryEvents(
  log: string[],
  workerId: string,
): Array<{ count: number; prior: string }> {
  const re = new RegExp(
    `\\[orch\\.redelivery\\] ${workerId} \\S+ tagged redelivery_count=(\\d+) \\(prior=([^)]+)\\)`,
  );
  const events: Array<{ count: number; prior: string }> = [];
  for (const line of log) {
    const m = line.match(re);
    if (m) events.push({ count: Number(m[1]), prior: m[2] });
  }
  return events;
}

// ───────────────────────────────────────────────────────────────────

test.skip('retry-chain v0.9.4: ACK match → next spill NOT tagged as retry', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock, out } = setupOrch(cwd);

    const body1 = 'implement parseCSV with RFC 4180 support.';
    spill(ctl, clock, 'worker-1', body1);
    // Worker ACKs the correct fingerprint → chain never starts.
    replyWithAck(ctl, clock, 'worker-1', {
      bytes: Buffer.byteLength(body1, 'utf8'),
      tail: expectedTail8(body1),
    });

    const body2 = 'now add a benchmark harness.';
    spill(ctl, clock, 'worker-1', body2);

    const drops = listDrops(cwd, 'auto-to-worker-1-');
    assert.equal(drops.length, 2);
    assert.deepEqual(redeliveryEvents(out.log, 'worker-1'), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test.skip('retry-chain v0.9.4: ACK mismatch → next spill tagged redelivery_count=2', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock, out } = setupOrch(cwd);

    const body1 = 'implement parseCSV with RFC 4180 support.';
    spill(ctl, clock, 'worker-1', body1);
    // Worker received a truncated version → wrong byte count, wrong tail.
    replyWithAck(ctl, clock, 'worker-1', { bytes: 123, tail: 'deadbeef' });

    // Leader retries with DIFFERENT content (real-world: adds a
    // "retry:" prefix and an EOI marker so it doesn't dedupe).
    const body2 = 'retry: ' + body1 + ' ZZZ_EOI_ZZZ.';
    spill(ctl, clock, 'worker-1', body2);

    const drops = listDrops(cwd, 'auto-to-worker-1-');
    assert.equal(drops.length, 2);
    const events = redeliveryEvents(out.log, 'worker-1');
    assert.equal(events.length, 1, 'second spill must be tagged');
    assert.equal(events[0].count, 2);
    assert.ok(
      events[0].prior.endsWith(path.basename(drops[0])),
      `prior should point at drop1: ${events[0].prior}`,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test.skip('retry-chain v0.9.4: repeated mismatches extend the chain (count=3)', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock, out } = setupOrch(cwd);

    const b1 = 'implement parseCSV.';
    spill(ctl, clock, 'worker-1', b1);
    replyWithAck(ctl, clock, 'worker-1', { bytes: 1, tail: 'aaaaaaaa' });

    const b2 = 'retry 1: implement parseCSV with markers. EOI.';
    spill(ctl, clock, 'worker-1', b2);
    replyWithAck(ctl, clock, 'worker-1', { bytes: 2, tail: 'bbbbbbbb' });

    const b3 = 'retry 2: truly final version. EOI2.';
    spill(ctl, clock, 'worker-1', b3);

    const drops = listDrops(cwd, 'auto-to-worker-1-');
    assert.equal(drops.length, 3);
    const events = redeliveryEvents(out.log, 'worker-1');
    assert.equal(events.length, 2, 'second and third spills are tagged');
    assert.equal(events[0].count, 2);
    assert.equal(events[1].count, 3);
    assert.ok(
      events[1].prior.endsWith(path.basename(drops[1])),
      'spill3 prior should point at drop2 (the most recent prior)',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test.skip('retry-chain v0.9.4: MATCH after earlier mismatch breaks the chain', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock, out } = setupOrch(cwd);

    const b1 = 'implement parseCSV.';
    spill(ctl, clock, 'worker-1', b1);
    replyWithAck(ctl, clock, 'worker-1', { bytes: 1, tail: 'aaaaaaaa' }); // mismatch

    const b2 = 'retry: implement parseCSV with markers. EOI.';
    spill(ctl, clock, 'worker-1', b2);
    // This time ACK matches — chain should clear.
    replyWithAck(ctl, clock, 'worker-1', {
      bytes: Buffer.byteLength(b2, 'utf8'),
      tail: expectedTail8(b2),
    });

    const b3 = 'now run the benchmark.'; // unrelated new task
    spill(ctl, clock, 'worker-1', b3);

    const drops = listDrops(cwd, 'auto-to-worker-1-');
    assert.equal(drops.length, 3);
    const events = redeliveryEvents(out.log, 'worker-1');
    // Only the second spill is tagged (mismatch chain). The third spill
    // (after the matching ACK) must NOT be tagged.
    assert.equal(events.length, 1, 'spill3 must not be tagged after match');
    assert.equal(events[0].count, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test.skip('retry-chain v0.9.4: mismatch past window → new chain starts fresh', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock, out } = setupOrch(cwd);

    const b1 = 'implement parseCSV.';
    spill(ctl, clock, 'worker-1', b1);
    replyWithAck(ctl, clock, 'worker-1', { bytes: 1, tail: 'aaaaaaaa' }); // mismatch

    clock.advance(6 * 60_000); // 6 min — past the 5-min window

    const b2 = 'retry: implement parseCSV with markers.';
    spill(ctl, clock, 'worker-1', b2);

    const drops = listDrops(cwd, 'auto-to-worker-1-');
    assert.equal(drops.length, 2);
    assert.deepEqual(
      redeliveryEvents(out.log, 'worker-1'),
      [],
      'past-window mismatch must not tag next spill',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test.skip('retry-chain v0.9.4: mismatch on worker-1 does NOT tag spill to worker-2', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock, out } = setupOrch(cwd);

    const b1 = 'implement parseCSV.';
    spill(ctl, clock, 'worker-1', b1);
    replyWithAck(ctl, clock, 'worker-1', { bytes: 1, tail: 'aaaaaaaa' }); // mismatch on worker-1

    // Unrelated task to worker-2 — per-worker scope must hold.
    const b2 = 'review the CSV parser design.';
    spill(ctl, clock, 'worker-2', b2);

    const w2Drops = listDrops(cwd, 'auto-to-worker-2-');
    assert.equal(w2Drops.length, 1);
    assert.deepEqual(
      redeliveryEvents(out.log, 'worker-2'),
      [],
      'cross-worker mismatch must not tag',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});