// v0.10.x — runConsultOthersFlow unit tests.
//
// The flow is the testable core of the
// `claudeCodeLauncher.podium.consultOthers` VS Code command. Tests inject
// the dep object so no `vscode` import is needed.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runConsultOthersFlow,
  type ConsultOthersDeps,
} from '../../src/orchestration/core/council/CouncilUI';
import { FakeParticipantTransport } from '../../src/orchestration/core/council/ParticipantTransport';

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeDeps(overrides: Partial<ConsultOthersDeps> = {}): {
  deps: ConsultOthersDeps;
  notifications: string[];
  shown: string[];
} {
  const notifications: string[] = [];
  const shown: string[] = [];
  const deps: ConsultOthersDeps = {
    promptForQuestion: async () => 'Is this design right?',
    getWorkspaceCwd: () => undefined,
    getActiveFile: () => undefined,
    getGitDiff: async () => undefined,
    notify: (msg) => notifications.push(msg),
    showFile: async (p) => {
      shown.push(p);
    },
    ...overrides,
  };
  return { deps, notifications, shown };
}

test('runConsultOthersFlow: cancels when no workspace is open and notifies', async () => {
  const { deps, notifications } = makeDeps({ getWorkspaceCwd: () => undefined });
  const outcome = await runConsultOthersFlow(deps);
  assert.equal(outcome.status, 'cancelled');
  if (outcome.status === 'cancelled') assert.equal(outcome.reason, 'no-workspace');
  assert.ok(notifications.some((n) => /open a workspace/i.test(n)));
});

test('runConsultOthersFlow: cancels when user provides no question', async () => {
  const cwd = mkTmp('podium-ui-');
  const { deps } = makeDeps({
    getWorkspaceCwd: () => cwd,
    promptForQuestion: async () => undefined,
  });
  const outcome = await runConsultOthersFlow(deps);
  assert.equal(outcome.status, 'cancelled');
  if (outcome.status === 'cancelled') assert.equal(outcome.reason, 'no-question');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('runConsultOthersFlow: cancels when user provides whitespace-only question', async () => {
  const cwd = mkTmp('podium-ui-');
  const { deps } = makeDeps({
    getWorkspaceCwd: () => cwd,
    promptForQuestion: async () => '   ',
  });
  const outcome = await runConsultOthersFlow(deps);
  assert.equal(outcome.status, 'cancelled');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('runConsultOthersFlow: happy path produces council artifacts and opens return brief', async () => {
  const cwd = mkTmp('podium-ui-');
  const { deps, notifications, shown } = makeDeps({
    getWorkspaceCwd: () => cwd,
    promptForQuestion: async () => 'Should I split this PR?',
  });
  const outcome = await runConsultOthersFlow(deps);
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;

  // Council directory + artifacts created under .omc/team/council/.
  assert.ok(fs.existsSync(outcome.result.files.councilJson));
  assert.ok(fs.existsSync(outcome.result.files.contextPackMd));
  assert.ok(fs.existsSync(outcome.result.files.returnBriefMd));

  // The return brief was opened in the editor (via deps.showFile).
  assert.equal(shown.length, 1);
  assert.equal(shown[0], outcome.result.files.returnBriefMd);

  // The user got a completion notification with the council id.
  assert.ok(notifications.some((n) => n.includes(outcome.result.run.id)));

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('runConsultOthersFlow: active file is captured into relevantFiles (relative POSIX path)', async () => {
  const cwd = mkTmp('podium-ui-');
  const filePath = path.join(cwd, 'src', 'foo.ts');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'export const x = 1;\n', 'utf8');

  const { deps } = makeDeps({
    getWorkspaceCwd: () => cwd,
    getActiveFile: () => ({ absPath: filePath }),
    promptForQuestion: async () => 'Q',
  });
  const outcome = await runConsultOthersFlow(deps);
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;

  const md = fs.readFileSync(outcome.result.files.contextPackMd, 'utf8');
  assert.match(md, /src\/foo\.ts/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('runConsultOthersFlow: dirty buffer content is preferred over disk read', async () => {
  const cwd = mkTmp('podium-ui-');
  const filePath = path.join(cwd, 'a.ts');
  fs.writeFileSync(filePath, 'on-disk content\n', 'utf8');

  const { deps } = makeDeps({
    getWorkspaceCwd: () => cwd,
    getActiveFile: () => ({ absPath: filePath, content: 'unsaved buffer text' }),
    promptForQuestion: async () => 'Q',
  });
  const outcome = await runConsultOthersFlow(deps);
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;

  const md = fs.readFileSync(outcome.result.files.contextPackMd, 'utf8');
  assert.match(md, /unsaved buffer text/);
  assert.ok(!md.includes('on-disk content'), 'dirty buffer must take precedence');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('runConsultOthersFlow: getGitDiff is wired into the context pack when present', async () => {
  const cwd = mkTmp('podium-ui-');
  const { deps } = makeDeps({
    getWorkspaceCwd: () => cwd,
    promptForQuestion: async () => 'Q',
    getGitDiff: async () => 'diff --git a/x b/x\n+hello\n',
  });
  const outcome = await runConsultOthersFlow(deps);
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;

  const manifest = JSON.parse(fs.readFileSync(outcome.result.files.contextManifestJson, 'utf8'));
  assert.equal(manifest.includes.gitDiff, true);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('runConsultOthersFlow: getGitDiff failure does not break the flow', async () => {
  const cwd = mkTmp('podium-ui-');
  const { deps } = makeDeps({
    getWorkspaceCwd: () => cwd,
    promptForQuestion: async () => 'Q',
    getGitDiff: async () => {
      throw new Error('git not on PATH');
    },
  });
  const outcome = await runConsultOthersFlow(deps);
  assert.equal(outcome.status, 'completed');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('runConsultOthersFlow: caller-supplied participants override the default fake critic', async () => {
  const cwd = mkTmp('podium-ui-');
  const { deps } = makeDeps({
    getWorkspaceCwd: () => cwd,
    promptForQuestion: async () => 'Q',
  });
  const outcome = await runConsultOthersFlow(deps, {
    participants: [
      {
        id: 'override',
        transport: new FakeParticipantTransport({ body: '# overridden output\n' }),
      },
    ],
  });
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;
  assert.equal(outcome.result.run.outputs[0].participantId, 'override');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('runConsultOthersFlow: notify includes failed-count tail when a participant fails', async () => {
  const cwd = mkTmp('podium-ui-');
  const { deps, notifications } = makeDeps({
    getWorkspaceCwd: () => cwd,
    promptForQuestion: async () => 'Q',
  });
  const outcome = await runConsultOthersFlow(deps, {
    participants: [
      {
        id: 'bad',
        transport: new FakeParticipantTransport({ outcome: 'failed', errorMessage: 'oops' }),
      },
    ],
  });
  assert.equal(outcome.status, 'completed');
  assert.ok(
    notifications.some((n) => /1 failed/.test(n)),
    `expected a notification mentioning 1 failed; got: ${notifications.join(' | ')}`,
  );
  fs.rmSync(cwd, { recursive: true, force: true });
});
