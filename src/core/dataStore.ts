import type * as vscode from "vscode";

/**
 * A simple queued-write key-value store backed by VS Code's ExtensionContext.globalState.
 * Serializes writes to avoid concurrent update conflicts.
 */
export class DataStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly state: vscode.Memento) {}

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.state.get<T>(key, defaultValue as T);
  }

  /**
   * Queue a write operation. Writes are serialized so concurrent calls
   * do not race against each other.
   */
  async set(key: string, value: unknown): Promise<void> {
    const run = () => this.state.update(key, value);
    const prior = this.writeQueue;
    const queued = prior.then(run, run);
    this.writeQueue = queued.catch(() => {});
    return queued;
  }

  /**
   * Read-modify-write a key atomically (with respect to other queued writes).
   */
  async merge<T>(key: string, updater: (current: T | undefined) => T): Promise<void> {
    return this.set(key, updater(this.get<T>(key)));
  }

  keys(): readonly string[] {
    return this.state.keys();
  }
}
