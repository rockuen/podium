// v0.10.0 — Participant transport abstraction.
// v0.10.1 — Adds CodexParticipantTransport and GeminiParticipantTransport
//           thin wrappers around HeadlessProcessTransport with sensible
//           default command + prompt templates. HeadlessProcessTransport
//           now accepts an `id` override so wrappers can stamp their own
//           telemetry id while reusing the spawn/timeout/stderr machinery.
// v0.10.2 — Adds optional `priorOutputs` to ParticipantInvocation so a
//           synthesizer-style transport can see what the participants
//           produced. Default-undefined for first-pass participants.
//
// A `ParticipantTransport` turns an in-memory `CouncilParticipant` +
// `ContextPack` into a markdown body (and optional stderr capture) that the
// council writer persists. The interface is provider-neutral and async so
// real-CLI bindings (Codex / Gemini wrappers below) plug in without
// changing the runner contract.
//
// Design rules followed here:
//   - VS Code runtime is not required. Only `node:child_process` and types
//     from `./types`. Tests can inject a fake `spawnImpl`.
//   - Transports must NOT throw. Every error path resolves the returned
//     Promise with `status: 'failed' | 'timeout'`.
//   - Transports do NOT touch the filesystem. The runner persists bodies,
//     stderr logs, and synthesis summaries.

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { ContextPack, CouncilParticipant } from './types';

export interface ParticipantInvocation {
  participant: CouncilParticipant;
  contextPack: ContextPack;
  /** Test seam: clock injected by the runner. */
  now: () => Date;
  /**
   * v0.10.2 — Prior participant outputs visible to a synthesizer transport.
   * Always undefined for first-pass participants. Synthesizer-style
   * transports may render these into the stdin prompt.
   */
  priorOutputs?: Array<{ participantId: string; body: string }>;
}

export type ParticipantTransportStatus = 'completed' | 'failed' | 'timeout';

export interface ParticipantTransportResult {
  status: ParticipantTransportStatus;
  /** Markdown body to persist as `participants/<id>.md`. Always present. */
  body: string;
  /** Captured stderr (process transports). Persisted as `<id>.stderr.log`. */
  stderr?: string;
  /** Short reason string for failed/timeout outcomes. */
  error?: string;
  /** Wall-clock duration of the invocation in ms. */
  durationMs: number;
}

export interface ParticipantTransport {
  /** Stable id used for telemetry and to derive `participant.transport`. */
  readonly id: string;
  invoke(call: ParticipantInvocation): Promise<ParticipantTransportResult>;
}

// ---------------------------------------------------------------------------
// FakeParticipantTransport
// ---------------------------------------------------------------------------

export interface FakeParticipantTransportOptions {
  /** Override the body. Defaults to a deterministic stub. */
  body?: string;
  /** Force a non-completed outcome (tests for the failure path). */
  outcome?: ParticipantTransportStatus;
  errorMessage?: string;
  /** Optional stderr to surface (so the runner exercises stderr.log writing). */
  stderr?: string;
}

export class FakeParticipantTransport implements ParticipantTransport {
  readonly id = 'fake';
  constructor(private readonly opts: FakeParticipantTransportOptions = {}) {}

  async invoke(call: ParticipantInvocation): Promise<ParticipantTransportResult> {
    const startedAt = call.now();
    const outcome = this.opts.outcome ?? 'completed';
    const completedAt = call.now();
    const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());

    if (outcome === 'completed') {
      const body = this.opts.body ?? renderFakeStub(call.participant, call.contextPack);
      return {
        status: 'completed',
        body,
        stderr: this.opts.stderr,
        durationMs,
      };
    }

    return {
      status: outcome,
      body:
        this.opts.body ??
        renderFailureStub(call.participant, outcome, this.opts.errorMessage),
      stderr: this.opts.stderr,
      error: this.opts.errorMessage ?? `outcome=${outcome}`,
      durationMs,
    };
  }
}

function renderFakeStub(p: CouncilParticipant, pack: ContextPack): string {
  return [
    `# Fake council participant: ${p.id}`,
    ``,
    `> v0.10.0 fake transport. No real model was called.`,
    ``,
    `- **Role**: ${p.role}`,
    `- **Provider**: ${p.provider}`,
    `- **Transport**: ${p.transport}`,
    ``,
    `## Main judgment`,
    `Reviewed the user question without invoking a model: "${pack.userQuestion}".`,
    ``,
    `## Risks`,
    `- This is fake output; do not treat it as a real second opinion.`,
    ``,
    `## Missing information`,
    `- Wire CodexParticipantTransport / GeminiParticipantTransport in production usage.`,
    ``,
    `## Recommended next action`,
    `- Toggle a real transport or run \`Podium: Consult Other Models\` with one configured.`,
    ``,
    `## Confidence`,
    `low (synthetic)`,
    ``,
  ].join('\n');
}

function renderFailureStub(
  p: CouncilParticipant,
  outcome: 'failed' | 'timeout',
  message: string | undefined,
): string {
  return [
    `# ${p.id} did not complete (${outcome})`,
    ``,
    message ?? '_(no message)_',
    ``,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// HeadlessProcessTransport
// ---------------------------------------------------------------------------

export interface HeadlessProcessTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Default 60s. Beyond this the child receives SIGKILL. */
  timeoutMs?: number;
  /** Override stdin payload. Defaults to the council prompt template. */
  buildStdin?: (call: ParticipantInvocation) => string;
  /** Test seam — inject a fake spawn implementation. */
  spawnImpl?: typeof spawn;
  /**
   * v0.10.1 — Override the transport id (telemetry / participant.transport
   * label). Default `'headless-process'`. Wrapper subclasses use this to
   * stamp `'codex-headless'` / `'gemini-headless'`.
   */
  id?: string;
}

export class HeadlessProcessTransport implements ParticipantTransport {
  readonly id: string;

  constructor(private readonly opts: HeadlessProcessTransportOptions) {
    this.id = opts.id ?? 'headless-process';
  }

  async invoke(call: ParticipantInvocation): Promise<ParticipantTransportResult> {
    const startedAt = call.now();
    const spawnFn = this.opts.spawnImpl ?? spawn;
    const args = this.opts.args ?? [];
    const spawnOpts: SpawnOptions = {
      cwd: this.opts.cwd,
      env: this.opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    const stdinPayload = this.opts.buildStdin
      ? this.opts.buildStdin(call)
      : defaultStdin(call);
    const timeoutMs = this.opts.timeoutMs ?? 60_000;

    let child: ChildProcess;
    try {
      child = spawnFn(this.opts.command, args, spawnOpts);
    } catch (err) {
      const completedAt = call.now();
      const reason = (err as Error).message ?? String(err);
      return {
        status: 'failed',
        body: failureBody(call.participant, `spawn failed: ${reason}`, ''),
        error: reason,
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      };
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited — nothing to do.
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));

    if (child.stdin && stdinPayload.length > 0) {
      try {
        child.stdin.write(stdinPayload);
      } catch {
        // EPIPE — the child might have exited before stdin was consumed.
      }
      try {
        child.stdin.end();
      } catch {
        // Ditto.
      }
    }

    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      child.on('error', (err) => resolve({ code: null, signal: null, error: err }));
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);

    const completedAt = call.now();
    const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
    const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
    const stderrText = Buffer.concat(stderrChunks).toString('utf8');

    if (timedOut) {
      return {
        status: 'timeout',
        body: failureBody(call.participant, `timed out after ${timeoutMs}ms`, stdoutText),
        stderr: stderrText.length > 0 ? stderrText : undefined,
        error: `timeout after ${timeoutMs}ms`,
        durationMs,
      };
    }

    if (exit.error || (exit.code !== null && exit.code !== 0) || (exit.signal && !timedOut)) {
      const reason =
        exit.error?.message ??
        (exit.signal
          ? `signal ${exit.signal}`
          : `exit code ${exit.code}`);
      return {
        status: 'failed',
        body: failureBody(call.participant, reason, stdoutText),
        stderr: stderrText.length > 0 ? stderrText : undefined,
        error: reason,
        durationMs,
      };
    }

    return {
      status: 'completed',
      body:
        stdoutText.trim().length > 0
          ? stdoutText
          : `# ${call.participant.id} produced no stdout\n`,
      stderr: stderrText.length > 0 ? stderrText : undefined,
      durationMs,
    };
  }
}

function failureBody(
  p: CouncilParticipant,
  reason: string,
  capturedStdout: string,
): string {
  const tail =
    capturedStdout.trim().length > 0
      ? '\n\n## Captured stdout before failure\n\n```\n' + capturedStdout + '\n```\n'
      : '';
  return [`# ${p.id} did not complete`, ``, `Reason: ${reason}`, tail].join('\n');
}

function defaultStdin(call: ParticipantInvocation): string {
  return [
    `You are a council participant in Podium.`,
    `Role: ${call.participant.role}`,
    ``,
    `Task:`,
    call.contextPack.userQuestion,
    ``,
    `Context:`,
    call.contextPack.recentConversationSummary || '(no recent conversation summary provided)',
    ``,
    `Return:`,
    `1. Main judgment`,
    `2. Risks`,
    `3. Missing information`,
    `4. Recommended next action`,
    `5. Confidence`,
    ``,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CodexParticipantTransport (v0.10.1)
// ---------------------------------------------------------------------------

export interface CodexParticipantTransportOptions {
  /** Default `'codex'`. Override for an absolute path or alternative binary. */
  command?: string;
  /**
   * Default `[]`. Codex CLI flags vary across versions; callers that know
   * their binary's headless mode should pass them explicitly (e.g.
   * `['exec', '--headless']`). The wrapper does not assume one shape.
   */
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Override the prompt template. Defaults to `buildCodexStdin` below. */
  buildStdin?: (call: ParticipantInvocation) => string;
  spawnImpl?: typeof spawn;
}

export class CodexParticipantTransport extends HeadlessProcessTransport {
  constructor(opts: CodexParticipantTransportOptions = {}) {
    super({
      id: 'codex-headless',
      command: opts.command ?? 'codex',
      args: opts.args ?? [],
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      buildStdin: opts.buildStdin ?? buildCodexStdin,
      spawnImpl: opts.spawnImpl,
    });
  }
}

function buildCodexStdin(call: ParticipantInvocation): string {
  return [
    `[Podium council participant — Codex]`,
    `Role: ${call.participant.role}`,
    ``,
    `User question:`,
    call.contextPack.userQuestion,
    ``,
    `Goal:`,
    call.contextPack.currentGoal || '(none provided)',
    ``,
    `Recent conversation summary:`,
    call.contextPack.recentConversationSummary || '(none)',
    ``,
    `Constraints:`,
    call.contextPack.constraints.length > 0
      ? call.contextPack.constraints.map((c) => `- ${c}`).join('\n')
      : '- (none)',
    ``,
    `Reply with: main judgment, risks, missing info, recommended next action, confidence.`,
    ``,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// GeminiParticipantTransport (v0.10.1)
// ---------------------------------------------------------------------------

export interface GeminiParticipantTransportOptions {
  /** Default `'gemini'`. */
  command?: string;
  /** Default `[]`. Pass e.g. `['--prompt', '-']` if your CLI takes stdin. */
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  buildStdin?: (call: ParticipantInvocation) => string;
  spawnImpl?: typeof spawn;
}

export class GeminiParticipantTransport extends HeadlessProcessTransport {
  constructor(opts: GeminiParticipantTransportOptions = {}) {
    super({
      id: 'gemini-headless',
      command: opts.command ?? 'gemini',
      args: opts.args ?? [],
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      buildStdin: opts.buildStdin ?? buildGeminiStdin,
      spawnImpl: opts.spawnImpl,
    });
  }
}

function buildGeminiStdin(call: ParticipantInvocation): string {
  return [
    `# Podium council participant — Gemini`,
    ``,
    `Role: ${call.participant.role}`,
    ``,
    `## User question`,
    call.contextPack.userQuestion,
    ``,
    `## Goal`,
    call.contextPack.currentGoal || '(none provided)',
    ``,
    `## Recent conversation`,
    call.contextPack.recentConversationSummary || '(none)',
    ``,
    `## Constraints`,
    call.contextPack.constraints.length > 0
      ? call.contextPack.constraints.map((c) => `- ${c}`).join('\n')
      : '- (none)',
    ``,
    `Please respond with five sections: Main judgment, Risks, Missing information, Recommended next action, Confidence.`,
    ``,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Label resolution
// ---------------------------------------------------------------------------

/**
 * Map a transport implementation id back to the metadata label that goes
 * onto `participant.transport`. Pattern-based so future wrappers (e.g.
 * `claude-headless`, `pty-codex`) get classified without code changes.
 */
export function transportLabelFor(t: ParticipantTransport): 'fake' | 'headless' | 'pty' {
  if (t.id === 'fake') return 'fake';
  if (t.id.includes('pty')) return 'pty';
  if (t.id.includes('headless') || t.id.includes('process')) return 'headless';
  return 'fake';
}
