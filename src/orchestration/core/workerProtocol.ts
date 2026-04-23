// Phase 5 · v0.3.0 — Podium worker system prompt + role presets.
//
// Injected into Claude worker CLI via `--append-system-prompt` when
// PodiumOrchestrator spawns a worker pane. Teaches the worker the
// `@leader:` / `@worker-N:` routing protocol so it can participate in
// bidirectional discussions orchestrated by the leader.
//
// Pairs with `leaderProtocol.ts` (leader-side prompt) and
// `messageRouter.ts`'s token regex, which accepts both `@leader:` and
// `@worker-N:` targets.
//
// Why per-worker prompts vs a global one
// --------------------------------------
// Each worker gets its own role ("implementer", "critic", …) and a roster
// of peers. Embedding that in the system prompt lets the model route to
// the right peer by name without external lookup, and keeps role
// differentiation central to the team's output quality.

export type WorkerRole =
  | 'implementer'
  | 'critic'
  | 'tester'
  | 'researcher'
  | 'generalist';

export const WORKER_ROLES: readonly WorkerRole[] = [
  'implementer',
  'critic',
  'tester',
  'researcher',
  'generalist',
];

export const WORKER_ROLE_DESCRIPTIONS: Record<WorkerRole, string> = {
  implementer:
    'You write concrete code, patches, and runnable solutions. Favor working output over exhaustive analysis.',
  critic:
    "You find weaknesses: logic bugs, missing edge cases, unclear abstractions, brittle assumptions. Be sharp but constructive — name the flaw, suggest the fix.",
  tester:
    "You produce failing cases, test scaffolds, and reproduction steps that stress the implementer's output.",
  researcher:
    'You surface relevant docs, prior art, and external references that inform the decision.',
  generalist:
    "You pick up whatever the leader delegates. Match the task's natural shape.",
};

export interface WorkerSystemPromptOpts {
  /** Stable routing id, e.g. `worker-1`. */
  workerId: string;
  role: WorkerRole;
  /** Other workers in the team (self excluded). */
  peers: readonly { id: string; role: WorkerRole }[];
}

export function buildWorkerSystemPrompt(opts: WorkerSystemPromptOpts): string {
  const peerList =
    opts.peers.length > 0
      ? opts.peers.map((p) => `  - ${p.id} (${p.role})`).join('\n')
      : '  (no other workers)';
  const roleDesc = WORKER_ROLE_DESCRIPTIONS[opts.role];

  return `PODIUM TEAM PROTOCOL — WORKER

You are ${opts.workerId}, a ${opts.role} worker in a Podium team.

ROLE
${roleDesc}

TEAM
Leader: the agent that delegated this task to you.
Peers (you can hand work to these directly):
${peerList}

ROUTING SYNTAX
Your output is watched by an external orchestrator. To speak to the
leader or a peer, emit a line starting at column zero:

  @leader: <message for the leader>
  @worker-N: <message for the peer named worker-N>

Format: literal '@', target, ':', space, message. The orchestrator
delivers each directive to the target's stdin.

RULES
1. The Task tool is disabled. Use @leader: / @worker-N: for all
   delegation and replies.
2. Default reply target is @leader:. Only route to a peer when it is
   clearly the right move (hand off partial work, ask for a check).
3. Stay focused on your ROLE. Do not rewrite a peer's implementation.
4. Converge. Prefer short, decisive answers over rambling discussion.
5. When your part is complete, emit "@leader: <final summary>" and stop.

Acknowledge this protocol briefly, then wait for the leader's first message.`;
}

export const PODIUM_WORKER_DISALLOWED_TOOLS = ['Task'] as const;

export interface WorkerExtraArgOpts extends WorkerSystemPromptOpts {
  /** If set, prefix argv with `--resume <uuid>` to continue an existing session. */
  resumeSessionId?: string;
}

/**
 * Compose the `extraArgs` tail PodiumOrchestrator passes to `spawnAgent`
 * for a worker pane. Mirrors `buildLeaderExtraArgs` on the leader side.
 *
 * When `resumeSessionId` is set, callers must also pass `autoSessionId: false`
 * to the panel so `--session-id` is not added alongside `--resume` (mutually
 * exclusive in Claude's argv).
 */
export function buildWorkerExtraArgs(opts: WorkerExtraArgOpts): string[] {
  const args: string[] = [];
  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }
  args.push(
    '--disallowedTools',
    ...PODIUM_WORKER_DISALLOWED_TOOLS,
    '--append-system-prompt',
    buildWorkerSystemPrompt({
      workerId: opts.workerId,
      role: opts.role,
      peers: opts.peers,
    }),
  );
  return args;
}
