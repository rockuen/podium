// v0.12.0 — Hard reject for directives without an artifact path.
//
// Production rule: every "@worker-N: <body>" or "@leader: <body>"
// directive must reference a `.omc/team/artifacts/<file>.md` path that
// resolves to an existing file on disk. Otherwise the orchestrator
// REJECTS the route — the worker (or leader) is not injected, and a
// `[orch.reject]` notice is bounced back to the directive's source
// pane so the author can re-emit with a Write-tool artifact.
//
// These tests exercise the gate in production mode (default
// enforceArtifactGate: true) to confirm:
//   1. Missing-path directive is rejected, source pane gets a notice.
//   2. Path-but-missing-file directive is rejected.
//   3. Valid path + existing file passes through to a normal inject.
//   4. The same rules apply to worker→leader replies (symmetric).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
      appendLine(s: string) {
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'podium-gate-'));
}

function feedPrompt(ctl: FakePanelControl, paneId: string) {
  ctl.firePaneData({ paneId, data: '╰─────╯\n' });
}

function setupOrch(cwd: string) {
  const clock = mkClock();
  const ctl = makeFakePanel();
  const out = makeOutput();
  const orch = new PodiumOrchestrator(ctl.panel, out.channel);
  // v0.15.0 — gate default flipped to false. Tests in this file
  // explicitly opt-in to the gate to verify reject behavior.
  orch.attach({
    leader: { paneId: 'L', agent: 'claude', sessionId: 'leader-uuid' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100, role: 'implementer' },
    ],
    cwd,
    now: clock.now,
    skipAutoTick: true,
    enableWorkerRouting: true,
    enforceArtifactGate: true,
    dispatchDebounceMs: 0,
  });
  feedPrompt(ctl, 'L');
  feedPrompt(ctl, 'W1');
  clock.advance(200);
  return { orch, ctl, out, clock };
}

function writeArtifact(cwd: string, name: string, body: string): string {
  const dir = path.join(cwd, '.omc', 'team', 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, 'utf8');
  return path.posix.join('.omc', 'team', 'artifacts', name);
}

// ─────────────────────────────────────────────────────────────────────

test('artifact gate: leader→worker without path is REJECTED, leader gets reject notice', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, out } = setupOrch(cwd);

    ctl.firePaneData({ paneId: 'L', data: '● @worker-1: 인라인 본문 그냥 보내본다.\n' });

    // Worker pane received NO inject — the route was rejected.
    const w1Writes = ctl.writes.filter((w) => w.paneId === 'W1');
    assert.equal(w1Writes.length, 0, 'worker must not be injected');

    // Leader pane received the reject notice.
    const lWrites = ctl.writes.filter((w) => w.paneId === 'L');
    assert.ok(
      lWrites.length >= 1 && lWrites[0].data.includes('[Podium Orchestrator system'),
      `leader must receive reject notice, got: ${JSON.stringify(lWrites.map((w) => w.data.slice(0, 60)))}`,
    );

    // Output channel logs the reject too.
    assert.ok(
      out.log.some((l) => l.includes('[orch.reject] leader→worker-1')),
      'orch output channel logs the reject',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('artifact gate: leader→worker with path but missing file is REJECTED', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, out } = setupOrch(cwd);

    // Path syntactically valid but the file does not exist on disk.
    ctl.firePaneData({
      paneId: 'L',
      data: '● @worker-1: parseCSV — see .omc/team/artifacts/to-worker-1-turn1.md.\n',
    });

    const w1Writes = ctl.writes.filter((w) => w.paneId === 'W1');
    assert.equal(w1Writes.length, 0, 'worker must not be injected when file missing');

    const lWrites = ctl.writes.filter((w) => w.paneId === 'L');
    assert.ok(
      lWrites.some((w) => w.data.includes('[Podium Orchestrator system')),
      'leader must receive reject notice',
    );
    assert.ok(
      out.log.some((l) => l.includes('매칭되는 artifact 파일이 없습니다')),
      'reject reason mentions missing artifact file',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('artifact gate: leader→worker with valid path + existing file PASSES (worker is injected)', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, out } = setupOrch(cwd);
    const rel = writeArtifact(cwd, 'to-worker-1-turn1.md', 'parseCSV 풀 본문 (RFC 4180 ...)');

    ctl.firePaneData({
      paneId: 'L',
      data: `● @worker-1: parseCSV — see ${rel}.\n`,
    });

    // Worker received the path-first notice (NOT a reject).
    const w1Writes = ctl.writes.filter((w) => w.paneId === 'W1');
    assert.ok(w1Writes.length >= 1, 'worker must be injected');
    assert.ok(
      w1Writes[0].data.startsWith(rel),
      `worker injection must be a path-first notice, got: ${w1Writes[0].data.slice(0, 80)}`,
    );

    // Leader pane received NO reject notice.
    const lRejects = ctl.writes.filter(
      (w) => w.paneId === 'L' && w.data.includes('[Podium Orchestrator system'),
    );
    assert.equal(lRejects.length, 0, 'leader must not see a reject for a valid directive');

    // Output channel did not log a reject.
    assert.ok(
      !out.log.some((l) => l.includes('[orch.reject] leader→worker-1')),
      'orch must not log reject for a valid directive',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('artifact gate: worker→leader without path is REJECTED, worker gets reject notice', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, out, clock } = setupOrch(cwd);

    // Worker emits an inline @leader: reply without an artifact path.
    ctl.firePaneData({ paneId: 'W1', data: '@leader: 인라인 답.\n' });
    clock.advance(200);

    // Leader pane received NO inject (real reply rejected).
    const lInjects = ctl.writes.filter(
      (w) => w.paneId === 'L' && !w.data.includes('[Podium Orchestrator system'),
    );
    assert.equal(lInjects.length, 0, 'leader must not be injected for rejected reply');

    // Worker pane received the reject notice.
    const w1Writes = ctl.writes.filter(
      (w) => w.paneId === 'W1' && w.data.includes('[Podium Orchestrator system'),
    );
    assert.ok(w1Writes.length >= 1, 'worker must receive its own reject notice');

    assert.ok(
      out.log.some((l) => l.includes('[orch.reject] worker-1→leader')),
      'orch output channel logs the worker→leader reject',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('artifact gate v0.13.0: directive WITHOUT path body PASSES when to-<id>-turn<N>.md exists', () => {
  // The v0.13.0 promise: directive body is NOT parsed for a path —
  // only the file system is consulted. Even a one-line directive
  // with no path string anywhere routes successfully as long as the
  // leader pre-wrote `to-<worker>-turn<N>.md`.
  const cwd = mkTmpCwd();
  try {
    const { ctl, out } = setupOrch(cwd);
    // Pre-write the artifact for the first leader turn (turn 1, since
    // setupOrch's prompt feed bumps leaderTurnId to 1).
    writeArtifact(cwd, 'to-worker-1-turn1.md', 'parseCSV 풀 본문 (RFC 4180 ...)');

    // Directive carries NO path string at all — pure routing trigger.
    ctl.firePaneData({ paneId: 'L', data: '● @worker-1: parseCSV 부탁.\n' });

    const w1Writes = ctl.writes.filter((w) => w.paneId === 'W1');
    assert.ok(w1Writes.length >= 1, 'worker must be injected');
    assert.ok(
      w1Writes[0].data.startsWith('.omc/team/artifacts/to-worker-1-turn1.md'),
      `worker must receive the resolved artifact path, got: ${w1Writes[0].data.slice(0, 80)}`,
    );
    const lRejects = ctl.writes.filter(
      (w) => w.paneId === 'L' && w.data.includes('[Podium Orchestrator system'),
    );
    assert.equal(lRejects.length, 0, 'no reject for a directive with on-disk artifact');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('artifact gate v0.13.0: turn-number catch-up — directive resolves to highest matching turn', () => {
  // If `to-worker-N-turn<currentTurn>.md` is missing, the orchestrator
  // falls back to the highest existing `to-worker-N-turn*.md` file.
  // This lets the leader pre-write artifacts under any turn number
  // without coordinating exact turn IDs.
  const cwd = mkTmpCwd();
  try {
    const { ctl } = setupOrch(cwd);
    // Only turn 7 exists. Current turn is 1.
    writeArtifact(cwd, 'to-worker-1-turn7.md', 'task body for turn 7');

    ctl.firePaneData({ paneId: 'L', data: '● @worker-1: 다음 작업.\n' });

    const w1Writes = ctl.writes.filter((w) => w.paneId === 'W1');
    assert.ok(w1Writes.length >= 1, 'worker must be injected even with non-current turn artifact');
    assert.ok(
      w1Writes[0].data.startsWith('.omc/team/artifacts/to-worker-1-turn7.md'),
      `worker must receive the catch-up artifact, got: ${w1Writes[0].data.slice(0, 80)}`,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('artifact gate v0.13.0: archivePriorArtifacts moves stale .md to archive/<ISO>/ on attach', () => {
  // attach() must clean the artifacts root so a stale
  // `to-worker-N-turn1.md` from a prior session does not silently
  // match a fresh turn=1 directive. Drops/ already does this; v0.13.0
  // extends the same archive-on-attach pattern to artifacts/.
  const cwd = mkTmpCwd();
  try {
    // Plant a stale artifact BEFORE attach.
    writeArtifact(cwd, 'to-worker-1-turn1.md', 'stale body from prior session');
    setupOrch(cwd);

    // Top-level *.md should be empty now; the stale file is in archive/.
    const dir = path.join(cwd, '.omc', 'team', 'artifacts');
    const topLevel = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'));
    assert.equal(topLevel.length, 0, 'no top-level *.md after archive');

    const archiveRoot = path.join(dir, 'archive');
    assert.ok(fs.existsSync(archiveRoot), 'archive/ created');
    const stamps = fs.readdirSync(archiveRoot, { withFileTypes: true });
    assert.ok(stamps.length >= 1, 'archive has at least one timestamped subdir');
    const archived = fs.readdirSync(path.join(archiveRoot, stamps[0].name));
    assert.ok(
      archived.includes('to-worker-1-turn1.md'),
      'stale artifact landed in archive',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('artifact gate: worker→leader with valid path + existing file PASSES', () => {
  const cwd = mkTmpCwd();
  try {
    const { ctl, out, clock } = setupOrch(cwd);
    const rel = writeArtifact(cwd, 'from-worker-1-turn1.md', 'parseCSV 결과 본문');

    ctl.firePaneData({
      paneId: 'W1',
      data: `@leader: 완료 — see ${rel}.\n`,
    });
    clock.advance(200);

    // Leader pane received an inject (the @leader: payload).
    const lInjects = ctl.writes.filter(
      (w) => w.paneId === 'L' && !w.data.includes('[Podium Orchestrator system'),
    );
    assert.ok(lInjects.length >= 1, 'leader must receive the worker reply');

    // Worker pane did NOT receive a reject.
    const w1Rejects = ctl.writes.filter(
      (w) => w.paneId === 'W1' && w.data.includes('[Podium Orchestrator system'),
    );
    assert.equal(w1Rejects.length, 0, 'worker must not see a reject for a valid reply');

    assert.ok(
      !out.log.some((l) => l.includes('[orch.reject] worker-1→leader')),
      'orch must not log reject for a valid reply',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
