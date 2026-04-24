// v0.9.2 — worker ACK round-trip (completes N3 from the 2026-04-24 retro).
//
// After v0.9.1 embeds `(bytes=N tail=XXXX)` in the path-first notice,
// workers are expected to echo `ACK bytes=N tail=XXXX` as the first
// token of their next `@leader:` reply. This test suite covers the
// orchestrator-side parser: comparing the echoed values against the
// fingerprint the orch originally spilled, and logging a clear warn
// line on mismatch so truncation is detectable in real time (the very
// signal the parseCSV session recovered manually via prompt discipline).
//
// Worker cooperation is best-effort: a missing or malformed ACK is NOT
// an error. This prevents the feature from becoming false-positive noise
// when a worker skips the ACK convention.

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'podium-ack-'));
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
    ],
    cwd,
    now: clock.now,
    skipAutoTick: true,
    enableWorkerRouting: true,
  });
  feedPrompt(ctl, 'L');
  feedPrompt(ctl, 'W1');
  clock.advance(200);
  return { orch, ctl, out, clock };
}

/** Spill a directive to worker-1 and return the fingerprint the orch sent. */
function spillDirective(ctl: FakePanelControl, payload: string) {
  ctl.firePaneData({ paneId: 'L', data: `@worker-1: ${payload}\n` });
  return { bytes: Buffer.byteLength(payload, 'utf8'), tail: expectedTail8(payload) };
}

/** Emit a worker→leader reply and drive the commit pipeline to flush. */
function emitWorkerReply(ctl: FakePanelControl, clock: ReturnType<typeof mkClock>, replyBody: string) {
  ctl.firePaneData({ paneId: 'W1', data: `@leader: ${replyBody}\n` });
  // Give the debounce timer time to fire.
  clock.advance(2500);
  feedPrompt(ctl, 'W1');
  clock.advance(200);
}

// ───────────────────────────────────────────────────────────────────

test('ack v0.9.2: matching ACK logs a match line and does not warn', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, out, clock } = setupOrch(cwd);
    const fp = spillDirective(ctl, 'implement parseCSV with RFC 4180 support and self-tests.');

    emitWorkerReply(ctl, clock, `ACK bytes=${fp.bytes} tail=${fp.tail} 구현 완료.`);

    const matchLine = out.log.find((l) => l.includes('[orch.ack]') && l.includes('match'));
    const mismatchLine = out.log.find((l) => l.includes('[orch.ack]') && /mismatch|MISMATCH/.test(l));
    assert.ok(matchLine, `expected [orch.ack] match log; got:\n${out.log.join('\n')}`);
    assert.ok(!mismatchLine, 'must not emit mismatch on valid ACK');
    // Match line should include the worker id and fingerprint for forensics.
    assert.match(matchLine!, /worker-1/);
    assert.ok(matchLine!.includes(`bytes=${fp.bytes}`));
    assert.ok(matchLine!.includes(`tail=${fp.tail}`));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('ack v0.9.2: mismatching ACK emits MISMATCH warn with both values', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, out, clock } = setupOrch(cwd);
    const fp = spillDirective(ctl, 'implement parseCSV with RFC 4180 support and self-tests.');

    // Worker received a truncated version — echoes back a shorter byte
    // count and a different tail hash.
    const truncatedBytes = 169;
    const wrongTail = 'deadbeef';
    emitWorkerReply(ctl, clock, `ACK bytes=${truncatedBytes} tail=${wrongTail} 구현 완료.`);

    const mismatchLine = out.log.find((l) => l.includes('[orch.ack]') && /MISMATCH/.test(l));
    assert.ok(mismatchLine, `expected MISMATCH log; got:\n${out.log.join('\n')}`);
    // Must include both expected and received fingerprints so the user
    // can diagnose the truncation scale.
    assert.ok(
      mismatchLine!.includes(`expected bytes=${fp.bytes}`),
      `missing expected bytes: ${mismatchLine}`,
    );
    assert.ok(
      mismatchLine!.includes(`got bytes=${truncatedBytes}`),
      `missing got bytes: ${mismatchLine}`,
    );
    assert.ok(mismatchLine!.includes(`tail=${fp.tail}`));
    assert.ok(mismatchLine!.includes(`tail=${wrongTail}`));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('ack v0.9.2: reply without ACK line is silently accepted', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, out, clock } = setupOrch(cwd);
    spillDirective(ctl, 'implement parseCSV with RFC 4180 support and self-tests.');

    emitWorkerReply(ctl, clock, '구현 완료. 10/10 테스트 통과.');

    const ackLines = out.log.filter((l) => l.includes('[orch.ack]'));
    assert.deepEqual(
      ackLines,
      [],
      `ACK absence must be silent, but got: ${ackLines.join(' | ')}`,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('ack v0.9.2: ACK without a prior spill is ignored (no false positives)', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, out, clock } = setupOrch(cwd);
    // No spillDirective — orchestrator has no pending fingerprint.
    emitWorkerReply(ctl, clock, 'ACK bytes=123 tail=cafebabe spurious ACK');

    const ackLines = out.log.filter((l) => l.includes('[orch.ack]'));
    // Unsolicited ACK should not produce warn, because we have nothing
    // to compare against. At most a single informational "no pending"
    // line is acceptable; MISMATCH is not.
    const mismatchLines = ackLines.filter((l) => /MISMATCH/.test(l));
    assert.equal(
      mismatchLines.length,
      0,
      `spurious ACK must not raise MISMATCH: ${mismatchLines.join(' | ')}`,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
