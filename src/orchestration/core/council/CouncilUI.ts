// v0.10.x — Council UI flow (VS Code-agnostic core).
//
// `runConsultOthersFlow` is the testable core of the
// `claudeCodeLauncher.podium.consultOthers` command. All VS Code APIs are
// injected via `ConsultOthersDeps` so this module stays unit-testable
// (no `vscode` import). The thin command handler in
// `src/orchestration/index.ts` constructs the deps from real VS Code
// objects and forwards.
//
// Defaults to a fake transport (no external CLI required) so the first
// manual smoke test does not depend on Codex/Gemini being installed.
// Callers may pass any `ParticipantTransport` (CodexParticipantTransport,
// GeminiParticipantTransport, FakeParticipantTransport) via
// `participants` to swap in a real transport later.

import * as path from 'node:path';
import { runCouncil, type CouncilParticipantSpec, type CouncilRunResult } from './CouncilRunner';
import { FakeParticipantTransport, type ParticipantTransport } from './ParticipantTransport';
import type { EventLogger } from '../EventLogger';

export interface ActiveFileRef {
  /** Absolute path. */
  absPath: string;
  /** Optional in-memory contents (e.g. unsaved buffer). */
  content?: string;
}

export interface ConsultOthersDeps {
  /** Resolves to the user's question, or undefined if they cancelled. */
  promptForQuestion: () => Promise<string | undefined>;
  /** Workspace cwd. Undefined if no folder open. */
  getWorkspaceCwd: () => string | undefined;
  /** Active editor's file (if any). */
  getActiveFile: () => ActiveFileRef | undefined;
  /** Returns `git diff` text for the cwd, or undefined on failure. */
  getGitDiff: (cwd: string) => Promise<string | undefined>;
  /** Show a transient message to the user. */
  notify: (message: string) => void;
  /** Open a file in the editor (used to surface return_brief.md). */
  showFile: (absPath: string) => Promise<void>;
}

export interface RunConsultOthersOptions {
  cwdOverride?: string;
  participants?: CouncilParticipantSpec[];
  synthesizer?: { transport: ParticipantTransport; id?: string; provider?: string };
  eventLogger?: EventLogger;
  /** Test seam — defaults to `Date`. */
  now?: () => Date;
  /** Override the inferred primary session id. */
  primarySessionId?: string;
}

export type ConsultOthersOutcome =
  | { status: 'completed'; result: CouncilRunResult }
  | { status: 'cancelled'; reason: 'no-workspace' | 'no-question' };

export async function runConsultOthersFlow(
  deps: ConsultOthersDeps,
  opts: RunConsultOthersOptions = {},
): Promise<ConsultOthersOutcome> {
  const cwd = opts.cwdOverride ?? deps.getWorkspaceCwd();
  if (!cwd) {
    deps.notify('Podium: open a workspace folder before opening a council.');
    return { status: 'cancelled', reason: 'no-workspace' };
  }

  const question = await deps.promptForQuestion();
  if (!question || question.trim().length === 0) {
    return { status: 'cancelled', reason: 'no-question' };
  }

  const activeFile = deps.getActiveFile();
  const relevantFiles = activeFile
    ? [
        {
          path: relativizePosix(cwd, activeFile.absPath),
          content: activeFile.content,
          reason: 'active editor',
        },
      ]
    : [];

  let gitDiff: string | undefined;
  try {
    gitDiff = await deps.getGitDiff(cwd);
  } catch {
    gitDiff = undefined; // never break the flow on a git failure
  }

  const now = opts.now ?? (() => new Date());
  const primarySessionId = opts.primarySessionId ?? `ui_${now().toISOString()}`;

  const result = await runCouncil({
    cwd,
    contextPack: {
      primarySessionId,
      userQuestion: question.trim(),
      currentGoal: 'Consult other models from VS Code',
      relevantFiles,
      loadFileContents: activeFile ? activeFile.content === undefined : false,
      gitDiff,
      constraints: [],
    },
    participants:
      opts.participants ??
      [
        {
          id: 'fake_critic',
          provider: 'fake',
          role: 'critic',
          transport: new FakeParticipantTransport(),
        },
      ],
    synthesizer: opts.synthesizer,
    eventLogger: opts.eventLogger,
    now,
  });

  await deps.showFile(result.files.returnBriefMd);
  const failed = result.run.outputs.filter((o) => o.status === 'failed').length;
  const tail = failed > 0 ? ` (${failed} failed)` : '';
  deps.notify(`Podium council ${result.run.id} completed${tail}; brief opened.`);
  return { status: 'completed', result };
}

function relativizePosix(cwd: string, absPath: string): string {
  const rel = path.relative(cwd, absPath);
  return rel.split(path.sep).join('/');
}
