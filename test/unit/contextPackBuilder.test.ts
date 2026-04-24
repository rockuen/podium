// v0.9.7 — ContextPackBuilder unit tests.
//
// Verify shape, byte-safe truncation, manifest accounting, and secret
// redaction. Tests run under `node --test` with no VS Code runtime.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildContextPack,
  buildContextManifest,
  renderContextPackMarkdown,
  redactSecrets,
  truncateBytes,
} from '../../src/orchestration/core/council/ContextPackBuilder';

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('buildContextPack: minimal input produces a usable pack with sensible defaults', () => {
  const cwd = mkTmp('podium-cpb-');
  const built = buildContextPack({
    cwd,
    primarySessionId: 'ps_min',
    userQuestion: 'Should I split this PR?',
  });

  assert.match(built.pack.id, /^cpack_/);
  assert.equal(built.pack.primarySessionId, 'ps_min');
  assert.equal(built.pack.userQuestion, 'Should I split this PR?');
  assert.equal(built.pack.currentGoal, '');
  assert.equal(built.pack.recentConversationSummary, '');
  assert.deepEqual(built.pack.relevantFiles, []);
  assert.equal(built.pack.gitDiff, undefined);
  assert.equal(built.pack.testOutput, undefined);
  assert.deepEqual(built.pack.constraints, []);
  assert.equal(typeof built.pack.createdAt, 'string');
  assert.equal(built.totals.redactionCount, 0);
  assert.equal(built.totals.truncatedSections, 0);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('buildContextPack: explicit file content is captured with bytes accounting', () => {
  const cwd = mkTmp('podium-cpb-');
  const body = 'export const x = 1;\n';
  const built = buildContextPack({
    cwd,
    primarySessionId: 'ps_files',
    userQuestion: 'Q',
    files: [{ path: 'src/foo.ts', content: body, reason: 'subject' }],
  });

  assert.equal(built.pack.relevantFiles.length, 1);
  assert.equal(built.pack.relevantFiles[0].path, 'src/foo.ts');
  assert.equal(built.pack.relevantFiles[0].bytes, Buffer.byteLength(body, 'utf8'));
  assert.equal(built.pack.relevantFiles[0].reason, 'subject');
  assert.equal(built.fileContents['src/foo.ts'], body);

  const inc = built.inclusions.files[0];
  assert.equal(inc.path, 'src/foo.ts');
  assert.equal(inc.includedBytes, Buffer.byteLength(body, 'utf8'));
  assert.equal(inc.originalBytes, Buffer.byteLength(body, 'utf8'));
  assert.equal(inc.truncated, false);
  assert.equal(inc.missing, false);
  assert.equal(inc.redactionCount, 0);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('buildContextPack: loadFileContents reads disk; missing files are flagged', () => {
  const cwd = mkTmp('podium-cpb-');
  fs.writeFileSync(path.join(cwd, 'present.txt'), 'hello\n', 'utf8');
  const built = buildContextPack({
    cwd,
    primarySessionId: 'ps_disk',
    userQuestion: 'Q',
    loadFileContents: true,
    files: [
      { path: 'present.txt', reason: 'exists' },
      { path: 'missing.txt', reason: 'gone' },
    ],
  });

  const presentInc = built.inclusions.files.find((f) => f.path === 'present.txt')!;
  const missingInc = built.inclusions.files.find((f) => f.path === 'missing.txt')!;
  assert.equal(presentInc.missing, false);
  assert.equal(presentInc.originalBytes, Buffer.byteLength('hello\n', 'utf8'));
  assert.equal(missingInc.missing, true);
  assert.equal(missingInc.originalBytes, 0);
  assert.equal(built.fileContents['present.txt'], 'hello\n');

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('buildContextPack: per-file content is truncated when over the cap, original bytes preserved', () => {
  const cwd = mkTmp('podium-cpb-');
  const big = 'x'.repeat(20 * 1024); // 20KB > default 8KB per-file cap
  const built = buildContextPack({
    cwd,
    primarySessionId: 'ps_cap',
    userQuestion: 'Q',
    files: [{ path: 'big.txt', content: big }],
  });

  const inc = built.inclusions.files[0];
  assert.equal(inc.truncated, true);
  assert.equal(inc.originalBytes, 20 * 1024);
  assert.ok(
    inc.includedBytes < inc.originalBytes,
    `includedBytes (${inc.includedBytes}) must be less than originalBytes (${inc.originalBytes}) when truncated`,
  );
  assert.ok(
    built.fileContents['big.txt'].includes('[...truncated by Podium ContextPackBuilder...]'),
    'truncation marker must be present in the captured body',
  );
  assert.equal(built.totals.truncatedSections, 1);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('buildContextPack: gitDiff and testOutput obey their own caps', () => {
  const cwd = mkTmp('podium-cpb-');
  const built = buildContextPack({
    cwd,
    primarySessionId: 'ps_diff',
    userQuestion: 'Q',
    gitDiff: 'd'.repeat(64 * 1024),
    testOutput: 't'.repeat(32 * 1024),
    caps: { diff: 1024, testOutput: 512 },
  });

  assert.equal(built.inclusions.gitDiff?.truncated, true);
  assert.equal(built.inclusions.gitDiff?.originalBytes, 64 * 1024);
  assert.ok((built.inclusions.gitDiff?.includedBytes ?? 0) < 64 * 1024);

  assert.equal(built.inclusions.testOutput?.truncated, true);
  assert.equal(built.inclusions.testOutput?.originalBytes, 32 * 1024);
  assert.ok((built.inclusions.testOutput?.includedBytes ?? 0) < 32 * 1024);

  assert.equal(built.totals.truncatedSections, 2);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('buildContextPack: recentConversationSummary obeys its cap', () => {
  const cwd = mkTmp('podium-cpb-');
  const big = 's'.repeat(10 * 1024);
  const built = buildContextPack({
    cwd,
    primarySessionId: 'ps_conv',
    userQuestion: 'Q',
    recentConversationSummary: big,
    caps: { conversationSummary: 256 },
  });

  assert.equal(built.inclusions.recentConversationSummary?.truncated, true);
  assert.equal(built.inclusions.recentConversationSummary?.originalBytes, 10 * 1024);
  assert.ok(built.pack.recentConversationSummary.includes('[...truncated'));

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('truncateBytes: capBytes <= 0 leaves input untouched (cap disabled)', () => {
  const out = truncateBytes('abcdef', 0);
  assert.equal(out.value, 'abcdef');
  assert.equal(out.truncated, false);
});

test('truncateBytes: byte-safe slice does not split a multi-byte codepoint', () => {
  // '한' = 3 bytes UTF-8. Cap at 4 bytes should fit '한' (3) but not '한가'.
  const out = truncateBytes('한가나다', 4);
  assert.equal(out.truncated, true);
  // Strip the marker (and any leading whitespace it brings with it) before
  // inspecting the user-visible payload portion.
  const before = out.value.split('[...truncated')[0].replace(/\s+$/, '');
  // No replacement char (U+FFFD) — confirms we did not split mid-codepoint.
  assert.equal(before.includes('�'), false);
  // Should be exactly '한' (3 bytes); '한가' would be 6 bytes > 4.
  assert.equal(before, '한');
});

test('redactSecrets: replaces sk-, ghp_, AKIA, Bearer, and KEY=value patterns', () => {
  const text = [
    'API_KEY="sk-live-abcdef1234567890ZZ"',
    'export GH_TOKEN=ghp_abcdef1234567890ABCDEF',
    'aws AKIAABCDEFGHIJ012345',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
    'plain note: nothing here',
  ].join('\n');
  const out = redactSecrets(text);
  assert.ok(out.count >= 4, `expected >= 4 redactions, got ${out.count}`);
  assert.ok(!out.value.includes('sk-live-abcdef1234567890ZZ'));
  assert.ok(!out.value.includes('ghp_abcdef1234567890ABCDEF'));
  assert.ok(!out.value.includes('AKIAABCDEFGHIJ012345'));
  assert.ok(!out.value.includes('eyJhbGciOiJIUzI1NiJ9.payload.signature'));
  // Plain text untouched.
  assert.ok(out.value.includes('plain note: nothing here'));
  // KV pattern keeps the key but redacts the value.
  assert.match(out.value, /API_KEY=.*\[REDACTED\]/);
});

test('redactSecrets: no false positives on short tokens or normal prose', () => {
  const text = 'This is a short word like sk-foo (only 6 chars), nothing sensitive.';
  const out = redactSecrets(text);
  assert.equal(out.count, 0);
  assert.equal(out.value, text);
});

test('buildContextPack: secrets in file content / diff / testOutput / summary are redacted and counted', () => {
  const cwd = mkTmp('podium-cpb-');
  const fileBody = 'API_KEY="sk-live-abcdef1234567890ZZ"\n';
  const built = buildContextPack({
    cwd,
    primarySessionId: 'ps_redact',
    userQuestion: 'Q',
    files: [{ path: 'config.ts', content: fileBody }],
    gitDiff: '+ Authorization: Bearer eyJabcdef1234567890.body.sig\n',
    testOutput: 'leaked AKIAABCDEFGHIJ012345 in test\n',
    recentConversationSummary: 'we discussed ghp_abcdef1234567890ABCDEF earlier',
  });

  assert.ok(built.totals.redactionCount >= 4, `expected >= 4, got ${built.totals.redactionCount}`);
  assert.ok(!built.fileContents['config.ts'].includes('sk-live-abcdef1234567890ZZ'));
  assert.ok(!(built.pack.gitDiff ?? '').includes('eyJabcdef1234567890.body.sig'));
  assert.ok(!(built.pack.testOutput ?? '').includes('AKIAABCDEFGHIJ012345'));
  assert.ok(!built.pack.recentConversationSummary.includes('ghp_abcdef1234567890ABCDEF'));

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('renderContextPackMarkdown: surfaces inclusion meta (truncated, redactions, missing)', () => {
  const cwd = mkTmp('podium-cpb-');
  const built = buildContextPack({
    cwd,
    primarySessionId: 'ps_md',
    userQuestion: 'How do we ship?',
    currentGoal: 'cut a release',
    files: [{ path: 'big.txt', content: 'x'.repeat(20 * 1024), reason: 'subject' }],
    gitDiff: 'diff --git a/x b/x\n+hi\n',
    constraints: ['no UI command yet'],
  });
  const md = renderContextPackMarkdown(built);

  assert.match(md, /How do we ship\?/);
  assert.match(md, /cut a release/);
  assert.match(md, /Truncated sections.*1/);
  assert.match(md, /big\.txt/);
  assert.match(md, /truncated/);
  assert.match(md, /no UI command yet/);
  assert.match(md, /```diff/);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('buildContextManifest: adds inclusions + totals and preserves legacy fields', () => {
  const cwd = mkTmp('podium-cpb-');
  const built = buildContextPack({
    cwd,
    primarySessionId: 'ps_manifest',
    userQuestion: 'Q',
    files: [{ path: 'a.ts', content: 'short' }],
    constraints: ['c1'],
    gitDiff: 'diff',
  });
  const manifest = buildContextManifest(built);

  assert.equal((manifest as any).contextPackId, built.pack.id);
  assert.equal((manifest as any).primarySessionId, 'ps_manifest');
  assert.deepEqual((manifest as any).constraints, ['c1']);
  assert.equal((manifest as any).includes.gitDiff, true);
  assert.equal((manifest as any).includes.testOutput, false);
  assert.equal((manifest as any).includes.recentConversationSummary, false);
  assert.equal((manifest as any).relevantFiles.length, 1);
  // v0.9.7 additions:
  assert.ok((manifest as any).inclusions);
  assert.ok((manifest as any).totals);
  assert.equal((manifest as any).totals.truncatedSections, 0);
  assert.equal((manifest as any).totals.redactionCount, 0);

  fs.rmSync(cwd, { recursive: true, force: true });
});
