import type { AsyncDatabase } from '../async-db.js';

export async function addColumnIfMissing(database: AsyncDatabase, table: string, column: string, definition: string): Promise<void> {
  // BEGIN IMMEDIATE serializes schema inspection and mutation across processes.
  await database.transaction(async () => {
    const columns = await database.prepare<{ name: string }>(`PRAGMA table_info(${table})`).all();
    if (!columns.some(entry => entry.name === column)) await database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  });
}
