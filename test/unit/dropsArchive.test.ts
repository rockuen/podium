// v0.9.0 — drops archive on attach.
//
// Retrospective (2026-04-24 parseCSV session, Section G):
//   `to-worker-1-turn1-seq1.md` from a PRIOR session's reverseString task
//   stayed on disk when the next session spawned, producing turn-1 drop
//   content that had nothing to do with the current conversation. Forensic
//   analysis had to manually disambiguate which file belonged to which
//   session.
//
// Fix: on attach(), move any existing top-level `.md` files in
//   `<cwd>/.omc/team/drops/` to `<cwd>/.omc/team/drops/archive/<ISO>/`.
// Subdirectories (including `archive/` itself) are left alone.

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

function makeFakePanel() {
  const dataEmit = makeEmitter<PaneDataEvent>();
  const exitEmit = makeEmitter<PaneExitEvent>();
  const panel = {
    onPaneData: dataEmit.event,
    onPaneExit: exitEmit.event,
    writeToPane() {},
    removePane() {},
  } as unknown as LiveMultiPanel;
  return { panel };
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

function mkTmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'podium-drops-archive-'));
}

function seed(dir: string, relPath: string, body: string): string {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

function listTopLevelDrops(cwd: string): string[] {
  const d = path.join(cwd, '.omc', 'team', 'drops');
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
}

function listArchiveDirs(cwd: string): string[] {
  const d = path.join(cwd, '.omc', 'team', 'drops', 'archive');
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function makeOrch(cwd: string) {
  const panel = makeFakePanel().panel;
  const out = makeOutput();
  const orch = new PodiumOrchestrator(panel, out.channel);
  orch.attach({
    leader: { paneId: 'L', agent: 'claude', sessionId: 'abc12345-rest-of-uuid' },
    workers: [
      { id: 'worker-1', paneId: 'W1', agent: 'claude', silenceMs: 100, role: 'implementer' },
      { id: 'worker-2', paneId: 'W2', agent: 'claude', silenceMs: 100, role: 'critic' },
    ],
    cwd,
    skipAutoTick: true,
  });
  return { orch, out };
}

test('dropsArchive v0.9.0: no pre-existing drops → nothing happens', () => {
  const cwd = mkTmpCwd();
  try {
    const { out } = makeOrch(cwd);
    // drops dir may not even exist; must not crash.
    assert.equal(listTopLevelDrops(cwd).length, 0);
    assert.equal(listArchiveDirs(cwd).length, 0);
    assert.ok(!out.log.some((l) => l.includes('archive on attach FAILED')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('dropsArchive v0.9.0: pre-existing drops are moved to archive/<ISO>/', () => {
  const cwd = mkTmpCwd();
  try {
    // Pre-seed two orphan drops from a "prior session"
    seed(cwd, '.omc/team/drops/to-worker-1-turn1-seq1.md', '# old directive\nold payload\n');
    seed(cwd, '.omc/team/drops/worker-2-turn3-seq2.md', '# old worker report\n');
    assert.equal(listTopLevelDrops(cwd).length, 2);

    makeOrch(cwd);

    // Top-level is now empty.
    assert.deepEqual(listTopLevelDrops(cwd), []);

    // Exactly one timestamped archive directory was created.
    const archives = listArchiveDirs(cwd);
    assert.equal(archives.length, 1);
    assert.match(archives[0], /^\d{4}-\d{2}-\d{2}T/);

    // Both orphans are inside that archive directory, contents preserved.
    const archivedRoot = path.join(cwd, '.omc/team/drops/archive', archives[0]);
    const moved = fs.readdirSync(archivedRoot).sort();
    assert.deepEqual(moved, ['to-worker-1-turn1-seq1.md', 'worker-2-turn3-seq2.md']);
    assert.equal(
      fs.readFileSync(path.join(archivedRoot, 'to-worker-1-turn1-seq1.md'), 'utf8'),
      '# old directive\nold payload\n',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('dropsArchive v0.9.0: existing archive/ subdir is NOT moved into itself', () => {
  const cwd = mkTmpCwd();
  try {
    // One orphan at root, plus a prior archive from an even earlier session.
    seed(cwd, '.omc/team/drops/to-worker-1-turn2-seq1.md', '# orphan\n');
    seed(cwd, '.omc/team/drops/archive/2026-04-20T10-00-00-000Z/old.md', '# already archived\n');

    makeOrch(cwd);

    assert.deepEqual(listTopLevelDrops(cwd), []);

    // Now there are TWO archive subdirs: the old one + the fresh one.
    const archives = listArchiveDirs(cwd);
    assert.equal(archives.length, 2);

    // The pre-existing archive is intact (not double-moved).
    const oldArchive = path.join(
      cwd,
      '.omc/team/drops/archive/2026-04-20T10-00-00-000Z/old.md',
    );
    assert.equal(fs.readFileSync(oldArchive, 'utf8'), '# already archived\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('dropsArchive v0.9.0: non-.md files are ignored (left at root)', () => {
  const cwd = mkTmpCwd();
  try {
    seed(cwd, '.omc/team/drops/to-worker-1-turn1-seq1.md', '# orphan md\n');
    seed(cwd, '.omc/team/drops/.gitkeep', '');
    seed(cwd, '.omc/team/drops/notes.txt', 'stray non-md file');

    makeOrch(cwd);

    // Only the .md moved; non-.md stayed.
    const remaining = fs
      .readdirSync(path.join(cwd, '.omc/team/drops'), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
    assert.deepEqual(remaining, ['.gitkeep', 'notes.txt']);

    const archives = listArchiveDirs(cwd);
    assert.equal(archives.length, 1);
    const moved = fs.readdirSync(path.join(cwd, '.omc/team/drops/archive', archives[0]));
    assert.deepEqual(moved, ['to-worker-1-turn1-seq1.md']);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('dropsArchive v0.9.0: archive folder name is filesystem-safe', () => {
  const cwd = mkTmpCwd();
  try {
    seed(cwd, '.omc/team/drops/to-worker-1-turn1-seq1.md', '# orphan\n');
    makeOrch(cwd);
    const archives = listArchiveDirs(cwd);
    assert.equal(archives.length, 1);
    // No ':' or '.' (Windows-hostile). Must match the ISO-safe shape.
    assert.ok(!archives[0].includes(':'), `archive name has colon: ${archives[0]}`);
    assert.match(archives[0], /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
