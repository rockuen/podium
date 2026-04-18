import type {
  IMultiplexerBackend,
  TmuxPane,
  TmuxSession,
} from '../backends/IMultiplexerBackend';

export interface DetectedSession {
  session: TmuxSession;
  panes: TmuxPane[];
}

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
    const prefixed = all.filter((s) => s.name.startsWith(this.prefix));
    const filtered = this.nameFilter
      ? prefixed.filter((s) => s.name.toLowerCase().includes(this.nameFilter))
      : prefixed;
    const results: DetectedSession[] = [];
    for (const session of filtered) {
      const panes = await this.backend.listPanes(session.name).catch(() => []);
      results.push({ session, panes });
    }
    return results;
  }

  async killSession(name: string): Promise<void> {
    await this.backend.killSession(name);
  }
}
