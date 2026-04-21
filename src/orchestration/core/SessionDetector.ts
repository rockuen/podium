import type {
  IMultiplexerBackend,
  TmuxPane,
  TmuxSession,
} from '../backends/IMultiplexerBackend';

export interface DetectedSession {
  session: TmuxSession;
  panes: TmuxPane[];
  // v2.6.37: distinguishes the two ways a team can live in psmux:
  //   - 'omc-team'       → standalone session created by `omc team` CLI
  //                        (session name starts with configured prefix)
  //   - 'podium-inline'  → team spawned from WITHIN an existing Claude leader
  //                        session via `/team`, which causes OMC to split the
  //                        leader pane instead of creating a new session. The
  //                        leader's `podium-leader-<sid8>` session gets ≥2
  //                        panes; we surface it here so the Teams view doesn't
  //                        stay empty in the common "resumed then /team" flow.
  kind: 'omc-team' | 'podium-inline';
}

const LAUNCHER_PODIUM_PREFIX = 'podium-leader-';

export class SessionDetector {
  private nameFilter = '';

  constructor(
    private backend: IMultiplexerBackend,
    private prefix: string = 'omc-team-',
  ) {}

  setPrefix(prefix: string): void {
    this.prefix = prefix;
  }

  getPrefix(): string {
    return this.prefix;
  }

  setNameFilter(filter: string): void {
    this.nameFilter = filter.toLowerCase().trim();
  }

  getNameFilter(): string {
    return this.nameFilter;
  }

  async detect(): Promise<DetectedSession[]> {
    const all = await this.backend.listSessions();
    const primary = all.filter((s) => !!this.prefix && s.name.startsWith(this.prefix));
    const podium = all.filter((s) => s.name.startsWith(LAUNCHER_PODIUM_PREFIX));
    const applyNameFilter = (list: TmuxSession[]): TmuxSession[] =>
      this.nameFilter
        ? list.filter((s) => s.name.toLowerCase().includes(this.nameFilter))
        : list;

    const results: DetectedSession[] = [];
    for (const session of applyNameFilter(primary)) {
      const panes = await this.backend.listPanes(session.name).catch(() => []);
      results.push({ session, panes, kind: 'omc-team' });
    }
    for (const session of applyNameFilter(podium)) {
      const panes = await this.backend.listPanes(session.name).catch(() => []);
      // Single-pane podium-leader is just a plain wrapped Claude — already
      // visible in the launcher's Sessions tree, so don't duplicate it here.
      if (panes.length >= 2) {
        results.push({ session, panes, kind: 'podium-inline' });
      }
    }
    return results;
  }

  async killSession(name: string): Promise<void> {
    await this.backend.killSession(name);
  }
}
