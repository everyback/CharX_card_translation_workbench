import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Import before scheduler/db in tests, so neither .env nor the user's database is loaded.
const directory = mkdtempSync(path.join(os.tmpdir(), 'ctw-unit-runtime-'));
process.chdir(directory);
for (const key of Object.keys(process.env)) {
  if (/^(WORKBENCH_|TRANSLATION_)/.test(key)) delete process.env[key];
}
process.env.WORKBENCH_DATA_DIR = directory;
process.env.WORKBENCH_DB_PATH = path.join(directory, 'test.sqlite');
