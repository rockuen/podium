import * as http from 'http';
import { EventEmitter } from 'events';
import type { OMCOpenClawPayload } from '../types/events';

export interface HookReceiverOptions {
  port: number;
  host?: string;
  maxPortScan?: number;
  getToken: () => string;
  logger: (msg: string) => void;
}

export class HookReceiver extends EventEmitter {
  private server: http.Server | null = null;
  private boundPort: number | null = null;

  constructor(private readonly opts: HookReceiverOptions) {
    super();
  }

  get url(): string | null {
    return this.boundPort ? `http://${this.opts.host ?? '127.0.0.1'}:${this.boundPort}/wake` : null;
  }

  get port(): number | null {
    return this.boundPort;
  }

  async start(): Promise<number> {
    const base = this.opts.port;
    const max = this.opts.maxPortScan ?? 10;
    let lastErr: unknown;
    for (let p = base; p < base + max; p++) {
      try {
        return await this.tryListen(p);
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(
      `Podium HookReceiver: could not bind in range ${base}..${base + max - 1}: ${String(lastErr)}`,
    );
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.boundPort = null;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    this.opts.logger('[podium.hook] stopped');
    this.emit('stopped');
  }

  private tryListen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      const onInitialError = (err: Error) => reject(err);
      server.once('error', onInitialError);
      const host = this.opts.host ?? '127.0.0.1';
      server.listen(port, host, () => {
        // Swap the reject-on-error listener for a durable logger so future
        // socket-level errors don't propagate as uncaught exceptions and
        // kill the whole extension host. Don't call removeAllListeners —
        // that strips our steady-state handler too.
        server.removeListener('error', onInitialError);
        server.on('error', (err) => {
          this.opts.logger(`[podium.hook] server error: ${err.message}`);
          this.emit('error', err);
        });
        this.server = server;
        this.boundPort = port;
        this.opts.logger(`[podium.hook] listening on http://${host}:${port}/wake`);
        this.emit('started', { url: this.url });
        resolve(port);
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, { ok: true, service: 'podium-hook-receiver' });
        return;
      }
      if (req.method !== 'POST' || !req.url || !req.url.startsWith('/wake')) {
        sendJson(res, 404, { ok: false, error: 'not-found' });
        return;
      }

      const auth = req.headers.authorization || '';
      const expected = `Bearer ${this.opts.getToken()}`;
      if (auth !== expected) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      const raw = await readBody(req);
      let payload: OMCOpenClawPayload;
      try {
        payload = JSON.parse(raw) as OMCOpenClawPayload;
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid-json' });
        return;
      }

      // Acknowledge fast — OMC dispatches are fire-and-forget with 10s timeout.
      sendJson(res, 200, { ok: true });

      const sid = (payload.sessionId ?? '-').slice(0, 8);
      this.opts.logger(`[podium.hook] ${payload.event} session=${sid}`);
      this.emit('hook', payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.logger(`[podium.hook] handler error: ${msg}`);
      // Guard against "write after end" — the 200 ACK path runs BEFORE the
      // emit('hook') call, so a throwing listener reaches this catch AFTER
      // the response is already closed. Only write 500 if we haven't responded.
      if (!res.headersSent && !res.writableEnded) {
        try {
          sendJson(res, 500, { ok: false, error: 'internal' });
        } catch {
          /* ignore */
        }
      }
      this.emit('error', msg);
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(text);
}
