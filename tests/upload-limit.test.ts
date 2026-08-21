import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isUploadTooLargeError,
  resolveUploadLimitMib,
  uploadLimitBytes,
  uploadTooLargeMessage,
} from '../server/upload-limit.js';

test('large card upload defaults to unlimited and accepts an override', () => {
  assert.equal(resolveUploadLimitMib(undefined), null);
  assert.equal(resolveUploadLimitMib('0'), null);
  assert.equal(resolveUploadLimitMib('400'), 400);
  assert.equal(uploadLimitBytes(null), Number.MAX_SAFE_INTEGER);
  assert.equal(uploadLimitBytes(400), 400 * 1024 * 1024);
});

test('invalid upload limit configuration is rejected', () => {
  assert.throws(() => resolveUploadLimitMib('-1'), /0（不限）或大于 0 的整数/);
  assert.throws(() => resolveUploadLimitMib('12.5'), /大于 0 的整数/);
  assert.throws(() => resolveUploadLimitMib('abc'), /大于 0 的整数/);
});

test('Fastify upload size errors get a localized message', () => {
  assert.equal(isUploadTooLargeError({ code: 'FST_REQ_FILE_TOO_LARGE' }), true);
  assert.equal(isUploadTooLargeError({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' }), true);
  assert.equal(isUploadTooLargeError(new Error('other')), false);
  assert.match(uploadTooLargeMessage(256), /256 MiB/);
});
