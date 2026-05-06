import type { OpenVikingClient } from './client.js';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

// Remove injected memory blocks and tool metadata so we don't re-capture what
// OpenViking already injected — that would create circular feedback loops.
export function sanitizeTurn(turn: ConversationTurn): string {
  let text = turn.content;
  text = text.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, '');
  text = text.replace(/\[Tool: [^\]]*\]/g, '');
  return text.trim();
}

export class SessionManager {
  // Maps local session ID → OpenViking session ID
  private sessions = new Map<string, string>();
  private commitsSinceLastFlush = new Map<string, number>();
  private readonly turnsPerCommit: number;

  constructor(
    private client: OpenVikingClient,
    opts: { turnsPerCommit?: number } = {},
  ) {
    this.turnsPerCommit = opts.turnsPerCommit ?? 20;
  }

  async getOrCreate(localSessionId: string): Promise<string> {
    const existing = this.sessions.get(localSessionId);
    if (existing) return existing;
    const session = await this.client.createSession(localSessionId);
    this.sessions.set(localSessionId, session.id);
    this.commitsSinceLastFlush.set(localSessionId, 0);
    return session.id;
  }

  async appendTurn(localSessionId: string, turn: ConversationTurn): Promise<void> {
    const ovId = await this.getOrCreate(localSessionId);
    const content = sanitizeTurn(turn);
    if (!content) return;
    await this.client.appendToSession(ovId, `[${turn.role}] ${content}`);

    const count = (this.commitsSinceLastFlush.get(localSessionId) ?? 0) + 1;
    this.commitsSinceLastFlush.set(localSessionId, count);
  }

  shouldCommit(localSessionId: string): boolean {
    return (this.commitsSinceLastFlush.get(localSessionId) ?? 0) >= this.turnsPerCommit;
  }

  async commitSession(localSessionId: string, wait = false): Promise<void> {
    const ovId = this.sessions.get(localSessionId);
    if (!ovId) return;
    await this.client.commitSession(ovId, wait);
    this.commitsSinceLastFlush.set(localSessionId, 0);
  }
}

export class BackgroundCommitQueue {
  private queue: Array<{ localSessionId: string; priority: number }> = [];
  private running = false;

  constructor(
    private manager: SessionManager,
    private timeoutMs: number,
  ) {}

  enqueue(localSessionId: string, priority = 0): void {
    this.queue.push({ localSessionId, priority });
    this.queue.sort((a, b) => b.priority - a.priority);
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        await Promise.race([
          this.manager.commitSession(item.localSessionId, true),
          new Promise<void>((_, rej) => setTimeout(() => rej(new Error('commit timeout')), this.timeoutMs)),
        ]);
      } catch {
        // Commit failed — not fatal, session data stays buffered
      }
    }
    this.running = false;
  }
}
