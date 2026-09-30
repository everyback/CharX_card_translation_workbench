/** Keep one execution per job, including while a cancelled execution drains. */
export class JobRunner {
  private readonly active = new Map<string, { controller: AbortController; restart: boolean }>();

  constructor(
    private readonly run: (id: string, signal: AbortSignal) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  schedule(id: string): void {
    const current = this.active.get(id);
    if (current) {
      if (current.controller.signal.aborted) current.restart = true;
      return;
    }
    const entry = { controller: new AbortController(), restart: false };
    this.active.set(id, entry);
    setImmediate(() => {
      void Promise.resolve().then(() => this.run(id, entry.controller.signal))
        .catch(this.onError)
        .finally(() => {
          this.active.delete(id);
          if (entry.restart) this.schedule(id);
        });
    });
  }

  abort(id: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    entry.restart = false;
    entry.controller.abort();
  }
}
