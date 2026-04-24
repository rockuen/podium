// v0.9.6 — CouncilRunner unit tests.
//
// Verify the directory layout, artifact contents, council.json shape
// transitions, event ledger emissions, and resilience to logger failure.
// Tests run under `node --test` with no VS Code runtime — same pattern as
// the rest of the orchestration unit tests.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFakeCouncil } from '../../src/orchestration/core/council/CouncilRunner';
import { EventLogger, type EventEnvelope } from '../../src/orchestration/core/EventLogger';

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readLedger(cwd: string): EventEnvelope[] {
  const file = path.join(cwd, '.omc', 'team', 'logs', 'orchestrator.ndjson');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EventEnvelope);
}

test('CouncilRunner: writes the five required artifacts under .omc/team/council/<runId>/', async () => {
  const cwd = mkTmp('podium-council-');
  const result = await runFakeCouncil({
    cwd,
    contextPack: {
      primarySessionId: 'ps_test_1',
      userQuestion: 'Is this design direction correct?',
      currentGoal: 'Decide whether to refactor the council module',
    },
  });

  assert.ok(fs.existsSync(result.files.councilJson), 'council.json must exist');
  assert.ok(fs.existsSync(result.files.contextPackMd), 'context_pack.md must exist');
  assert.ok(fs.existsSync(result.files.contextManifestJson), 'context_manifest.json must exist');
  assert.equal(result.files.participantArtifacts.length, 1);
  assert.ok(
    fs.existsSync(result.files.participantArtifacts[0]),
    'participants/fake_critic.md must exist',
  );
  assert.ok(fs.existsSync(result.files.returnBriefMd), 'synthesis/return_brief.md must exist');

  // Workspace-relative root path is stable for callers/UI rendering.
  assert.match(result.rootDirRelative, /^\.omc\/team\/council\/council_\d{8}_\d{3}$/);

  // The fake critic file path is under participants/ with the expected basename.
  assert.match(
    result.files.participantArtifacts[0].split(path.sep).join('/'),
    /\/participants\/fake_critic\.md$/,
  );

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('CouncilRunner: council.json reflects completed status, preset, and one fake participant', async () => {
  const cwd = mkTmp('podium-council-');
  const result = await runFakeCouncil({
    cwd,
    contextPack: {
      primarySessionId: 'ps_test_2',
      userQuestion: 'Q',
      currentGoal: 'G',
    },
    preset: 'Risk Review',
  });

  const persisted = JSON.parse(fs.readFileSync(result.files.councilJson, 'utf8'));
  assert.equal(persisted.status, 'completed');
  assert.equal(persisted.preset, 'Risk Review');
  assert.equal(persisted.primarySessionId, 'ps_test_2');
  assert.equal(persisted.id, result.run.id);
  assert.equal(persisted.contextPackId, result.contextPack.id);
  assert.equal(persisted.participants.length, 1);
  assert.equal(persisted.participants[0].id, 'fake_critic');
  assert.equal(persisted.participants[0].role, 'critic');
  assert.equal(persisted.participants[0].provider, 'fake');
  assert.equal(persisted.participants[0].transport, 'fake');
  assert.equal(persisted.outputs.length, 1);
  assert.equal(persisted.outputs[0].participantId, 'fake_critic');
  assert.equal(persisted.outputs[0].status, 'completed');
  assert.match(persisted.outputs[0].artifactPath, /\/participants\/fake_critic\.md$/);
  assert.equal(typeof persisted.completedAt, 'string');

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('CouncilRunner: context_pack.md and context_manifest.json mirror the input', async () => {
  const cwd = mkTmp('podium-council-');
  const result = await runFakeCouncil({
    cwd,
    contextPack: {
      primarySessionId: 'ps_x',
      userQuestion: 'How should I split this PR?',
      currentGoal: 'Avoid scope creep',
      recentConversationSummary: 'Discussed council scope and budget',
      relevantFiles: [
        { path: 'src/orchestration/core/council/CouncilRunner.ts', reason: 'subject' },
      ],
      constraints: ['no UI command yet'],
      gitDiff: 'diff --git a/x b/x\n+hello\n',
    },
  });

  const md = fs.readFileSync(result.files.contextPackMd, 'utf8');
  assert.match(md, /How should I split this PR\?/);
  assert.match(md, /Avoid scope creep/);
  assert.match(md, /src\/orchestration\/core\/council\/CouncilRunner\.ts/);
  assert.match(md, /no UI command yet/);
  assert.match(md, /```diff/);

  const manifest = JSON.parse(fs.readFileSync(result.files.contextManifestJson, 'utf8'));
  assert.equal(manifest.includes.gitDiff, true);
  assert.equal(manifest.includes.testOutput, false);
  assert.equal(manifest.includes.recentConversationSummary, true);
  assert.equal(manifest.relevantFiles.length, 1);
  assert.deepEqual(manifest.constraints, ['no UI command yet']);
  assert.equal(manifest.contextPackId, result.contextPack.id);
  assert.equal(manifest.primarySessionId, 'ps_x');

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('CouncilRunner: return brief embeds run id, primary session, inject text, and original question', async () => {
  const cwd = mkTmp('podium-council-');
  const result = await runFakeCouncil({
    cwd,
    contextPack: {
      primarySessionId: 'ps_brief',
      userQuestion: 'What do other models think?',
      currentGoal: 'Second opinion',
    },
  });

  const text = fs.readFileSync(result.files.returnBriefMd, 'utf8');
  assert.match(text, new RegExp(result.run.id));
  assert.match(text, /ps_brief/);
  assert.match(text, /Inject text/);
  assert.match(text, /What do other models think\?/);
  assert.equal(result.returnBrief.councilRunId, result.run.id);
  assert.match(result.returnBrief.detailArtifactPath, /\/synthesis\/return_brief\.md$/);
  assert.ok(
    result.returnBrief.injectText.includes(result.run.id),
    'injectText should reference the council run id',
  );

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('CouncilRunner: emits opened, context_pack.created, participant.started, participant.completed, brief.created in order (v0.10.0)', async () => {
  const cwd = mkTmp('podium-council-');
  const logger = new EventLogger({ cwd, podiumSessionId: 'ps_events' });
  const result = await runFakeCouncil({
    cwd,
    contextPack: {
      primarySessionId: 'ps_events',
      userQuestion: 'Q',
      currentGoal: 'G',
    },
    eventLogger: logger,
  });

  const events = readLedger(cwd);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'council.opened',
    'context_pack.created',
    'council.participant.started',
    'council.participant.completed',
    'council.brief.created',
  ]);

  // Every council event carries the same podiumSessionId from the logger.
  for (const e of events) {
    assert.equal(e.podiumSessionId, 'ps_events');
  }

  // council.opened payload shape sanity.
  const opened = events[0];
  assert.equal((opened.payload as any).councilRunId, result.run.id);
  assert.equal((opened.payload as any).participantCount, 1);
  assert.equal((opened.payload as any).contextPackId, result.contextPack.id);
  assert.equal((opened.payload as any).primarySessionId, 'ps_events');

  // context_pack.created payload references the context pack file path.
  const cpEvt = events[1];
  assert.equal((cpEvt.payload as any).contextPackId, result.contextPack.id);
  assert.match((cpEvt.payload as any).contextPackPath, /\/context_pack\.md$/);

  // council.participant.started payload identifies the fake critic + transport impl.
  const startedEvt = events[2];
  assert.equal((startedEvt.payload as any).participantId, 'fake_critic');
  assert.equal((startedEvt.payload as any).transportImpl, 'fake');

  // council.participant.completed payload identifies the fake critic.
  const partEvt = events[3];
  assert.equal((partEvt.payload as any).participantId, 'fake_critic');
  assert.equal((partEvt.payload as any).provider, 'fake');
  assert.equal((partEvt.payload as any).role, 'critic');

  // council.brief.created payload references the return brief file.
  const briefEvt = events[4];
  assert.equal((briefEvt.payload as any).returnBriefId, result.returnBrief.id);
  assert.match((briefEvt.payload as any).returnBriefPath, /\/synthesis\/return_brief\.md$/);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('CouncilRunner: event-logger write failure does not break council run', async () => {
  const cwd = mkTmp('podium-council-');
  // Null-byte path forces every write to fail. EventLogger swallows the
  // error and disables further writes; the council run must still complete
  // with all on-disk artifacts intact.
  const badPath = path.join(os.tmpdir(), 'podium-bad-\0-council.ndjson');
  const logger = new EventLogger({
    cwd,
    filePath: badPath,
    podiumSessionId: 'ps_fail',
  });

  const result = await runFakeCouncil({
    cwd,
    contextPack: { primarySessionId: 'ps_fail', userQuestion: 'Q', currentGoal: 'G' },
    eventLogger: logger,
  });

  assert.equal(result.run.status, 'completed');
  assert.ok(fs.existsSync(result.files.councilJson));
  assert.ok(fs.existsSync(result.files.contextPackMd));
  assert.ok(fs.existsSync(result.files.contextManifestJson));
  assert.ok(fs.existsSync(result.files.participantArtifacts[0]));
  assert.ok(fs.existsSync(result.files.returnBriefMd));

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('CouncilRunner: sequential runs in the same UTC day get distinct seq numbers', async () => {
  const cwd = mkTmp('podium-council-');
  const fixedNow = new Date('2026-04-24T00:00:00.000Z');
  const r1 = await runFakeCouncil({
    cwd,
    contextPack: { primarySessionId: 'p', userQuestion: 'Q', currentGoal: 'G' },
    now: () => fixedNow,
  });
  const r2 = await runFakeCouncil({
    cwd,
    contextPack: { primarySessionId: 'p', userQuestion: 'Q', currentGoal: 'G' },
    now: () => fixedNow,
  });
  const r3 = await runFakeCouncil({
    cwd,
    contextPack: { primarySessionId: 'p', userQuestion: 'Q', currentGoal: 'G' },
    now: () => fixedNow,
  });
  assert.equal(r1.run.id, 'council_20260424_001');
  assert.equal(r2.run.id, 'council_20260424_002');
  assert.equal(r3.run.id, 'council_20260424_003');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('CouncilRunner: omitting eventLogger leaves no ledger on disk and does not throw', async () => {
  const cwd = mkTmp('podium-council-');
  const result = await runFakeCouncil({
    cwd,
    contextPack: { primarySessionId: 'ps_silent', userQuestion: 'Q', currentGoal: 'G' },
  });

  assert.equal(result.run.status, 'completed');
  const ledgerFile = path.join(cwd, '.omc', 'team', 'logs', 'orchestrator.ndjson');
  assert.equal(fs.existsSync(ledgerFile), false);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('CouncilRunner: builder integration — long file content is truncated and tracked in manifest', async () => {
  const cwd = mkTmp('podium-council-');
  const big = 'x'.repeat(40 * 1024); // 40KB > default 8KB per-file cap
  const result = await runFakeCouncil({
    cwd,
    contextPack: {
      primarySessionId: 'ps_trunc',
      userQuestion: 'Q',
      currentGoal: 'G',
      relevantFiles: [{ path: 'src/big.ts', content: big, reason: 'subject' }],
    },
  });

  const manifest = JSON.parse(fs.readFileSync(result.files.contextManifestJson, 'utf8'));
  assert.equal(manifest.totals.truncatedSections, 1);
  assert.equal(manifest.inclusions.files.length, 1);
  assert.equal(manifest.inclusions.files[0].truncated, true);
  assert.equal(manifest.inclusions.files[0].originalBytes, 40 * 1024);
  assert.ok(manifest.inclusions.files[0].includedBytes < 40 * 1024);

  // Builder result is exposed on the run result for in-process callers.
  assert.equal(result.builtContextPack.totals.truncatedSections, 1);

  // Markdown surfaces the truncation in the file section.
  const md = fs.readFileSync(result.files.contextPackMd, 'utf8');
  assert.match(md, /src\/big\.ts/);
  assert.match(md, /truncated/);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('CouncilRunner: builder integration — secrets in inputs are redacted and counted in manifest + event payload', async () => {
  const cwd = mkTmp('podium-council-');
  const logger = new EventLogger({ cwd, podiumSessionId: 'ps_redact' });
  const result = await runFakeCouncil({
    cwd,
    contextPack: {
      primarySessionId: 'ps_redact',
      userQuestion: 'Anything sensitive in this diff?',
      currentGoal: 'G',
      gitDiff: '+ Authorization: Bearer eyJabcdef1234567890.body.signature\n',
      testOutput: 'leaked AKIAABCDEFGHIJ012345 in test\n',
      relevantFiles: [
        { path: 'config.ts', content: 'API_KEY="sk-live-abcdef1234567890ZZ"\n' },
      ],
    },
    eventLogger: logger,
  });

  const manifest = JSON.parse(fs.readFileSync(result.files.contextManifestJson, 'utf8'));
  assert.ok(
    manifest.totals.redactionCount >= 3,
    `expected >= 3 redactions, got ${manifest.totals.redactionCount}`,
  );

  // No secret material survives in any persisted artifact.
  const md = fs.readFileSync(result.files.contextPackMd, 'utf8');
  assert.equal(md.includes('sk-live-abcdef1234567890ZZ'), false);
  assert.equal(md.includes('AKIAABCDEFGHIJ012345'), false);
  assert.equal(md.includes('eyJabcdef1234567890.body.signature'), false);

  // context_pack.created event payload exposes the counts to observers.
  const events = readLedger(cwd);
  const cpEvt = events.find((e) => e.type === 'context_pack.created');
  assert.ok(cpEvt, 'context_pack.created event must be emitted');
  assert.ok(
    (cpEvt!.payload as any).redactionCount >= 3,
    `event redactionCount should be >= 3, got ${(cpEvt!.payload as any).redactionCount}`,
  );
  assert.equal((cpEvt!.payload as any).truncatedSections, 0);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('CouncilRunner: council module is decoupled from PodiumOrchestrator (no live-routing files written)', async () => {
  const cwd = mkTmp('podium-council-');
  await runFakeCouncil({
    cwd,
    contextPack: { primarySessionId: 'ps_decoupled', userQuestion: 'Q', currentGoal: 'G' },
  });

  // Council output lives under .omc/team/council/. Live-routing dirs from
  // PodiumOrchestrator (drops/, artifacts/) must NOT appear when we only ran
  // a council — this proves the modules are independent on disk.
  const dropsDir = path.join(cwd, '.omc', 'team', 'drops');
  const artifactsDir = path.join(cwd, '.omc', 'team', 'artifacts');
  assert.equal(fs.existsSync(dropsDir), false, 'drops/ must not be created by a council run');
  assert.equal(
    fs.existsSync(artifactsDir),
    false,
    'artifacts/ must not be created by a council run',
  );

  const councilDir = path.join(cwd, '.omc', 'team', 'council');
  assert.equal(fs.existsSync(councilDir), true, 'council/ must be created');

  fs.rmSync(cwd, { recursive: true, force: true });
});
