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
  const dir = path.join(cwd, '.omc/team/drops');
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
    .sort()
    .map((f) => path.join(dir, f));
}

function headerOf(filepath: string): Record<string, string> {
  const body = fs.readFileSync(filepath, 'utf8');
  const [headerBlock] = body.split(/\n---\n/, 1);
  const out: Record<string, string> = {};
  for (const line of headerBlock.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────

test('redelivery v0.9.3: distinct payloads to same worker are NOT linked', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock } = setupOrch(cwd);
    spill(ctl, clock, 'worker-1', 'implement parseCSV with RFC 4180 support and self-tests.');
    spill(ctl, clock, 'worker-1', 'now please also add a benchmark harness for the parser.');

    const drops = listDrops(cwd, 'to-worker-1-');
    assert.equal(drops.length, 2, 'both spills produced drop files');
    for (const d of drops) {
      const h = headerOf(d);
      assert.equal(h.redelivery_of, undefined, `drop wrongly tagged as retry: ${d}`);
      assert.equal(h.redelivery_count, undefined);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('redelivery v0.9.3: same payload twice within window → redelivery_of set, count=2', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock } = setupOrch(cwd);
    const body = 'implement parseCSV with RFC 4180 support and self-tests.';
    spill(ctl, clock, 'worker-1', body);
    clock.advance(30_000); // 30 s between — still well within 5-min window
    spill(ctl, clock, 'worker-1', body);

    const drops = listDrops(cwd, 'to-worker-1-');
    assert.equal(drops.length, 2);

    const first = headerOf(drops[0]);
    const second = headerOf(drops[1]);

    assert.equal(first.redelivery_of, undefined, 'first drop is original, not a retry');
    assert.ok(second.redelivery_of, `second drop must carry redelivery_of: ${JSON.stringify(second)}`);
    assert.ok(
      second.redelivery_of!.includes('to-worker-1-') && second.redelivery_of!.endsWith('.md'),
      `redelivery_of should point at a drop path: ${second.redelivery_of}`,
    );
    assert.equal(second.redelivery_count, '2');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('redelivery v0.9.3: triple retry chains — redelivery_count increments', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock } = setupOrch(cwd);
    const body = 'implement parseCSV with RFC 4180 support and self-tests.';
    spill(ctl, clock, 'worker-1', body);
    clock.advance(10_000);
    spill(ctl, clock, 'worker-1', body);
    clock.advance(10_000);
    spill(ctl, clock, 'worker-1', body);

    const drops = listDrops(cwd, 'to-worker-1-');
    assert.equal(drops.length, 3);

    const counts = drops.map((d) => headerOf(d).redelivery_count);
    // First drop: no count. Second: 2. Third: 3.
    assert.equal(counts[0], undefined);
    assert.equal(counts[1], '2');
    assert.equal(counts[2], '3');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('redelivery v0.9.3: same payload beyond window → NEW chain (no link)', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock } = setupOrch(cwd);
    const body = 'implement parseCSV with RFC 4180 support and self-tests.';
    spill(ctl, clock, 'worker-1', body);
    clock.advance(6 * 60_000); // 6 minutes — past the 5-min window
    spill(ctl, clock, 'worker-1', body);

    const drops = listDrops(cwd, 'to-worker-1-');
    assert.equal(drops.length, 2);
    // Neither drop carries redelivery metadata — the old one's
    // fingerprint was pruned before the second spill arrived.
    for (const d of drops) {
      const h = headerOf(d);
      assert.equal(h.redelivery_of, undefined, `past-window retry wrongly linked: ${d}`);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('redelivery v0.9.3: same payload to a different worker does NOT link', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, clock } = setupOrch(cwd);
    const body = 'implement parseCSV with RFC 4180 support and self-tests.';
    spill(ctl, clock, 'worker-1', body);
    clock.advance(10_000);
    spill(ctl, clock, 'worker-2', body);

    const w1 = listDrops(cwd, 'to-worker-1-');
    const w2 = listDrops(cwd, 'to-worker-2-');
    assert.equal(w1.length, 1);
    assert.equal(w2.length, 1);

    // Cross-worker with identical content is NOT a redelivery —
    // forensic question is "did worker-1 see retries?"
    assert.equal(headerOf(w1[0]).redelivery_of, undefined);
    assert.equal(headerOf(w2[0]).redelivery_of, undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
