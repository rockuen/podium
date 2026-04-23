import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  WORKER_ROLES,
  WORKER_ROLE_DESCRIPTIONS,
  buildWorkerSystemPrompt,
  buildWorkerExtraArgs,
  PODIUM_WORKER_DISALLOWED_TOOLS,
  type WorkerRole,
} from '../../src/orchestration/core/workerProtocol';

test('workerProtocol: every role in WORKER_ROLES has a description', () => {
  for (const role of WORKER_ROLES) {
    assert.ok(
      WORKER_ROLE_DESCRIPTIONS[role] && WORKER_ROLE_DESCRIPTIONS[role].length > 0,
      `role "${role}" needs a description`,
    );
  }
});

test('workerProtocol: system prompt mentions worker id, role, and @leader/@worker routing', () => {
  const prompt = buildWorkerSystemPrompt({
    workerId: 'worker-1',
    role: 'implementer',
    peers: [{ id: 'worker-2', role: 'critic' }],
  });
  assert.ok(prompt.includes('worker-1'));
  assert.ok(prompt.includes('implementer'));
  assert.ok(prompt.includes('worker-2'));
  assert.ok(prompt.includes('critic'));
  assert.ok(prompt.includes('@leader:'));
  assert.ok(prompt.includes('@worker-N:'));
  assert.ok(/Task tool is disabled/i.test(prompt));
});

test('workerProtocol: empty peers list still produces a valid prompt', () => {
  const prompt = buildWorkerSystemPrompt({
    workerId: 'worker-1',
    role: 'generalist',
    peers: [],
  });
  assert.ok(prompt.includes('worker-1'));
  assert.ok(prompt.includes('no other workers'));
});

test('workerProtocol: buildWorkerExtraArgs yields disallowedTools + append-system-prompt', () => {
  const args = buildWorkerExtraArgs({
    workerId: 'worker-1',
    role: 'implementer',
    peers: [{ id: 'worker-2', role: 'critic' }],
  });
  const disallowedIdx = args.indexOf('--disallowedTools');
  assert.ok(disallowedIdx >= 0);
  assert.equal(args[disallowedIdx + 1], 'Task');
  const appendIdx = args.indexOf('--append-system-prompt');
  assert.ok(appendIdx >= 0);
  const prompt = args[appendIdx + 1];
  assert.ok(prompt.includes('worker-1'));
  assert.ok(prompt.includes('implementer'));
});

test('workerProtocol: resumeSessionId prefixes args with --resume', () => {
  const args = buildWorkerExtraArgs({
    workerId: 'worker-1',
    role: 'implementer',
    peers: [],
    resumeSessionId: 'abc-123-def',
  });
  assert.equal(args[0], '--resume');
  assert.equal(args[1], 'abc-123-def');
});

test('workerProtocol: Task is the only disallowed tool', () => {
  assert.deepEqual([...PODIUM_WORKER_DISALLOWED_TOOLS], ['Task']);
});

test('workerProtocol: exhaustive role coverage (compile-time safety)', () => {
  // If a new role is added without a description entry this assert fails.
  const roles: Record<WorkerRole, boolean> = {
    implementer: true,
    critic: true,
    tester: true,
    researcher: true,
    generalist: true,
  };
  for (const role of Object.keys(roles) as WorkerRole[]) {
    assert.ok(WORKER_ROLE_DESCRIPTIONS[role]);
  }
});
