import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  MAX_SNAPSHOTS,
  SNAPSHOT_SCHEMA_VERSION,
  loadSnapshots,
  makeSnapshotId,
  resolveSnapshotPath,
  saveSnapshot,
  summarizeSnapshotForPicker,
  type TeamSnapshot,
} from '../../src/orchestration/core/teamSnapshot';

function makeSnapshot(overrides: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    id: overrides.id ?? 'snap-20260422-120000',
    name: overrides.name ?? 'fixture team',
    createdAt: overrides.createdAt ?? new Date('2026-04-22T12:00:00Z').toISOString(),
    source: overrides.source ?? 'manual',
    cwd: overrides.cwd ?? 'c:\\fake\\project',
    leader: overrides.leader ?? {
      paneId: 'leader',
      agent: 'claude',
      sessionId: '11111111-1111-1111-1111-111111111111',
      label: 'leader (fixture)',
    },
    workers: overrides.workers ?? [
      { paneId: 'worker-1', agent: 'claude', sessionId: '22222222-2222-2222-2222-222222222222' },
      { paneId: 'worker-2', agent: 'claude', sessionId: '33333333-3333-3333-3333-333333333333' },
    ],
  };
}

function tmpFile(): string {
  return path.join(os.tmpdir(), `podium-snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

test('teamSnapshot: resolveSnapshotPath prefers OneDrive when available', () => {
  const p = resolveSnapshotPath({ env: { OneDrive: 'D:\\OD' }, home: 'C:\\Users\\u' });
  assert.equal(p, path.join('D:\\OD', 'wons-2nd-brain-data', 'podium', 'claudeTeams.json'));
});

test('teamSnapshot: resolveSnapshotPath falls back to ~/.podium when no OneDrive', () => {
  const p = resolveSnapshotPath({ env: {}, home: '/home/x' });
  assert.equal(p, path.join('/home/x', '.podium', 'claudeTeams.json'));
});

test('teamSnapshot: loadSnapshots returns empty file for missing path', async () => {
  const file = tmpFile();
  const loaded = await loadSnapshots(file);
  assert.equal(loaded.version, SNAPSHOT_SCHEMA_VERSION);
  assert.deepEqual(loaded.teams, []);
});

test('teamSnapshot: loadSnapshots recovers from corrupted JSON without throwing', async () => {
  const file = tmpFile();
  await fs.promises.writeFile(file, '{not json', 'utf8');
  const loaded = await loadSnapshots(file);
  assert.deepEqual(loaded.teams, []);
  await fs.promises.unlink(file);
});

test('teamSnapshot: saveSnapshot roundtrip writes newest-first, atomically', async () => {
  const file = tmpFile();
  const a = makeSnapshot({ id: 'a', createdAt: '2026-04-22T10:00:00Z' });
  const b = makeSnapshot({ id: 'b', createdAt: '2026-04-22T11:00:00Z' });

  await saveSnapshot(file, a);
  await saveSnapshot(file, b);

  const loaded = await loadSnapshots(file);
  assert.equal(loaded.teams.length, 2);
  assert.equal(loaded.teams[0].id, 'b', 'latest save must be first');
  assert.equal(loaded.teams[1].id, 'a');

  // Ensure the tmp file was cleaned up via atomic rename.
  assert.ok(!fs.existsSync(file + '.tmp'));
  await fs.promises.unlink(file);
});

test('teamSnapshot: saveSnapshot deduplicates by id (re-save bumps to front)', async () => {
  const file = tmpFile();
  const v1 = makeSnapshot({ id: 'shared', name: 'first revision' });
  const other = makeSnapshot({ id: 'other', name: 'sibling' });
  const v2 = makeSnapshot({ id: 'shared', name: 'second revision' });

  await saveSnapshot(file, v1);
  await saveSnapshot(file, other);
  await saveSnapshot(file, v2);

  const loaded = await loadSnapshots(file);
  assert.equal(loaded.teams.length, 2, 'dup id should not produce two entries');
  assert.equal(loaded.teams[0].id, 'shared');
  assert.equal(loaded.teams[0].name, 'second revision');
  assert.equal(loaded.teams[1].id, 'other');
  await fs.promises.unlink(file);
});

test('teamSnapshot: saveSnapshot prunes to maxKeep (default 10)', async () => {
  const file = tmpFile();
  for (let i = 0; i < MAX_SNAPSHOTS + 3; i++) {
    await saveSnapshot(file, makeSnapshot({ id: `snap-${i}`, createdAt: new Date(2026, 3, 22, 10, i).toISOString() }));
  }
  const loaded = await loadSnapshots(file);
  assert.equal(loaded.teams.length, MAX_SNAPSHOTS);
  // Newest save is `snap-(MAX+2)`; oldest surviving is snap-3.
  assert.equal(loaded.teams[0].id, `snap-${MAX_SNAPSHOTS + 2}`);
  assert.equal(loaded.teams[loaded.teams.length - 1].id, 'snap-3');
  await fs.promises.unlink(file);
});

test('teamSnapshot: makeSnapshotId is deterministic for a given timestamp', () => {
  const t = Date.UTC(2026, 3, 22, 12, 34, 56);
  assert.equal(makeSnapshotId(t), 'snap-20260422-123456');
});

test('teamSnapshot: summarizeSnapshotForPicker renders label/description/detail', () => {
  const s = makeSnapshot({ workers: [makeSnapshot().workers[0]] });
  const out = summarizeSnapshotForPicker(s);
  assert.equal(out.label, s.name);
  assert.ok(out.description.includes('1 worker'));
  assert.ok(out.description.includes('manual'));
  assert.ok(out.detail.includes(s.id));
  assert.ok(out.detail.includes('2×claude'));
});

// ─── Phase 4.B · v2.7.25 snapshot regressions ────────────────────────────

// 9.8 · N=0 roundtrip: leader-only team (no workers) survives save/load.
test('teamSnapshot v2.7.25: N=0 (leader-only) roundtrip preserves shape + version', async () => {
  const file = tmpFile();
  const zero = makeSnapshot({
    id: 'snap-n0',
    name: 'leader-only',
    workers: [],
  });
  await saveSnapshot(file, zero);
  const loaded = await loadSnapshots(file);
  assert.equal(loaded.version, SNAPSHOT_SCHEMA_VERSION, 'version pinned to 1');
  assert.equal(loaded.teams.length, 1);
  assert.equal(loaded.teams[0].workers.length, 0, 'N=0 workers preserved');
  assert.equal(loaded.teams[0].id, 'snap-n0');
  assert.equal(loaded.teams[0].leader.paneId, 'leader');
  await fs.promises.unlink(file);
});

// 9.8 · N=1 roundtrip — single-worker team with label survives save/load.
test('teamSnapshot v2.7.25: N=1 roundtrip preserves worker label', async () => {
  const file = tmpFile();
  const snap = makeSnapshot({
    id: 'snap-n1',
    workers: [
      {
        paneId: 'worker-1',
        agent: 'claude',
        sessionId: '11111111-1111-1111-1111-111111111111',
        label: 'solo-summarizer',
      },
    ],
  });
  await saveSnapshot(file, snap);
  const loaded = await loadSnapshots(file);
  assert.equal(loaded.teams.length, 1);
  const loadedWorkers = loaded.teams[0].workers;
  assert.equal(loadedWorkers.length, 1);
  assert.equal(loadedWorkers[0].label, 'solo-summarizer', 'label preserved across roundtrip');
  assert.equal(loadedWorkers[0].paneId, 'worker-1');
  assert.equal(loadedWorkers[0].sessionId, '11111111-1111-1111-1111-111111111111');
  await fs.promises.unlink(file);
});

// 9.8 · N=3 roundtrip — labels preserved and distinct across workers.
test('teamSnapshot v2.7.25: N=3 roundtrip preserves all 3 labels + sessionIds', async () => {
  const file = tmpFile();
  const snap = makeSnapshot({
    id: 'snap-n3',
    workers: [
      { paneId: 'worker-1', agent: 'claude', sessionId: 'sid-1', label: 'analyzer' },
      { paneId: 'worker-2', agent: 'claude', sessionId: 'sid-2', label: 'writer' },
      { paneId: 'worker-3', agent: 'claude', sessionId: 'sid-3', label: 'reviewer' },
    ],
  });
  await saveSnapshot(file, snap);
  const loaded = await loadSnapshots(file);
  assert.equal(loaded.teams[0].workers.length, 3);
  const labels = loaded.teams[0].workers.map((w) => w.label);
  assert.deepEqual(labels, ['analyzer', 'writer', 'reviewer']);
  const sids = loaded.teams[0].workers.map((w) => w.sessionId);
  assert.deepEqual(sids, ['sid-1', 'sid-2', 'sid-3']);
  await fs.promises.unlink(file);
});

// 9.8 · N=5 roundtrip — full-size team survives.
test('teamSnapshot v2.7.25: N=5 roundtrip preserves shape + ordering', async () => {
  const file = tmpFile();
  const workers = [1, 2, 3, 4, 5].map((n) => ({
    paneId: `worker-${n}`,
    agent: 'claude' as const,
    sessionId: `sid-${n}`,
    label: `worker-${n}-name`,
  }));
  const snap = makeSnapshot({ id: 'snap-n5', workers });
  await saveSnapshot(file, snap);
  const loaded = await loadSnapshots(file);
  assert.equal(loaded.teams[0].workers.length, 5);
  const paneIds = loaded.teams[0].workers.map((w) => w.paneId);
  assert.deepEqual(paneIds, ['worker-1', 'worker-2', 'worker-3', 'worker-4', 'worker-5']);
  const labels = loaded.teams[0].workers.map((w) => w.label);
  assert.deepEqual(labels, [
    'worker-1-name',
    'worker-2-name',
    'worker-3-name',
    'worker-4-name',
    'worker-5-name',
  ]);
  await fs.promises.unlink(file);
});

// 9.9 · Pre-v2.7.25 compat fixture.
// The fixture committed to `test/fixtures/claudeTeams-pre-v2.7.25.json` has
// 2 workers with no `label` fields — exactly what pre-v2.7.25 auto-save wrote.
// `loadSnapshots` must accept it cleanly; worker labels are absent (undefined)
// and callers fall back to `cfg.id` in rendering (handled in WorkerTreeItem).
test('teamSnapshot v2.7.25: pre-v2.7.25 2-worker fixture loads cleanly without label fields', async () => {
  // __dirname at test time is `.test-out/test/unit/`. The fixture is under
  // `test/fixtures/` in the source tree — not copied by tsc. Walk up to the
  // project root (`.test-out/` → parent == package root) then into `test/fixtures/`.
  // Fallback: try npm-script cwd if the walked path doesn't exist.
  const candidate1 = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'claudeTeams-pre-v2.7.25.json');
  const candidate2 = path.join(process.cwd(), 'test', 'fixtures', 'claudeTeams-pre-v2.7.25.json');
  const fixturePath = fs.existsSync(candidate1) ? candidate1 : candidate2;
  assert.ok(fs.existsSync(fixturePath), `fixture must exist at ${fixturePath} (or ${candidate1})`);
  const loaded = await loadSnapshots(fixturePath);
  assert.equal(loaded.version, 1, 'schemaVersion 1 preserved');
  assert.equal(loaded.teams.length, 1, 'one team in fixture');
  const team = loaded.teams[0];
  assert.equal(team.id, 'snap_test_pre_v2_7_25');
  assert.equal(team.workers.length, 2);

  // Labels are absent (pre-v2.7.25 didn't write them) — must not throw.
  for (const w of team.workers) {
    assert.equal(w.label, undefined, 'pre-v2.7.25 fixture has no label field');
    assert.ok(w.paneId.startsWith('worker-'), 'paneId is what renderers fall back to');
    assert.ok(typeof w.sessionId === 'string' && w.sessionId.length > 0);
  }

  // Fallback semantics check: a renderer using `label ?? paneId` produces a
  // non-empty display string for every worker.
  const display = team.workers.map((w) => w.label ?? w.paneId);
  assert.deepEqual(display, ['worker-1', 'worker-2']);
});
