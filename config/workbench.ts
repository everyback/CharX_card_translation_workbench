import path from 'node:path';
import process from 'node:process';
import { resolveDatabaseWorkerCount, resolveUploadLimitMib } from './validation.js';

export { resolveDatabaseWorkerCount } from './validation.js';

export const WORKBENCH_DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  uploadLimitMb: 0,
  databaseWorkers: 3,
  dataDirectory: 'data',
  storageDirectory: 'storage',
  databaseFile: 'workbench.sqlite',
  unpackSessionsDirectory: 'unpack-sessions',
  tavernCardSessionsDirectory: 'tavern-card-sessions',
  ocrCacheDirectory: 'ocr-cache',
  webDirectory: 'dist',
  translation: {
    apiBaseUrl: 'https://api.openai.com/v1',
    sourceLanguage: 'auto',
    fallbackLanguage: 'en',
    targetLanguage: 'zh-CN',
    languageBehaviorMode: 'target',
    concurrency: 400,
    batchItems: 40,
    batchChars: 600000,
  },
} as const;

function environment(name: string): string | undefined {
  const value = process.env[name];
  return value == null || value.trim() === '' ? undefined : value.trim();
}

function numberValue(name: string, fallback: number): number {
  const value = environment(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} 必须是非负整数。`);
  }
  return parsed;
}

function positiveInteger(name: string, fallback: number): number {
  const parsed = numberValue(name, fallback);
  if (parsed < 1) throw new Error(`${name} 必须是大于 0 的整数。`);
  return parsed;
}

function resolveConfiguredPath(value: string | undefined, fallback: string): string {
  const configured = value || fallback;
  return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(process.cwd(), configured);
}

function resolveConfiguredDirectory(name: string, fallback: string): string {
  return resolveConfiguredPath(environment(name), fallback);
}

try {
  process.loadEnvFile(path.resolve(process.cwd(), '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const dataRoot = resolveConfiguredDirectory('WORKBENCH_DATA_DIR', WORKBENCH_DEFAULTS.dataDirectory);
const databasePath = resolveConfiguredPath(
  environment('WORKBENCH_DB_PATH'),
  path.join(dataRoot, WORKBENCH_DEFAULTS.databaseFile),
);
const nodeModulesRoot = resolveConfiguredDirectory('WORKBENCH_NODE_MODULES_DIR', 'node_modules');

export const workbenchConfig = Object.freeze({
  host: environment('WORKBENCH_HOST') || WORKBENCH_DEFAULTS.host,
  port: positiveInteger('WORKBENCH_PORT', WORKBENCH_DEFAULTS.port),
  uploadLimitMib: resolveUploadLimitMib(environment('WORKBENCH_UPLOAD_LIMIT_MB') || String(WORKBENCH_DEFAULTS.uploadLimitMb)),
  databaseWorkers: resolveDatabaseWorkerCount(environment('WORKBENCH_DB_WORKERS')),
  paths: Object.freeze({
    dataRoot,
    storage: resolveConfiguredDirectory(
      'WORKBENCH_STORAGE_DIR',
      path.join(dataRoot, WORKBENCH_DEFAULTS.storageDirectory),
    ),
    database: databasePath,
    unpackSessions: resolveConfiguredDirectory(
      'WORKBENCH_UNPACK_SESSIONS_DIR',
      path.join(dataRoot, WORKBENCH_DEFAULTS.unpackSessionsDirectory),
    ),
    tavernCardSessions: resolveConfiguredDirectory(
      'WORKBENCH_TAVERN_CARD_SESSIONS_DIR',
      path.join(dataRoot, WORKBENCH_DEFAULTS.tavernCardSessionsDirectory),
    ),
    ocrCache: resolveConfiguredDirectory(
      'WORKBENCH_OCR_CACHE_DIR',
      path.join(dataRoot, WORKBENCH_DEFAULTS.ocrCacheDirectory),
    ),
    webRoot: resolveConfiguredDirectory('WORKBENCH_WEB_DIR', WORKBENCH_DEFAULTS.webDirectory),
    nodeModulesRoot,
  }),
});
