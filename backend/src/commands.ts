/**
 * Pending-command queue for WiFi-connected devices, which pick commands up by
 * polling GET /api/commands/pending (~every 500ms). Commands expire so a device
 * that comes online later doesn't replay stale operator actions.
 */
import type { Command, QueuedCommand } from './contract.js';

export class CommandQueue {
  private items: { cmd: QueuedCommand; at: number }[] = [];
  // Random base so ids from a restarted backend don't collide with ones a device has already applied.
  private nextId = 1 + Math.floor(Math.random() * 1_000_000_000);

  constructor(private readonly ttlMs = 15_000, private readonly maxItems = 32) {}

  enqueue(cmd: Command): QueuedCommand {
    const queued = { ...cmd, id: this.nextId++ } as QueuedCommand;
    this.items.push({ cmd: queued, at: Date.now() });
    if (this.items.length > this.maxItems) this.items.shift();
    return queued;
  }

  /** Return and clear every unexpired command. */
  drain(): QueuedCommand[] {
    this.prune();
    const out = this.items.map((i) => i.cmd);
    this.items = [];
    return out;
  }

  get size(): number {
    this.prune();
    return this.items.length;
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    this.items = this.items.filter((i) => i.at >= cutoff);
  }
}
