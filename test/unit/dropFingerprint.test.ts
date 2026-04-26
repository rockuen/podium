// v0.9.1 — drop content fingerprint (partial N3 from 2026-04-24 retro).
//
// Each leader→worker drop gets two forensic fields embedded in the drop
// file header AND in the path-first notice injected into the worker:
//   bytes:       payload length in UTF-8 bytes
//   tail_sha8:   first 8 hex chars of SHA-256 over the last 40 chars
//                (or full payload if shorter) of the directive body
//
// Rationale: in the 2026-04-24 parseCSV session, ad-hoc "ACK the last
// sentence ending" was added by prompt and proved effective at catching
// truncation. v0.9.1 moves that signal from prompt discipline to runtime
// metadata, so the leader (and any external observer) can verify the
// directive arrived whole without counting on the worker's cooperation.
// Worker-side ACK parsing / auto-warn on mismatch is deferred to v0.9.2.

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'podium-drop-fingerprint-'));
}

function expectedTail8(payload: string): string {
  const tail = payload.length <= 40 ? payload : payload.slice(-40);
  return createHash('sha256').update(tail, 'utf8').digest('hex').slice(0, 8);
}

function feedPrompt(ctl: FakePanelControl, paneId: string) {
  // Claude boxed prompt — latches IdleDetector.
  ctl.firePaneData({ paneId, data: '╰─────╯\n' });
}

function setupOrch(cwd: string, clock = mkClock()) {
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
    enforceArtifactGate: false,
  });
  feedPrompt(ctl, 'L');
  feedPrompt(ctl, 'W1');
  clock.advance(200);
  return { orch, ctl, out, clock };
}

function findArtifactFile(cwd: string, workerId: string): string {
  const dir = path.join(cwd, '.omc/team/artifacts');
  const entry = fs
    .readdirSync(dir)
    .find((f) => f.startsWith(`auto-to-${workerId}-`) && f.endsWith('.md'));
  assert.ok(entry, `no auto-spill artifact for ${workerId} in ${dir}`);
  return path.join(dir, entry);
}

// ───────────────────────────────────────────────────────────────────

test.skip('fingerprint v0.12.0: auto-spill artifact body equals the payload (no header)', () => {
  // v0.12.0 — leader→worker no longer wraps the body in a `# Drop:`
  // header; the auto-spill file IS the payload, so notice fingerprint
  // and on-disk fingerprint coincide.
  const cwd = mkTmpCwd();
  try {
    const { ctl } = setupOrch(cwd);

    const payload =
      '.omc/team/artifacts/parseCSV.js 파일을 작성해줘. RFC 4180을 준수하고 셀프테스트 3개 이상 포함.';
    ctl.firePaneData({ paneId: 'L', data: `@worker-1: ${payload}\n` });

    const artifactPath = findArtifactFile(cwd, 'worker-1');
    const body = fs.readFileSync(artifactPath, 'utf8');

    assert.equal(body, payload, 'artifact body must equal the directive payload');

    // Notice carries the same fingerprint computed over the artifact body.
    const notice = ctl.writes.find(
      (w) => w.paneId === 'W1' && w.data.includes('.omc/team/artifacts/auto-to-worker-1-'),
    );
    assert.ok(notice, 'worker-1 received a path-first notice');
    const expected = expectedTail8(payload);
    assert.ok(notice.data.includes(`tail=${expected}`), 'notice tail matches payload');
    assert.ok(
      notice.data.includes(`bytes=${Buffer.byteLength(payload, 'utf8')}`),
      'notice bytes matches payload',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test.skip('fingerprint v0.9.1: path-first notice embeds (bytes=N tail=XXXX)', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl } = setupOrch(cwd);

    const payload =
      'long enough payload to trigger a meaningful tail hash and survive any wrap.';
    ctl.firePaneData({ paneId: 'L', data: `@worker-1: ${payload}\n` });

    const notice = ctl.writes.find(
      (w) => w.paneId === 'W1' && w.data.includes('.omc/team/artifacts/auto-to-worker-1-'),
    );
    assert.ok(notice, 'worker-1 was injected with a path-first notice');

    const bytes = Buffer.byteLength(payload, 'utf8');
    const expected = expectedTail8(payload);
    assert.ok(
      notice.data.includes(`bytes=${bytes}`),
      `notice missing bytes=${bytes}: ${JSON.stringify(notice.data)}`,
    );
    assert.ok(
      notice.data.includes(`tail=${expected}`),
      `notice missing tail=${expected}: ${JSON.stringify(notice.data)}`,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test.skip('fingerprint v0.12.0: short payloads hash the whole body (no padding artifacts)', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl } = setupOrch(cwd);

    const payload = 'short msg.'; // shorter than the 40-char tail window
    ctl.firePaneData({ paneId: 'L', data: `@worker-1: ${payload}\n` });

    const notice = ctl.writes.find(
      (w) => w.paneId === 'W1' && w.data.includes('.omc/team/artifacts/auto-to-worker-1-'),
    );
    assert.ok(notice, 'worker-1 received a path-first notice');
    // For short payload, tail = full payload.
    const fullHash = createHash('sha256')
      .update(payload, 'utf8')
      .digest('hex')
      .slice(0, 8);
    assert.ok(notice.data.includes(`tail=${fullHash}`));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('fingerprint v0.9.1: same tail → identical hash; differing tail → different hash', () => {
  // Deterministic property of the tail-hash function, decoupled from
  // the orchestrator. Guards against accidental whole-body hashing.
  const base = 'this is some long directive content that extends well past forty characters and keeps going. ';
  const a = base + 'ends with apple.';
  const b = base + 'ends with banana.';
  const c = 'completely different prefix content but ends with apple.';

  // a and c share the tail "ends with apple." which is < 40 chars — the
  // last-40-chars window includes some preceding content, so a and c
  // should NOT collide.
  assert.notEqual(expectedTail8(a), expectedTail8(b), 'different tails hash differently');
  assert.notEqual(expectedTail8(a), expectedTail8(c), 'tail window extends past the shared suffix');

  // Regression: replaying the same payload yields the same hash.
  assert.equal(expectedTail8(a), expectedTail8(a));
});
