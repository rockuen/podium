import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

const SECRET_KEY = 'podium.hookReceiverToken';

export class TokenStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getOrCreate(): Promise<string> {
    const existing = await this.secrets.get(SECRET_KEY);
    if (existing && existing.length > 0) return existing;
    return this.rotate();
  }

  async rotate(): Promise<string> {
    const fresh = `pod_${randomUUID().replace(/-/g, '')}`;
    await this.secrets.store(SECRET_KEY, fresh);
    return fresh;
  }

  async peek(): Promise<string | undefined> {
    return this.secrets.get(SECRET_KEY);
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }
}
