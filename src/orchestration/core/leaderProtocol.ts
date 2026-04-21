// Phase 3.3 · v2.7.11 — Podium leader system prompt + tool policy.
//
// Injected into the Claude CLI via `--append-system-prompt` when Podium
// spawns a leader pane. Combined with `--disallowedTools Task`, this teaches
// the leader to delegate through external worker panes instead of spawning
// internal subagents.
//
// Why this layering
// -----------------
// - `--disallowedTools Task` is the HARD guarantee: the Task tool is not
//   invokable at all in this session, so there is no way for the leader to
//   fall back to internal subagents by habit.
// - `--append-system-prompt` teaches the REPLACEMENT behavior: when a user
//   asks the leader to delegate, it must emit `@worker-N:` directives. An
//   external projector/parser in PodiumOrchestrator then routes those lines
//   to the matching worker pane's stdin.
//
// Scope
// -----
// This prompt and the tool policy are applied ONLY to the leader pane that
// the `claudeCodeLauncher.podium.orchestrate` command spawns. Worker panes
// and standalone `claude` sessions are untouched — users keep their normal
// Task-enabled workflow everywhere else.

export const PODIUM_LEADER_SYSTEM_PROMPT = `PODIUM TEAM PROTOCOL

You are the leader of a Podium team. Independent worker CLI processes
(worker-1, worker-2, …) are running in separate panes alongside you. You
cannot see their screens; they receive work only through routing directives
you emit in your assistant output.

DELEGATION SYNTAX
When the user asks you to assign work to a worker, respond with one line
per worker, each starting at column zero of a new line:

  @worker-1: <task for worker-1>
  @worker-2: <task for worker-2>

Exact format: literal '@', 'worker-', digit(s), ':', space, task text. An
external orchestrator watches your output and dispatches each directive to
the matching worker pane. Worker responses go to their own panes, not back
to you — the user will paste any results they want you to see.

RULES
1. The Task tool is disabled in this session. Do not attempt to spawn
   internal subagents. Use @worker-N: routing for all delegation.
2. For non-delegation work (analysis, writing, explaining, coding), answer
   normally without @worker routing.
3. Do not try to inspect or poll workers yourself. Wait for the user.
4. If the user's request is ambiguous about who should handle it, ask.

Acknowledge this protocol briefly on your first turn, then wait for the
first instruction.`;

export const PODIUM_LEADER_DISALLOWED_TOOLS = ['Task'] as const;

export interface LeaderExtraArgOpts {
  /** If set, prefix argv with `--resume <uuid>` to continue an existing session. */
  resumeSessionId?: string;
}

/**
 * Compose the `extraArgs` tail that the Podium orchestrate command passes
 * to `spawnAgent` for the leader pane. Separated from `index.ts` so that
 * unit tests can assert on its shape without spinning up the extension.
 *
 * When `resumeSessionId` is set, callers must also pass `autoSessionId: false`
 * to the panel so `--session-id` is not added alongside `--resume` (the two
 * are mutually exclusive in Claude's argv).
 */
export function buildLeaderExtraArgs(opts: LeaderExtraArgOpts = {}): string[] {
  const args: string[] = [];
  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }
  args.push(
    '--disallowedTools',
    ...PODIUM_LEADER_DISALLOWED_TOOLS,
    '--append-system-prompt',
    PODIUM_LEADER_SYSTEM_PROMPT,
  );
  return args;
}
