// v0.10.1 — Codex / Gemini participant transport wrapper unit tests.
//
// We do NOT spawn real `codex` / `gemini` CLIs (would require user-side
// install + auth). Instead we inject `spawnImpl` and verify:
//   - the wrapper passes the correct default command + label,
//   - the prompt template is wired into stdin,
//   - the underlying HeadlessProcessTransport plumbing (timeout, exit
//     code, stderr capture) still applies.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import {
  CodexParticipantTransport,
  GeminiParticipantTransport,
  HeadlessProcessTransport,
  transportLabelFor,
  type ParticipantInvocation,
} from '../../src/orchestration/core/council/ParticipantTransport';

function fakeInvocation(): ParticipantInvocation {
  return {
    participant: {
      id: 'p1',
      provider: 'codex',
      role: 'critic',
      transport: 'headless',
    },
    contextPack: {
      id: 'cpack',
      primarySessionId: 'ps',
      userQuestion: 'Is X safe?',
      currentGoal: 'ship safely',
      recentConversationSummary: 'we discussed X earlier',
      relevantFiles: [],
      constraints: ['no secret leak'],
      createdAt: '2026-04-24T00:00:00.000Z',
    },
    now: () => new Date(),
  };
}

/**
 * Minimal ChildProcess fake: captures stdin writes, lets the test push
 * stdout/stderr chunks and an exit code. Compatible with the subset of
 * the ChildProcess API that HeadlessProcessTransport touches.
 */
function makeFakeChild() {
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinChunks: string[] = [];
  const child = new EventEmitter() as any;
  child.stdout = stdoutEmitter;
  child.stderr = stderrEmitter;
  child.stdin = {
    write(chunk: string) {
      stdinChunks.push(chunk);
      return true;
    },
    end() {
      /* no-op */
    },
  };
  child.kill = () => true;
  return {
    child,
    stdoutEmitter,
    stderrEmitter,
    stdinChunks,
    fireStdout: (s: string) => stdoutEmitter.emit('data', Buffer.from(s)),
    fireStderr: (s: string) => stderrEmitter.emit('data', Buffer.from(s)),
    close: (code: number) => child.emit('close', code, null),
  };
}

test('CodexParticipantTransport: default id is codex-headless and label resolves to headless', () => {
  const t = new CodexParticipantTransport();
  assert.equal(t.id, 'codex-headless');
  assert.equal(transportLabelFor(t), 'headless');
});

test('GeminiParticipantTransport: default id is gemini-headless and label resolves to headless', () => {
  const t = new GeminiParticipantTransport();
  assert.equal(t.id, 'gemini-headless');
  assert.equal(transportLabelFor(t), 'headless');
});

test('CodexParticipantTransport: spawns the codex command by default and pipes prompt into stdin', async () => {
  let recordedCommand = '';
  let recordedArgs: string[] = [];
  const fake = makeFakeChild();
  const t = new CodexParticipantTransport({
    spawnImpl: ((command: string, args: string[]) => {
      recordedCommand = command;
      recordedArgs = args;
      // Resolve the spawn synchronously; the transport will hook listeners
      // immediately, so we can fire stdout right after.
      setImmediate(() => {
        fake.fireStdout('# from codex\n\nbody\n');
        fake.close(0);
      });
      return fake.child;
    }) as any,
    timeoutMs: 5000,
  });

  const result = await t.invoke(fakeInvocation());
  assert.equal(recordedCommand, 'codex');
  assert.deepEqual(recordedArgs, []);
  assert.equal(result.status, 'completed');
  assert.match(result.body, /from codex/);

  // Prompt template includes Podium council marker + the user question.
  const stdinJoined = fake.stdinChunks.join('');
  assert.match(stdinJoined, /Podium council participant — Codex/);
  assert.match(stdinJoined, /Is X safe\?/);
  assert.match(stdinJoined, /no secret leak/);
});

test('GeminiParticipantTransport: spawns gemini by default with markdown-style prompt', async () => {
  let recordedCommand = '';
  const fake = makeFakeChild();
  const t = new GeminiParticipantTransport({
    spawnImpl: ((command: string) => {
      recordedCommand = command;
      setImmediate(() => {
        fake.fireStdout('## answer\n\nok\n');
        fake.close(0);
      });
      return fake.child;
    }) as any,
    timeoutMs: 5000,
  });

  const result = await t.invoke(fakeInvocation());
  assert.equal(recordedCommand, 'gemini');
  assert.equal(result.status, 'completed');
  const stdinJoined = fake.stdinChunks.join('');
  assert.match(stdinJoined, /Podium council participant — Gemini/);
  assert.match(stdinJoined, /Is X safe\?/);
});

test('CodexParticipantTransport: nonzero exit code surfaces failed status with stderr', async () => {
  const fake = makeFakeChild();
  const t = new CodexParticipantTransport({
    spawnImpl: (() => {
      setImmediate(() => {
        fake.fireStderr('codex: not authenticated\n');
        fake.close(1);
      });
      return fake.child;
    }) as any,
    timeoutMs: 5000,
  });

  const result = await t.invoke(fakeInvocation());
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /exit code 1/);
  assert.equal(result.stderr, 'codex: not authenticated\n');
});

test('GeminiParticipantTransport: spawn throw becomes failed status (CLI not installed)', async () => {
  const t = new GeminiParticipantTransport({
    spawnImpl: (() => {
      throw new Error('ENOENT: gemini not on PATH');
    }) as any,
  });
  const result = await t.invoke(fakeInvocation());
  assert.equal(result.status, 'failed');
  assert.match(result.body, /spawn failed/);
  assert.match(result.error ?? '', /ENOENT/);
});

test('CodexParticipantTransport: caller can override args (real Codex CLI flags)', () => {
  const t = new CodexParticipantTransport({ args: ['exec', '--headless', '--json'] });
  // The transport stamps id but its parent class consumes args internally;
  // we can at least assert the public surface.
  assert.equal(t.id, 'codex-headless');
  assert.ok(t instanceof HeadlessProcessTransport, 'wrapper should extend HeadlessProcessTransport');
});

test('transportLabelFor: pattern matches new wrapper ids', () => {
  // Synthetic transports — verify the regex-style resolution works for
  // any future *-headless / *-process wrapper without a code change.
  const fake = { id: 'claude-headless', invoke: async () => ({} as any) };
  assert.equal(transportLabelFor(fake as any), 'headless');
  const ptyish = { id: 'pty-claude', invoke: async () => ({} as any) };
  assert.equal(transportLabelFor(ptyish as any), 'pty');
});
