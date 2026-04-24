// v0.10.0 — ParticipantTransport unit tests.
//
// Cover:
//   - FakeParticipantTransport completed/failed/timeout outcomes.
//   - HeadlessProcessTransport stdout/exit-code/timeout/spawn-error paths.
//   - CouncilRunner integration: failed transport still finalizes the
//     council as completed, emits council.participant.failed (warn level),
//     and writes participants/<id>.stderr.log when stderr is non-empty.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FakeParticipantTransport,
  HeadlessProcessTransport,
  transportLabelFor,
  type ParticipantInvocation,
} from '../../src/orchestration/core/council/ParticipantTransport';
import { runCouncil, runFakeCouncil } from '../../src/orchestration/core/council/CouncilRunner';
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

function fakeInvocation(overrides: Partial<ParticipantInvocation> = {}): ParticipantInvocation {
  return {
    participant: {
      id: 'unit_p',
      provider: 'fake',
      role: 'critic',
      transport: 'fake',
    },
    contextPack: {
      id: 'cpack_unit',
      primarySessionId: 'ps_unit',
      userQuestion: 'Q',
      currentGoal: 'G',
      recentConversationSummary: '',
      relevantFiles: [],
      constraints: [],
      createdAt: new Date('2026-04-24T00:00:00.000Z').toISOString(),
    },
    now: () => new Date(),
    ...overrides,
  };
}

// ---------- FakeParticipantTransport ----------

test('FakeParticipantTransport: default outcome is completed with deterministic stub body', async () => {
  const t = new FakeParticipantTransport();
  const result = await t.invoke(fakeInvocation());
  assert.equal(result.status, 'completed');
  assert.match(result.body, /Fake council participant/);
  assert.equal(result.error, undefined);
});

test('FakeParticipantTransport: explicit body is honoured', async () => {
  const t = new FakeParticipantTransport({ body: '# custom body\n' });
  const result = await t.invoke(fakeInvocation());
  assert.equal(result.body, '# custom body\n');
});

test('FakeParticipantTransport: outcome=failed surfaces error and a failure body', async () => {
  const t = new FakeParticipantTransport({ outcome: 'failed', errorMessage: 'kaboom' });
  const result = await t.invoke(fakeInvocation());
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'kaboom');
  assert.match(result.body, /did not complete \(failed\)/);
  assert.match(result.body, /kaboom/);
});

test('FakeParticipantTransport: outcome=timeout reports timeout error with default message', async () => {
  const t = new FakeParticipantTransport({ outcome: 'timeout' });
  const result = await t.invoke(fakeInvocation());
  assert.equal(result.status, 'timeout');
  assert.equal(result.error, 'outcome=timeout');
  assert.match(result.body, /did not complete \(timeout\)/);
});

test('FakeParticipantTransport: stderr is passed through verbatim', async () => {
  const t = new FakeParticipantTransport({ stderr: 'partial stderr from fake\n' });
  const result = await t.invoke(fakeInvocation());
  assert.equal(result.stderr, 'partial stderr from fake\n');
});

test('transportLabelFor: maps known impl ids to participant.transport labels', () => {
  assert.equal(transportLabelFor(new FakeParticipantTransport()), 'fake');
  assert.equal(
    transportLabelFor(
      new HeadlessProcessTransport({ command: 'noop', spawnImpl: (() => ({})) as any }),
    ),
    'headless',
  );
});

// ---------- HeadlessProcessTransport (real subprocess) ----------

test('HeadlessProcessTransport: subprocess stdout becomes the participant body', async () => {
  const t = new HeadlessProcessTransport({
    command: process.execPath, // node
    args: ['-e', 'process.stdout.write("# from subprocess\\n\\nhello\\n")'],
    timeoutMs: 10_000,
  });
  const result = await t.invoke(fakeInvocation());
  assert.equal(result.status, 'completed');
  assert.match(result.body, /from subprocess/);
  assert.match(result.body, /hello/);
});

test('HeadlessProcessTransport: nonzero exit code becomes failed status', async () => {
  const t = new HeadlessProcessTransport({
    command: process.execPath,
    args: ['-e', 'process.stderr.write("boom\\n"); process.exit(2)'],
    timeoutMs: 10_000,
  });
  const result = await t.invoke(fakeInvocation());
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /exit code 2/);
  assert.match(result.body, /did not complete/);
  assert.equal(result.stderr, 'boom\n');
});

test('HeadlessProcessTransport: spawn error (missing executable) becomes failed status', async () => {
  const t = new HeadlessProcessTransport({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    spawnImpl: (() => {
      throw new Error('ENOENT: no such file');
    }) as any,
  });
  const result = await t.invoke(fakeInvocation());
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /ENOENT/);
  assert.match(result.body, /spawn failed/);
});

test('HeadlessProcessTransport: hanging child times out and is killed', async () => {
  const t = new HeadlessProcessTransport({
    command: process.execPath,
    // setInterval keeps the event loop alive forever; transport must SIGKILL.
    args: ['-e', 'setInterval(() => {}, 1000); console.log("started")'],
    timeoutMs: 250,
  });
  const result = await t.invoke(fakeInvocation());
  assert.equal(result.status, 'timeout');
  assert.match(result.error ?? '', /timeout after 250ms/);
});

// ---------- CouncilRunner integration ----------

test('runCouncil: failed transport still finalizes council as completed (partial result)', async () => {
  const cwd = mkTmp('podium-transport-');
  const logger = new EventLogger({ cwd, podiumSessionId: 'ps_partial' });
  const result = await runCouncil({
    cwd,
    contextPack: {
      primarySessionId: 'ps_partial',
      userQuestion: 'Q',
      currentGoal: 'G',
    },
    participants: [
      {
        id: 'fake_critic',
        transport: new FakeParticipantTransport({
          outcome: 'failed',
          errorMessage: 'simulated transport failure',
          stderr: 'stderr line 1\nstderr line 2\n',
        }),
      },
    ],
    eventLogger: logger,
  });

  assert.equal(result.run.status, 'completed', 'council finalizes even when a participant fails');
  assert.equal(result.run.outputs.length, 1);
  assert.equal(result.run.outputs[0].status, 'failed');

  // stderr.log was written next to the participant artifact.
  assert.equal(result.files.participantStderrLogs.length, 1);
  const stderrAbs = path.join(
    cwd,
    result.files.participantStderrLogs[0].split('/').join(path.sep),
  );
  assert.ok(fs.existsSync(stderrAbs), 'stderr.log must be persisted');
  assert.match(fs.readFileSync(stderrAbs, 'utf8'), /stderr line 1/);

  // Event ledger order: opened, context_pack.created, started, failed, brief.created.
  const events = readLedger(cwd);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'council.opened',
    'context_pack.created',
    'council.participant.started',
    'council.participant.failed',
    'council.brief.created',
  ]);
  const failedEvt = events.find((e) => e.type === 'council.participant.failed')!;
  assert.equal(failedEvt.level, 'warn');
  assert.equal((failedEvt.payload as any).outcome, 'failed');
  assert.match((failedEvt.payload as any).reason, /simulated transport failure/);
  assert.match((failedEvt.payload as any).stderrPath, /\/participants\/fake_critic\.stderr\.log$/);

  // council.brief.created surfaces the failed count.
  const briefEvt = events.find((e) => e.type === 'council.brief.created')!;
  assert.equal((briefEvt.payload as any).failedParticipantCount, 1);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('runCouncil: mix of completed + failed transports produces partial-result council', async () => {
  const cwd = mkTmp('podium-transport-');
  const logger = new EventLogger({ cwd, podiumSessionId: 'ps_mixed' });
  const result = await runCouncil({
    cwd,
    contextPack: {
      primarySessionId: 'ps_mixed',
      userQuestion: 'Q',
      currentGoal: 'G',
    },
    participants: [
      { id: 'good', transport: new FakeParticipantTransport({ body: '# good output\n' }) },
      {
        id: 'bad',
        transport: new FakeParticipantTransport({ outcome: 'timeout', errorMessage: 'too slow' }),
      },
    ],
    eventLogger: logger,
  });

  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.outputs.length, 2);
  const byId = Object.fromEntries(result.run.outputs.map((o) => [o.participantId, o]));
  assert.equal(byId['good'].status, 'completed');
  assert.equal(byId['bad'].status, 'failed');

  const events = readLedger(cwd);
  // started+completed for good, started+failed for bad.
  const partTypes = events
    .filter((e) => e.type.startsWith('council.participant.'))
    .map((e) => e.type);
  assert.deepEqual(partTypes, [
    'council.participant.started',
    'council.participant.completed',
    'council.participant.started',
    'council.participant.failed',
  ]);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('runCouncil: HeadlessProcessTransport actually spawns and its stdout becomes the artifact', async () => {
  const cwd = mkTmp('podium-transport-');
  const result = await runCouncil({
    cwd,
    contextPack: {
      primarySessionId: 'ps_headless',
      userQuestion: 'Q',
      currentGoal: 'G',
    },
    participants: [
      {
        id: 'headless_critic',
        provider: 'fake-cli',
        transport: new HeadlessProcessTransport({
          command: process.execPath,
          args: ['-e', 'process.stdout.write("# headless ok\\n\\nbody line\\n")'],
          timeoutMs: 10_000,
        }),
      },
    ],
  });

  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.outputs[0].status, 'completed');
  assert.equal(result.run.participants[0].transport, 'headless');

  const artifact = fs.readFileSync(result.files.participantArtifacts[0], 'utf8');
  assert.match(artifact, /headless ok/);
  assert.match(artifact, /body line/);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('runFakeCouncil alias: still works as the v0.9.6 entry point with default fake transport', async () => {
  const cwd = mkTmp('podium-transport-');
  const result = await runFakeCouncil({
    cwd,
    contextPack: { primarySessionId: 'ps_alias', userQuestion: 'Q', currentGoal: 'G' },
  });
  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.outputs[0].status, 'completed');
  assert.equal(result.run.participants[0].transport, 'fake');
  fs.rmSync(cwd, { recursive: true, force: true });
});
