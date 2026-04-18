import { PsmuxBackend } from './PsmuxBackend';
import type { IMultiplexerBackend } from './IMultiplexerBackend';

export class TmuxBackend extends PsmuxBackend implements IMultiplexerBackend {
  override readonly name: 'psmux' | 'tmux' = 'tmux';

  constructor(binary: string = 'tmux') {
    super(binary);
  }
}
