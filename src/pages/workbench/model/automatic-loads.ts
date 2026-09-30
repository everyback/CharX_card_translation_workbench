/** A failed automatic load stays attempted until explicit invalidation. */
export class AutomaticLoads {
  private readonly attempted = new Set<string>();

  run(key: string, load: () => Promise<unknown>): Promise<unknown> | undefined {
    if (this.attempted.has(key)) return undefined;
    this.attempted.add(key);
    return load();
  }

  invalidate(key: string): void { this.attempted.delete(key); }
  clear(): void { this.attempted.clear(); }
}
