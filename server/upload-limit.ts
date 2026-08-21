export { resolveUploadLimitMib } from '../config/validation.js';

export function uploadLimitBytes(limitMib: number | null): number {
  if (limitMib === null) return Number.MAX_SAFE_INTEGER;
  return Math.min(Number.MAX_SAFE_INTEGER, limitMib * 1024 * 1024);
}

export function isUploadTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_ERR_CTP_BODY_TOO_LARGE';
}

export function uploadTooLargeMessage(limitMib: number | null): string {
  if (limitMib === null) return '上传文件超过当前运行环境可处理的范围。';
  return `上传文件超过 ${limitMib} MiB 限制。可在 .env 中调高 WORKBENCH_UPLOAD_LIMIT_MB 后重启工作台。`;
}
