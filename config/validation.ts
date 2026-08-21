export function resolveDatabaseWorkerCount(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 3;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('WORKBENCH_DB_WORKERS 必须是大于 0 的整数。');
  }
  return count;
}

export function resolveUploadLimitMib(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '' || value.trim() === '0') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('WORKBENCH_UPLOAD_LIMIT_MB 必须是 0（不限）或大于 0 的整数。');
  }
  return parsed;
}
