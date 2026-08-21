import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

type DatabaseMethod = 'exec' | 'get' | 'all' | 'run' | 'close';
type WorkerRole = 'writer' | 'reader';

interface WorkerResponse {
  id: number;
  value?: unknown;
  error?: { name?: string; message?: string; stack?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class WorkerConnection {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private fatalError: Error | null = null;
  private terminating = false;

  constructor(workerUrl: URL, filename: string, role: WorkerRole) {
    this.worker = new Worker(workerUrl, { workerData: { filename, role } });
    this.worker.on('message', (response: WorkerResponse) => this.handleResponse(response));
    this.worker.on('error', (error) => this.failPending(error));
    this.worker.on('exit', (code) => {
      if (code !== 0 && !this.terminating) {
        this.failPending(new Error(`SQLite ${role} worker exited with code ${code}.`));
      }
    });
    this.worker.unref();
  }

  request(method: DatabaseMethod, sql?: string, params?: unknown[]): Promise<unknown> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.worker.ref();
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, sql, params });
    });
  }

  async close(): Promise<void> {
    await this.request('close');
    this.terminating = true;
    await this.worker.terminate();
  }

  private handleResponse(response: WorkerResponse): void {
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    if (this.pending.size === 0) this.worker.unref();
    if (response.error) {
      const error = new Error(response.error.message || 'SQLite worker request failed.');
      error.name = response.error.name || 'Error';
      if (response.error.stack) error.stack = response.error.stack;
      request.reject(error);
      return;
    }
    request.resolve(response.value);
  }

  private failPending(error: Error): void {
    this.fatalError = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.worker.unref();
  }
}

class AsyncStatement<T = Record<string, unknown>> {
  constructor(private readonly database: AsyncDatabase, private readonly sql: string) {}

  get(...params: unknown[]): Promise<T | undefined> {
    return this.database.request('get', this.sql, params) as Promise<T | undefined>;
  }

  all(...params: unknown[]): Promise<T[]> {
    return this.database.request('all', this.sql, params) as Promise<T[]>;
  }

  run(...params: unknown[]): Promise<RunResult> {
    return this.database.request('run', this.sql, params) as Promise<RunResult>;
  }
}

export class AsyncDatabase {
  private readonly writer: WorkerConnection;
  private readonly readers: WorkerConnection[];
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private writerGate: Promise<void> = Promise.resolve();
  private nextReaderIndex = 0;

  constructor(filename: string, workerCount = 3) {
    if (!Number.isInteger(workerCount) || workerCount < 1) {
      throw new Error('SQLite worker count must be a positive integer.');
    }
    const compiledWorker = new URL('./db-worker.js', import.meta.url);
    const workerUrl = existsSync(compiledWorker) ? compiledWorker : new URL('./db-worker.ts', import.meta.url);
    this.writer = new WorkerConnection(workerUrl, filename, 'writer');
    this.readers = Array.from(
      { length: workerCount - 1 },
      () => new WorkerConnection(workerUrl, filename, 'reader'),
    );
  }

  get workerCount(): number {
    return 1 + this.readers.length;
  }

  prepare<T = Record<string, unknown>>(sql: string): AsyncStatement<T> {
    return new AsyncStatement<T>(this, sql);
  }

  exec(sql: string): Promise<void> {
    return this.request('exec', sql) as Promise<void>;
  }

  async transaction<T>(run: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) {
      throw new Error('Nested SQLite transactions are not supported.');
    }
    return this.withWriterGate(async () => this.transactionContext.run(true, async () => {
      await this.writer.request('exec', 'BEGIN IMMEDIATE');
      try {
        const value = await run();
        await this.writer.request('exec', 'COMMIT');
        return value;
      } catch (error) {
        await this.writer.request('exec', 'ROLLBACK').catch(() => undefined);
        throw error;
      }
    }));
  }

  async close(): Promise<void> {
    await this.withWriterGate(async () => {
      await Promise.all(this.readers.map((reader) => reader.close()));
      await this.writer.close();
    });
  }

  request(method: DatabaseMethod, sql?: string, params?: unknown[]): Promise<unknown> {
    if (this.transactionContext.getStore()) return this.writer.request(method, sql, params);
    if ((method === 'get' || method === 'all') && this.readers.length > 0) {
      const reader = this.readers[this.nextReaderIndex];
      this.nextReaderIndex = (this.nextReaderIndex + 1) % this.readers.length;
      return reader.request(method, sql, params);
    }
    return this.withWriterGate(() => this.writer.request(method, sql, params));
  }

  private async withWriterGate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writerGate;
    let release!: () => void;
    this.writerGate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
