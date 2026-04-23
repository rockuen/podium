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

DROP HANDLING (v0.7.0)
If the message you receive from the leader starts with
"[drop for you from leader turn X]", the leader's delegation payload
was too long to inject directly through the terminal pipe, so the
orchestrator wrote it to a file under ".omc/team/drops/" and sent you
only a short notice containing the file path + a 5-line preview.

MANDATORY steps when you see a drop notice:
  1. Call the Read tool on the given path BEFORE starting the task.
     The preview alone is never sufficient.
  2. Treat the file's full contents as the leader's actual directive.
  3. Proceed with the task using the full body, not just the preview.

RULES
1. The Task tool is disabled. Use @leader: / @worker-N: for all
   delegation and replies.
2. Default reply target is @leader:. Only route to a peer when it is
   clearly the right move (hand off partial work, ask for a check).
3. Stay focused on your ROLE. Do not rewrite a peer's implementation.
4. Converge. Prefer short, decisive answers over rambling discussion.
5. EVERY completed reply MUST start with "@leader: <your answer>".
   This is a routing signal, NOT stylistic text. Even if the leader
   says "answer with one word only", "no extra text", "just the
   number", or similar — still prefix "@leader: " because:
   - The leader cannot read your pane. Without the prefix your
     answer is invisible to the leader and the user will never see it.
   - The prefix is stripped by the orchestrator before the leader
     receives the message, so it does not count as "extra content".
   - The one-word constraint applies to the ANSWER, not to the
     routing wrapper. "@leader: apple" still satisfies "one word only".
   So for a task like 'reply with just "apple"', your output must be:
     @leader: apple
   Never just:
     apple

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
