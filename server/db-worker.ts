import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

interface DatabaseRequest {
  id: number;
  method: 'exec' | 'get' | 'all' | 'run' | 'close';
  sql?: string;
  params?: unknown[];
}

interface DatabaseWorkerData {
  filename: string;
  role: 'writer' | 'reader';
}

const port = parentPort;
if (!port) throw new Error('SQLite worker requires a parent port.');

const options = workerData as DatabaseWorkerData;
let database: DatabaseSync | null = null;

function getDatabase(): DatabaseSync {
  if (database) return database;
  database = new DatabaseSync(String(options.filename));
  database.exec('PRAGMA busy_timeout = 5000;');
  if (options.role === 'reader') {
    database.exec(`
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA query_only = ON;
    `);
  }
  return database;
}

port.on('message', (request: DatabaseRequest) => {
  try {
    let value: unknown;
    if (request.method === 'close') {
      database?.close();
      database = null;
      value = null;
    } else if (request.method === 'exec') {
      getDatabase().exec(request.sql ?? '');
      value = null;
    } else {
      const statement = getDatabase().prepare(request.sql ?? '');
      const params = request.params ?? [];
      value = statement[request.method](...params as never[]);
    }
    port.postMessage({ id: request.id, value });
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    port.postMessage({
      id: request.id,
      error: { name: cause.name, message: cause.message, stack: cause.stack },
    });
  }
});
