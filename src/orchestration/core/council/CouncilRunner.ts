// v0.9.6 — Council product skeleton: directory writer + fake participant.
// v0.9.7 — Delegates context-pack assembly, markdown rendering, and manifest
//          building to ContextPackBuilder so caps + secret redaction apply
//          uniformly. The fake participant path and on-disk shape are
//          unchanged from v0.9.6 — only the context-pack stage gets richer.
// v0.10.0 — Participants run through a `ParticipantTransport`. The default
//          is `FakeParticipantTransport` so the existing fake-only flow keeps
//          working with no caller change. New: `runFakeCouncil` is async,
//          `participants[].transport` accepts any `ParticipantTransport`
//          (e.g. `HeadlessProcessTransport`), failed/timeout transports
//          surface `council.participant.failed`, and the council still
//          finalizes as `completed` to allow partial-result runs.
//          `runCouncil` is exported as the canonical name; `runFakeCouncil`
//          stays as a backward-compatible alias.
// v0.10.2 — Optional `synthesizer` runs after all participants complete and
//          writes `synthesis/summary.md`. Synthesizer transport receives
//          `priorOutputs` from every participant. Emits
//          `council.synthesis.started` / `.completed`. Council still
//          finalizes as completed even if synthesizer fails.
//
// This module is intentionally separated from `PodiumOrchestrator`. Live
// routing (Focus Mode) and council runs (Temporary Council Mode) share the
// EventLogger and the `.omc/team/` filesystem root, but the council code
// path must NOT touch live-routing state, panes, or worker registries.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventLogger, EventInput } from '../EventLogger';
import type {
  ContextPack,
  CouncilParticipant,
  CouncilParticipantOutput,
  CouncilRun,
  ReturnBrief,
} from './types';
import {
  buildContextPack,
  buildContextManifest,
  renderContextPackMarkdown,
  type BuiltContextPack,
  type ContextFileInput,
  type ContextPackCaps,
} from './ContextPackBuilder';
import {
  FakeParticipantTransport,
  transportLabelFor,
  type ParticipantInvocation,
  type ParticipantTransport,
} from './ParticipantTransport';

const COUNCIL_BASE_REL = ['.omc', 'team', 'council'];

export interface ContextPackInput {
  primarySessionId: string;
  userQuestion: string;
  currentGoal: string;
  recentConversationSummary?: string;
  relevantFiles?: ContextFileInput[];
  loadFileContents?: boolean;
  gitDiff?: string;
  testOutput?: string;
  constraints?: string[];
  caps?: ContextPackCaps;
}

/**
 * Spec for one council participant. v0.10.0 widened from `FakeParticipantSpec`:
 * `transport` accepts any `ParticipantTransport`. When omitted, a
 * `FakeParticipantTransport` is constructed with `body = spec.output`.
 */
export interface CouncilParticipantSpec {
  id?: string;
  provider?: string;
  role?: 'critic' | 'reviewer' | 'researcher' | 'judge' | 'implementer' | 'synthesizer';
  /** Transport implementation. Default: `FakeParticipantTransport`. */
  transport?: ParticipantTransport;
  /** v0.9.6 compat: pre-baked body for the default fake transport. */
  output?: string;
}

/** Backward-compatible alias for v0.9.6/v0.9.7 callers. */
export type FakeParticipantSpec = CouncilParticipantSpec;

/**
 * v0.10.2 — Optional synthesizer participant. Runs after all participants
 * finish and writes its body to `synthesis/summary.md`. Receives every
 * participant's body as `priorOutputs` so the transport can synthesize
 * across them.
 */
export interface CouncilSynthesizerSpec {
  id?: string;
  provider?: string;
  transport: ParticipantTransport;
}

export interface CouncilRunnerOptions {
  cwd: string;
  /** Raw context inputs. Ignored when `prebuiltContextPack` is provided. */
  contextPack: ContextPackInput;
  /**
   * Optional pre-built context pack. When supplied, the runner skips its
   * own `buildContextPack` call and uses this directly. Useful for callers
   * that want to inspect the built pack before launching the council.
   */
  prebuiltContextPack?: BuiltContextPack;
  preset?: string;
  /** Default: a single `fake_critic` running through `FakeParticipantTransport`. */
  participants?: CouncilParticipantSpec[];
  /**
   * v0.10.2 — When provided, the council adds a synthesis step after the
   * participants return. The synthesizer body becomes `synthesis/summary.md`.
   */
  synthesizer?: CouncilSynthesizerSpec;
  eventLogger?: EventLogger;
  /** Test seam: clock. */
  now?: () => Date;
  /** Test seam: id generator. */
  newId?: () => string;
}

export interface CouncilRunResult {
  run: CouncilRun;
  contextPack: ContextPack;
  builtContextPack: BuiltContextPack;
  returnBrief: ReturnBrief;
  /** Absolute path to the run directory. */
  rootDir: string;
  /** Workspace-relative path to the run directory (POSIX). */
  rootDirRelative: string;
  files: {
    councilJson: string;
    contextPackMd: string;
    contextManifestJson: string;
    participantArtifacts: string[];
    /** Workspace-relative stderr.log paths for transports that captured stderr. */
    participantStderrLogs: string[];
    /** v0.10.2 — Absolute path to `synthesis/summary.md` (only when synthesizer ran). */
    synthesisSummaryMd?: string;
    returnBriefMd: string;
  };
}

/**
 * v0.10.0 canonical entry point. Runs each participant through its
 * `ParticipantTransport`, persists artifacts, and emits the council event
 * trail. A failed/timeout participant is recorded but the council itself
 * always finalizes as `completed` (partial-result allowed).
 */
export async function runCouncil(opts: CouncilRunnerOptions): Promise<CouncilRunResult> {
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? (() => randomUUID());
  const startedAt = now();

  const councilBaseAbs = path.join(opts.cwd, ...COUNCIL_BASE_REL);
  fs.mkdirSync(councilBaseAbs, { recursive: true });

  const runDirName = nextRunDirName(councilBaseAbs, startedAt);
  const rootDir = path.join(councilBaseAbs, runDirName);
  const rootDirRelative = toPosix(path.join(...COUNCIL_BASE_REL, runDirName));
  fs.mkdirSync(path.join(rootDir, 'participants'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'synthesis'), { recursive: true });

  // 1. Build context pack via the shared builder so caps + secret redaction
  //    apply uniformly. Pass our clock/id seeds so `createdAt` matches the
  //    council run's timestamp.
  const built: BuiltContextPack =
    opts.prebuiltContextPack ??
    buildContextPack({
      cwd: opts.cwd,
      primarySessionId: opts.contextPack.primarySessionId,
      userQuestion: opts.contextPack.userQuestion,
      currentGoal: opts.contextPack.currentGoal,
      recentConversationSummary: opts.contextPack.recentConversationSummary,
      files: opts.contextPack.relevantFiles,
      loadFileContents: opts.contextPack.loadFileContents,
      gitDiff: opts.contextPack.gitDiff,
      testOutput: opts.contextPack.testOutput,
      constraints: opts.contextPack.constraints,
      caps: opts.contextPack.caps,
      now: () => startedAt,
      newId,
    });
  const contextPack = built.pack;

  const contextPackMdAbs = path.join(rootDir, 'context_pack.md');
  fs.writeFileSync(contextPackMdAbs, renderContextPackMarkdown(built), 'utf8');

  const contextManifestJsonAbs = path.join(rootDir, 'context_manifest.json');
  fs.writeFileSync(
    contextManifestJsonAbs,
    JSON.stringify(buildContextManifest(built), null, 2),
    'utf8',
  );

  // 2. Resolve participant specs + transports.
  const fakeSpecs: CouncilParticipantSpec[] =
    opts.participants && opts.participants.length > 0
      ? opts.participants
      : [{ id: 'fake_critic', provider: 'fake', role: 'critic' }];

  const participantBindings = fakeSpecs.map((spec) => {
    const transport: ParticipantTransport =
      spec.transport ?? new FakeParticipantTransport({ body: spec.output });
    const participant: CouncilParticipant = {
      id: spec.id ?? 'fake_critic',
      provider: spec.provider ?? 'fake',
      role: spec.role ?? 'critic',
      transport: transportLabelFor(transport),
    };
    return { participant, spec, transport };
  });
  const participants = participantBindings.map((b) => b.participant);

  const councilRun: CouncilRun = {
    id: runDirName,
    primarySessionId: opts.contextPack.primarySessionId,
    contextPackId: contextPack.id,
    participants,
    status: 'running',
    outputs: [],
    preset: opts.preset,
    createdAt: startedAt.toISOString(),
  };

  const councilJsonAbs = path.join(rootDir, 'council.json');
  fs.writeFileSync(councilJsonAbs, JSON.stringify(councilRun, null, 2), 'utf8');

  // 3. council.opened + context_pack.created.
  safeLog(opts.eventLogger, {
    type: 'council.opened',
    payload: {
      councilRunId: councilRun.id,
      preset: councilRun.preset,
      participantCount: participants.length,
      contextPackId: contextPack.id,
      runDir: rootDirRelative,
      primarySessionId: councilRun.primarySessionId,
    },
  });
  safeLog(opts.eventLogger, {
    type: 'context_pack.created',
    payload: {
      councilRunId: councilRun.id,
      contextPackId: contextPack.id,
      relevantFileCount: contextPack.relevantFiles.length,
      hasDiff: contextPack.gitDiff !== undefined,
      hasTestOutput: contextPack.testOutput !== undefined,
      contextPackPath: toPosix(path.join(rootDirRelative, 'context_pack.md')),
      truncatedSections: built.totals.truncatedSections,
      redactionCount: built.totals.redactionCount,
    },
  });

  // 4. Run participants through their transports.
  const participantArtifacts: string[] = [];
  const participantStderrLogs: string[] = [];
  // v0.10.2 — Collected for the synthesizer to consume.
  const collectedOutputs: Array<{ participantId: string; body: string }> = [];

  for (const { participant, transport } of participantBindings) {
    const partStartedAtDate = now();
    const artifactBasename = `${participant.id}.md`;
    const artifactAbs = path.join(rootDir, 'participants', artifactBasename);
    const artifactRel = toPosix(path.join(rootDirRelative, 'participants', artifactBasename));
    const stderrBasename = `${participant.id}.stderr.log`;
    const stderrAbs = path.join(rootDir, 'participants', stderrBasename);
    const stderrRel = toPosix(path.join(rootDirRelative, 'participants', stderrBasename));

    safeLog(opts.eventLogger, {
      type: 'council.participant.started',
      payload: {
        councilRunId: councilRun.id,
        participantId: participant.id,
        provider: participant.provider,
        role: participant.role,
        transport: participant.transport,
        transportImpl: transport.id,
      },
    });

    const transportResult = await invokeTransportSafely(transport, {
      participant,
      contextPack,
      now,
    });

    fs.writeFileSync(artifactAbs, transportResult.body, 'utf8');
    participantArtifacts.push(artifactAbs);

    let stderrLogRel: string | undefined;
    if (transportResult.stderr && transportResult.stderr.length > 0) {
      fs.writeFileSync(stderrAbs, transportResult.stderr, 'utf8');
      participantStderrLogs.push(stderrRel);
      stderrLogRel = stderrRel;
    }

    const partCompletedAtDate = now();
    const outputStatus: CouncilParticipantOutput['status'] =
      transportResult.status === 'completed' ? 'completed' : 'failed';
    const output: CouncilParticipantOutput = {
      participantId: participant.id,
      status: outputStatus,
      artifactPath: artifactRel,
      summary: firstHeadingOrLine(transportResult.body),
      startedAt: partStartedAtDate.toISOString(),
      completedAt: partCompletedAtDate.toISOString(),
    };
    councilRun.outputs.push(output);
    collectedOutputs.push({ participantId: participant.id, body: transportResult.body });

    if (transportResult.status === 'completed') {
      safeLog(opts.eventLogger, {
        type: 'council.participant.completed',
        payload: {
          councilRunId: councilRun.id,
          participantId: participant.id,
          provider: participant.provider,
          role: participant.role,
          transport: participant.transport,
          transportImpl: transport.id,
          artifactPath: artifactRel,
          stderrPath: stderrLogRel,
          durationMs: transportResult.durationMs,
        },
      });
    } else {
      safeLog(opts.eventLogger, {
        type: 'council.participant.failed',
        level: 'warn',
        payload: {
          councilRunId: councilRun.id,
          participantId: participant.id,
          provider: participant.provider,
          role: participant.role,
          transport: participant.transport,
          transportImpl: transport.id,
          artifactPath: artifactRel,
          stderrPath: stderrLogRel,
          outcome: transportResult.status,
          reason: transportResult.error ?? transportResult.status,
          durationMs: transportResult.durationMs,
        },
      });
    }
  }

  // 4.5. Synthesizer (v0.10.2 — optional). Runs once after participants and
  //      sees `priorOutputs`. Persisted as `synthesis/summary.md`.
  let synthesisSummaryMdAbs: string | undefined;
  let synthesisOutcome: 'completed' | 'failed' | 'timeout' | undefined;
  let synthesisBody: string | undefined;
  if (opts.synthesizer) {
    const synthSpec = opts.synthesizer;
    const synthParticipant: CouncilParticipant = {
      id: synthSpec.id ?? 'synthesizer',
      provider: synthSpec.provider ?? 'fake',
      role: 'synthesizer',
      transport: transportLabelFor(synthSpec.transport),
    };
    safeLog(opts.eventLogger, {
      type: 'council.synthesis.started',
      payload: {
        councilRunId: councilRun.id,
        synthesizerId: synthParticipant.id,
        provider: synthParticipant.provider,
        transport: synthParticipant.transport,
        transportImpl: synthSpec.transport.id,
        priorOutputCount: collectedOutputs.length,
      },
    });
    const synthResult = await invokeTransportSafely(synthSpec.transport, {
      participant: synthParticipant,
      contextPack,
      now,
      priorOutputs: collectedOutputs,
    });
    synthesisOutcome = synthResult.status;
    synthesisBody = synthResult.body;
    synthesisSummaryMdAbs = path.join(rootDir, 'synthesis', 'summary.md');
    fs.writeFileSync(synthesisSummaryMdAbs, synthResult.body, 'utf8');
    safeLog(opts.eventLogger, {
      type: 'council.synthesis.completed',
      level: synthResult.status === 'completed' ? 'info' : 'warn',
      payload: {
        councilRunId: councilRun.id,
        synthesizerId: synthParticipant.id,
        provider: synthParticipant.provider,
        transport: synthParticipant.transport,
        transportImpl: synthSpec.transport.id,
        outcome: synthResult.status,
        summaryPath: toPosix(path.join(rootDirRelative, 'synthesis', 'summary.md')),
        durationMs: synthResult.durationMs,
        reason: synthResult.error,
      },
    });
  }

  // 5. Return brief.
  const returnBriefAbs = path.join(rootDir, 'synthesis', 'return_brief.md');
  const returnBriefRel = toPosix(path.join(rootDirRelative, 'synthesis', 'return_brief.md'));
  const synthesizerRan = opts.synthesizer !== undefined;
  const synthesisFailed =
    synthesizerRan && synthesisOutcome !== undefined && synthesisOutcome !== 'completed';
  const recommendedAction = synthesizerRan
    ? synthesisFailed
      ? 'Synthesizer failed to complete. Read participant artifacts directly and decide manually.'
      : 'Read synthesis/summary.md first; participant artifacts back it up.'
    : 'Review the council brief in detail before continuing the primary session.';
  const risks: string[] = [
    'v0.10.0 council still permits fake transports; verify each participant ran a real transport before acting on its output.',
  ];
  if (synthesisFailed) {
    risks.push(`Synthesizer reported ${synthesisOutcome}; the brief reflects raw participant outputs only.`);
  }
  const returnBrief: ReturnBrief = {
    id: `brief_${newId()}`,
    councilRunId: councilRun.id,
    injectText: renderInjectText(contextPack, councilRun, synthesizerRan, synthesisFailed),
    detailArtifactPath: returnBriefRel,
    recommendedAction,
    disagreements: [],
    risks,
    createdAt: now().toISOString(),
  };
  fs.writeFileSync(
    returnBriefAbs,
    renderReturnBriefMarkdown(returnBrief, councilRun, contextPack),
    'utf8',
  );

  // 6. Mark the run completed (partial-result allowed) and rewrite council.json.
  councilRun.status = 'completed';
  councilRun.completedAt = now().toISOString();
  fs.writeFileSync(councilJsonAbs, JSON.stringify(councilRun, null, 2), 'utf8');

  safeLog(opts.eventLogger, {
    type: 'council.brief.created',
    payload: {
      councilRunId: councilRun.id,
      returnBriefId: returnBrief.id,
      returnBriefPath: returnBriefRel,
      participantCount: councilRun.outputs.length,
      failedParticipantCount: councilRun.outputs.filter((o) => o.status === 'failed').length,
    },
  });

  return {
    run: councilRun,
    contextPack,
    builtContextPack: built,
    returnBrief,
    rootDir,
    rootDirRelative,
    files: {
      councilJson: councilJsonAbs,
      contextPackMd: contextPackMdAbs,
      contextManifestJson: contextManifestJsonAbs,
      participantArtifacts,
      participantStderrLogs,
      synthesisSummaryMd: synthesisSummaryMdAbs,
      returnBriefMd: returnBriefAbs,
    },
  };
}

/**
 * Backward-compatible alias retained for v0.9.6/v0.9.7 callers and tests.
 * Behaviour is identical to `runCouncil`. Prefer `runCouncil` for new code.
 */
export const runFakeCouncil = runCouncil;

async function invokeTransportSafely(
  transport: ParticipantTransport,
  call: ParticipantInvocation,
) {
  // Transports must not throw, but a future implementation could regress.
  // Catch here so the council always finalizes.
  try {
    return await transport.invoke(call);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed' as const,
      body: `# ${call.participant.id} did not complete\n\nReason: transport threw: ${message}\n`,
      error: `transport threw: ${message}`,
      durationMs: 0,
    };
  }
}

function safeLog(logger: EventLogger | undefined, input: EventInput): void {
  if (!logger) return;
  try {
    logger.log(input);
  } catch {
    // EventLogger.log is "never throw", but a future variant could regress.
  }
}

function pad(n: number, width = 2): string {
  return n.toString().padStart(width, '0');
}

function nextRunDirName(councilBaseAbs: string, now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const prefix = `council_${yyyy}${mm}${dd}_`;
  let existing: string[] = [];
  try {
    existing = fs.readdirSync(councilBaseAbs).filter((n) => n.startsWith(prefix));
  } catch {
    existing = [];
  }
  const seqs = existing
    .map((n) => Number(n.slice(prefix.length)))
    .filter((n) => Number.isInteger(n) && n > 0);
  const next = (seqs.length > 0 ? Math.max(...seqs) : 0) + 1;
  return `${prefix}${pad(next, 3)}`;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function firstHeadingOrLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.replace(/^#+\s*/, '').slice(0, 200);
  }
  return '';
}

function renderInjectText(
  pack: ContextPack,
  run: CouncilRun,
  synthesizerRan = false,
  synthesisFailed = false,
): string {
  const failed = run.outputs.filter((o) => o.status === 'failed').length;
  const failureNote = failed > 0 ? ` (${failed} failed)` : '';
  const lines = [
    `Council run ${run.id} (${run.outputs.length} participant(s)${failureNote}):`,
    `Question: ${pack.userQuestion}`,
  ];
  if (synthesizerRan && !synthesisFailed) {
    lines.push(`See ${run.id}/synthesis/summary.md for the synthesis, return_brief.md for context.`);
  } else if (synthesizerRan && synthesisFailed) {
    lines.push(`Synthesizer did not complete; see ${run.id}/synthesis/return_brief.md and the participant artifacts.`);
  } else {
    lines.push(`See ${run.id}/synthesis/return_brief.md for the full brief.`);
  }
  return lines.join('\n');
}

function renderReturnBriefMarkdown(
  brief: ReturnBrief,
  run: CouncilRun,
  pack: ContextPack,
): string {
  const outputs =
    run.outputs
      .map((o) => `- ${o.participantId} (${o.status}) → ${o.artifactPath}`)
      .join('\n') || '- (none)';
  const risks = brief.risks.length ? brief.risks.map((r) => `- ${r}`).join('\n') : '- (none)';
  const disagreements = brief.disagreements.length
    ? brief.disagreements.map((d) => `- ${d}`).join('\n')
    : '- (none)';
  return [
    `# Return brief ${brief.id}`,
    ``,
    `- **Council run**: ${run.id}`,
    `- **Primary session**: ${run.primarySessionId}`,
    `- **Status**: ${run.status}`,
    `- **Created at**: ${brief.createdAt}`,
    ``,
    `## Recommendation`,
    brief.recommendedAction,
    ``,
    `## Inject text (paste into primary session)`,
    '```',
    brief.injectText,
    '```',
    ``,
    `## Disagreements`,
    disagreements,
    ``,
    `## Risks`,
    risks,
    ``,
    `## Participant outputs`,
    outputs,
    ``,
    `## Original question`,
    pack.userQuestion || '_(empty)_',
    ``,
  ].join('\n');
}
