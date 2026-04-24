// v0.10.2 — Council synthesizer integration tests.
//
// Verify:
//   - synthesizer participant runs after all participants and produces
//     `synthesis/summary.md`.
//   - synthesizer transport receives `priorOutputs` for every participant
//     in invocation order.
//   - council.synthesis.started + council.synthesis.completed events emit
//     in order, with the right payload.
//   - synthesizer failure does NOT break the council (still completed).
//   - return brief `recommendedAction` adapts to whether synthesis ran/failed.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCouncil } from '../../src/orchestration/core/council/CouncilRunner';
import {
  FakeParticipantTransport,
  type ParticipantInvocation,
  type ParticipantTransport,
  type ParticipantTransportResult,
} from '../../src/orchestration/core/council/ParticipantTransport';
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

/**
 * Synthesizer transport that captures the priorOutputs it received and
 * concatenates them into a synthesis body. Used to assert that the runner
 * correctly threads participant bodies through.
 */
class CapturingSynthesizerTransport implements ParticipantTransport {
  readonly id = 'fake-synthesizer';
  receivedPrior: Array<{ participantId: string; body: string }> | undefined;

  async invoke(call: ParticipantInvocation): Promise<ParticipantTransportResult> {
    this.receivedPrior = call.priorOutputs;
    const body =
      `# Synthesis\n\n` +
      (call.priorOutputs ?? [])
        .map((p) => `## from ${p.participantId}\n\n${p.body}`)
        .join('\n\n');
    return { status: 'completed', body, durationMs: 0 };
  }
}

class FailingSynthesizerTransport implements ParticipantTransport {
  readonly id = 'fake-synthesizer-failing';
  async invoke(_call: ParticipantInvocation): Promise<ParticipantTransportResult> {
    return {
      status: 'failed',
      body: '# synthesizer crashed\n\nReason: simulated failure\n',
      error: 'simulated synthesizer failure',
      durationMs: 5,
    };
  }
}

test('synthesizer: writes synthesis/summary.md and exposes the path on result.files', async () => {
  const cwd = mkTmp('podium-synth-');
  const synth = new CapturingSynthesizerTransport();
  const result = await runCouncil({
    cwd,
    contextPack: {
      primarySessionId: 'ps_synth',
      userQuestion: 'Q',
      currentGoal: 'G',
    },
    participants: [
      { id: 'p_a', transport: new FakeParticipantTransport({ body: '# A says\n\nfoo\n' }) },
      { id: 'p_b', transport: new FakeParticipantTransport({ body: '# B says\n\nbar\n' }) },
    ],
    synthesizer: { transport: synth, id: 'judge', provider: 'fake-judge' },
  });

  assert.equal(result.run.status, 'completed');
  assert.ok(result.files.synthesisSummaryMd, 'synthesisSummaryMd path must be exposed');
  assert.ok(fs.existsSync(result.files.synthesisSummaryMd!), 'summary.md must exist on disk');

  const summary = fs.readFileSync(result.files.synthesisSummaryMd!, 'utf8');
  assert.match(summary, /from p_a/);
  assert.match(summary, /A says/);
  assert.match(summary, /from p_b/);
  assert.match(summary, /B says/);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('synthesizer: receives priorOutputs from every participant in order', async () => {
  const cwd = mkTmp('podium-synth-');
  const synth = new CapturingSynthesizerTransport();
  await runCouncil({
    cwd,
    contextPack: { primarySessionId: 'ps_order', userQuestion: 'Q', currentGoal: 'G' },
    participants: [
      { id: 'first', transport: new FakeParticipantTransport({ body: 'first body' }) },
      { id: 'second', transport: new FakeParticipantTransport({ body: 'second body' }) },
      { id: 'third', transport: new FakeParticipantTransport({ body: 'third body' }) },
    ],
    synthesizer: { transport: synth },
  });

  assert.ok(synth.receivedPrior);
  assert.equal(synth.receivedPrior!.length, 3);
  assert.deepEqual(
    synth.receivedPrior!.map((p) => p.participantId),
    ['first', 'second', 'third'],
  );
  assert.equal(synth.receivedPrior![0].body, 'first body');
  assert.equal(synth.receivedPrior![2].body, 'third body');

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('synthesizer: emits council.synthesis.started + .completed in order with correct payload', async () => {
  const cwd = mkTmp('podium-synth-');
  const logger = new EventLogger({ cwd, podiumSessionId: 'ps_synth_evt' });
  const synth = new CapturingSynthesizerTransport();
  await runCouncil({
    cwd,
    contextPack: { primarySessionId: 'ps_synth_evt', userQuestion: 'Q', currentGoal: 'G' },
    participants: [{ id: 'p_only', transport: new FakeParticipantTransport({ body: 'X' }) }],
    synthesizer: { transport: synth, id: 'judge', provider: 'fake-judge' },
    eventLogger: logger,
  });

  const events = readLedger(cwd);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'council.opened',
    'context_pack.created',
    'council.participant.started',
    'council.participant.completed',
    'council.synthesis.started',
    'council.synthesis.completed',
    'council.brief.created',
  ]);

  const startedEvt = events.find((e) => e.type === 'council.synthesis.started')!;
  assert.equal((startedEvt.payload as any).synthesizerId, 'judge');
  assert.equal((startedEvt.payload as any).provider, 'fake-judge');
  assert.equal((startedEvt.payload as any).priorOutputCount, 1);
  assert.equal((startedEvt.payload as any).transportImpl, 'fake-synthesizer');

  const completedEvt = events.find((e) => e.type === 'council.synthesis.completed')!;
  assert.equal(completedEvt.level, 'info');
  assert.equal((completedEvt.payload as any).outcome, 'completed');
  assert.match((completedEvt.payload as any).summaryPath, /\/synthesis\/summary\.md$/);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('synthesizer: failure does not break council; brief reflects synthesis failure', async () => {
  const cwd = mkTmp('podium-synth-');
  const logger = new EventLogger({ cwd, podiumSessionId: 'ps_synth_fail' });
  const result = await runCouncil({
    cwd,
    contextPack: { primarySessionId: 'ps_synth_fail', userQuestion: 'Q', currentGoal: 'G' },
    participants: [{ id: 'p1', transport: new FakeParticipantTransport({ body: 'partial' }) }],
    synthesizer: { transport: new FailingSynthesizerTransport() },
    eventLogger: logger,
  });

  assert.equal(result.run.status, 'completed', 'council still completed even when synthesizer fails');
  assert.ok(result.files.synthesisSummaryMd, 'failure body still goes to summary.md');
  const summary = fs.readFileSync(result.files.synthesisSummaryMd!, 'utf8');
  assert.match(summary, /synthesizer crashed/);

  // Synthesis completed event carries warn level + outcome=failed.
  const events = readLedger(cwd);
  const synthEvt = events.find((e) => e.type === 'council.synthesis.completed')!;
  assert.equal(synthEvt.level, 'warn');
  assert.equal((synthEvt.payload as any).outcome, 'failed');
  assert.match((synthEvt.payload as any).reason, /simulated synthesizer failure/);

  // Return brief recommendedAction reflects the synthesis failure.
  assert.match(result.returnBrief.recommendedAction, /Synthesizer failed/);
  assert.ok(
    result.returnBrief.risks.some((r) => r.includes('Synthesizer reported failed')),
    'risks should mention synthesizer outcome',
  );

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('synthesizer omitted: synthesisSummaryMd is undefined and brief uses default phrasing', async () => {
  const cwd = mkTmp('podium-synth-');
  const result = await runCouncil({
    cwd,
    contextPack: { primarySessionId: 'ps_no_synth', userQuestion: 'Q', currentGoal: 'G' },
  });

  assert.equal(result.files.synthesisSummaryMd, undefined);
  assert.match(result.returnBrief.recommendedAction, /Review the council brief/);
  fs.rmSync(cwd, { recursive: true, force: true });
});
