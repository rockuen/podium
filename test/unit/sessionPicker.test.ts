import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  hashCwdForClaudeProjects,
  claudeProjectsDirForCwd,
  listClaudeSessions,
} from '../../src/orchestration/core/sessionPicker';

test('sessionPicker: cwd hash matches observed Claude Code encoding', () => {
  // Observed: `c:\obsidian\Won's 2nd Brain` → `c--obsidian-Won-s-2nd-Brain`
  assert.equal(
    hashCwdForClaudeProjects("c:\\obsidian\\Won's 2nd Brain"),
    'c--obsidian-Won-s-2nd-Brain',
  );
  // Mac-style: `/Users/rockuen/obsidian/Won's 2nd Brain` yields the same
  // folder name on macOS boxes (all non-alphanumerics collapse to `-`).
  assert.equal(
    hashCwdForClaudeProjects("/Users/rockuen/obsidian/Won's 2nd Brain"),
    '-Users-rockuen-obsidian-Won-s-2nd-Brain',
  );
  // Drive-only path collapses colon+backslash to double dash.
  assert.equal(hashCwdForClaudeProjects('C:\\Users\\FURSYS'), 'C--Users-FURSYS');
});

test('sessionPicker: claudeProjectsDirForCwd composes under ~/.claude/projects', () => {
  const dir = claudeProjectsDirForCwd("c:\\obsidian\\Won's 2nd Brain", '/FAKEHOME');
  assert.equal(
    dir,
    path.join('/FAKEHOME', '.claude', 'projects', 'c--obsidian-Won-s-2nd-Brain'),
  );
});

test('sessionPicker: listClaudeSessions returns empty for missing dir', async () => {
  const sessions = await listClaudeSessions('/definitely/not/a/real/path/ever', {
    home: path.join(os.tmpdir(), 'podium-picker-missing-' + Date.now()),
  });
  assert.deepEqual(sessions, []);
});

test('sessionPicker: listClaudeSessions reads JSONL fixtures sorted newest-first', async () => {
  // Build a throwaway fake home with two synthetic session files.
  const home = path.join(os.tmpdir(), `podium-picker-${Date.now()}`);
  const cwd = 'C:\\fake\\proj';
  const sessionsDir = claudeProjectsDirForCwd(cwd, home);
  await fs.promises.mkdir(sessionsDir, { recursive: true });

  const olderId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const newerId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  const userLine = (text: string) =>
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
      gitBranch: 'main',
    });
  const assistantLine = () =>
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    });

  const olderPath = path.join(sessionsDir, `${olderId}.jsonl`);
  const newerPath = path.join(sessionsDir, `${newerId}.jsonl`);
  await fs.promises.writeFile(
    olderPath,
    [userLine('older first prompt'), assistantLine()].join('\n') + '\n',
  );
  await fs.promises.writeFile(
    newerPath,
    [userLine('newer first prompt'), assistantLine()].join('\n') + '\n',
  );
  // Force distinct mtimes so sort is deterministic regardless of FS timestamp
  // resolution.
  const past = new Date(Date.now() - 60_000);
  await fs.promises.utimes(olderPath, past, past);

  const results = await listClaudeSessions(cwd, { home });
  assert.equal(results.length, 2);
  assert.equal(results[0].sessionId, newerId, 'newer session must come first');
  assert.equal(results[0].firstUserMessage, 'newer first prompt');
  assert.equal(results[0].gitBranch, 'main');
  assert.equal(results[0].messageCount, 2);
  assert.equal(results[1].sessionId, olderId);

  // Cleanup.
  await fs.promises.rm(home, { recursive: true, force: true });
});
