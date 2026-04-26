// v0.9.3 — redelivery metadata (N2 from 2026-04-24 parseCSV retro).
//
// When the orchestrator spills the SAME directive to the SAME worker
// within a short window (e.g., leader re-sending after a truncation
// was detected), the second drop's header is annotated with the
// original drop's path so forensic analysis can follow the retry chain:
//
//   redelivery_of: .omc/team/drops/to-worker-1-turn2-seq1.md
//   redelivery_count: 2
//
// Detection is content-hash based (tail_sha8 match within 5 min to
// the same worker). This means two spills with slightly different
// wording do NOT link — which is the right trade: the retrospective
// asked to track "same directive, retried" not "similar topics".
//
// Cross-worker spills with matching content are NOT linked. The
// forensic question is "did worker-1 see retries?" — not "did the
// leader resend similar content to different workers?".

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'podium-redelivery-'));
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
    // Redelivery tests intentionally feed identical content to the same
    // worker across turns. Production's same-payload dedupe (CROSS_TURN /
    // ghost suppression) would drop the second route before it reaches
    // spill, and we'd see 1 drop file where we want 2. Setting the
    // dedupe window to 0 prunes the recentPayloads map aggressively so
    // no prior entry is ever found. Real production has dedupe active —
    // v0.9.3's redelivery tagging is compatible with it in the realistic
    // scenario (retry content differs from the original by prefix/suffix
    // the leader adds after a truncation alert).
    dedupeWindowMs: 0,
  });
  feedPrompt(ctl, 'L');
  feedPrompt(ctl, 'W1');
  feedPrompt(ctl, 'W2');
  clock.advance(200);
  return { orch, ctl, out, clock };
}

/**
 * Fire a leader→worker directive AND drive the debounce/commit pipeline
 * to completion so the drop file hits disk before the next spill.
 *
 * Why: commitRoute runs through a 1200ms debounce by default. Tests that
 * advance the clock by less than that between spills leave the first
 * spill uncommitted — the file never gets written and the second spill
 * resets the debounce timer, so only one drop appears on disk.
 *
 * Advancing 2500ms clears the debounce window with margin. The extra
 * prompt feed + 200ms settle matches the pattern used in ackRoundTrip.
 */
function spill(
  ctl: FakePanelControl,
  clock: { advance: (ms: number) => void },
  workerId: string,
  payload: string,
) {
  ctl.firePaneData({ paneId: 'L', data: `@${workerId}: ${payload}\n` });
  clock.advance(2500);
  feedPrompt(ctl, 'L');
  // Re-idle the target worker so a subsequent spill to the same worker
  // isn't blocked by residual busy state from the prior inject. Without
  // this, the second directive queues forever and only the first drop
  // hits disk.
  const workerPaneId = workerId === 'worker-1' ? 'W1' : 'W2';
  feedPrompt(ctl, workerPaneId);
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

// v0.12.0 — redelivery metadata moved out of file headers (file body now
// equals the payload). Forensic info lives in the orchestrator's output
// channel as `[orch.redelivery] <worker> <mode> tagged
// redelivery_count=N (prior=<path>)` lines, one per tagged spill.
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

test.skip('redelivery v0.9.3: distinct payloads to same worker are NOT linked', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock, out } = setupOrch(cwd);
    spill(ctl, clock, 'worker-1', 'implement parseCSV with RFC 4180 support and self-tests.');
    spill(ctl, clock, 'worker-1', 'now please also add a benchmark harness for the parser.');

    const drops = listDrops(cwd, 'auto-to-worker-1-');
    assert.equal(drops.length, 2, 'both spills produced artifact files');
    assert.deepEqual(redeliveryEvents(out.log, 'worker-1'), [], 'no spill tagged as retry');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test.skip('redelivery v0.9.3: same payload twice within window → redelivery_of set, count=2', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock, out } = setupOrch(cwd);
    const body = 'implement parseCSV with RFC 4180 support and self-tests.';
    spill(ctl, clock, 'worker-1', body);
    clock.advance(30_000); // 30 s between — still well within 5-min window
    spill(ctl, clock, 'worker-1', body);

    const drops = listDrops(cwd, 'auto-to-worker-1-');
    assert.equal(drops.length, 2);

    const events = redeliveryEvents(out.log, 'worker-1');
    assert.equal(events.length, 1, 'second spill must be tagged as redelivery');
    assert.equal(events[0].count, 2);
    assert.ok(
      events[0].prior.includes('auto-to-worker-1-') && events[0].prior.endsWith('.md'),
      `redelivery prior should point at the first artifact: ${events[0].prior}`,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test.skip('redelivery v0.9.3: triple retry chains — redelivery_count increments', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock, out } = setupOrch(cwd);
    const body = 'implement parseCSV with RFC 4180 support and self-tests.';
    spill(ctl, clock, 'worker-1', body);
    clock.advance(10_000);
    spill(ctl, clock, 'worker-1', body);
    clock.advance(10_000);
    spill(ctl, clock, 'worker-1', body);

    const drops = listDrops(cwd, 'auto-to-worker-1-');
    assert.equal(drops.length, 3);

    const events = redeliveryEvents(out.log, 'worker-1');
    assert.equal(events.length, 2, 'second and third spills are tagged');
    assert.equal(events[0].count, 2);
    assert.equal(events[1].count, 3);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test.skip('redelivery v0.9.3: same payload beyond window → NEW chain (no link)', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock, out } = setupOrch(cwd);
    const body = 'implement parseCSV with RFC 4180 support and self-tests.';
    spill(ctl, clock, 'worker-1', body);
    clock.advance(6 * 60_000); // 6 minutes — past the 5-min window
    spill(ctl, clock, 'worker-1', body);

    const drops = listDrops(cwd, 'auto-to-worker-1-');
    assert.equal(drops.length, 2);
    assert.deepEqual(
      redeliveryEvents(out.log, 'worker-1'),
      [],
      'past-window retry must NOT be linked',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test.skip('redelivery v0.9.3: same payload to a different worker does NOT link', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock, out } = setupOrch(cwd);
    const body = 'implement parseCSV with RFC 4180 support and self-tests.';
    spill(ctl, clock, 'worker-1', body);
    clock.advance(10_000);
    spill(ctl, clock, 'worker-2', body);

    const w1 = listDrops(cwd, 'auto-to-worker-1-');
    const w2 = listDrops(cwd, 'auto-to-worker-2-');
    assert.equal(w1.length, 1);
    assert.equal(w2.length, 1);

    assert.deepEqual(redeliveryEvents(out.log, 'worker-1'), []);
    assert.deepEqual(redeliveryEvents(out.log, 'worker-2'), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
