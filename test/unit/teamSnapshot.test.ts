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
