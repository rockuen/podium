import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  PODIUM_LEADER_SYSTEM_PROMPT,
  PODIUM_LEADER_DISALLOWED_TOOLS,
  buildLeaderExtraArgs,
  buildLeaderSystemPrompt,
} from '../../src/orchestration/core/leaderProtocol';

test('leaderProtocol: system prompt teaches @worker-N routing syntax', () => {
  assert.ok(PODIUM_LEADER_SYSTEM_PROMPT.includes('@worker-1:'));
  assert.ok(PODIUM_LEADER_SYSTEM_PROMPT.includes('@worker-2:'));
  assert.ok(/Task tool is disabled/i.test(PODIUM_LEADER_SYSTEM_PROMPT));
});

test('leaderProtocol: Task is the only disallowed tool', () => {
  assert.deepEqual([...PODIUM_LEADER_DISALLOWED_TOOLS], ['Task']);
});

test('leaderProtocol: buildLeaderExtraArgs yields the expected CLI tail', () => {
  const args = buildLeaderExtraArgs();

  const disallowedIdx = args.indexOf('--disallowedTools');
  assert.ok(disallowedIdx >= 0, '--disallowedTools flag must be present');
  assert.equal(args[disallowedIdx + 1], 'Task');

  const appendIdx = args.indexOf('--append-system-prompt');
  assert.ok(appendIdx >= 0, '--append-system-prompt flag must be present');
  assert.equal(args[appendIdx + 1], PODIUM_LEADER_SYSTEM_PROMPT);
});

test('leaderProtocol: buildLeaderExtraArgs with resumeSessionId prepends --resume', () => {
  const uuid = '010bd23c-609e-4216-bbe8-372d14c5baa2';
  const args = buildLeaderExtraArgs({ resumeSessionId: uuid });
  assert.equal(args[0], '--resume');
  assert.equal(args[1], uuid);
  // Task block + protocol prompt must still follow.
  assert.ok(args.includes('--disallowedTools'));
  assert.ok(args.includes('Task'));
  assert.ok(args.includes('--append-system-prompt'));
});

test('leaderProtocol: buildLeaderExtraArgs without options omits --resume', () => {
  const args = buildLeaderExtraArgs();
  assert.ok(!args.includes('--resume'), 'bare call must not add --resume');
  assert.equal(args[0], '--disallowedTools');
});

test('leaderProtocol: system prompt stays under ~500 tokens (≈2000 chars)', () => {
  // Guardrail to keep the leader's per-session context cost bounded.
  // A lightweight heuristic — real tokenization isn't required here.
  assert.ok(
    PODIUM_LEADER_SYSTEM_PROMPT.length < 2000,
    `prompt is ${PODIUM_LEADER_SYSTEM_PROMPT.length} chars — trim it`,
  );
});

test('leaderProtocol v0.3.0: role-aware prompt embeds roster + bidirectional rules', () => {
  const prompt = buildLeaderSystemPrompt({
    workers: [
      { id: 'worker-1', role: 'implementer' },
      { id: 'worker-2', role: 'critic' },
    ],
    maxRoundsPerTask: 5,
  });
  assert.ok(prompt.includes('worker-1'));
  assert.ok(prompt.includes('implementer'));
  assert.ok(prompt.includes('worker-2'));
  assert.ok(prompt.includes('critic'));
  assert.ok(prompt.includes('@leader:'));
  assert.ok(prompt.includes('BIDIRECTIONAL'));
  assert.ok(prompt.includes('5 total'));
});

test('leaderProtocol v0.3.0: empty roster falls back to the legacy prompt', () => {
  const prompt = buildLeaderSystemPrompt({ workers: [] });
  assert.equal(prompt, PODIUM_LEADER_SYSTEM_PROMPT);
});

test('leaderProtocol v0.3.0: buildLeaderExtraArgs with workers uses dynamic prompt', () => {
  const args = buildLeaderExtraArgs({
    workers: [{ id: 'worker-1', role: 'implementer' }],
    maxRoundsPerTask: 3,
  });
  const promptIdx = args.indexOf('--append-system-prompt');
  const prompt = args[promptIdx + 1];
  assert.notEqual(prompt, PODIUM_LEADER_SYSTEM_PROMPT);
  assert.ok(prompt.includes('implementer'));
});
