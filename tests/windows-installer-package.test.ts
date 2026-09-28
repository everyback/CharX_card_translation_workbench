import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeWindowsPowerShell } from '../src/pages/plugins/package-encoding.js';

test('Windows PowerShell installer is packaged with a UTF-8 BOM for PowerShell 5.1', () => {
  const encoded = encodeWindowsPowerShell("Write-Host '安装 RisuAI'\n");
  assert.deepEqual([...encoded.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(new TextDecoder().decode(encoded.slice(3)), "Write-Host '安装 RisuAI'\n");
});

test('Windows PowerShell installer receives exactly one BOM', () => {
  const encoded = encodeWindowsPowerShell("\uFEFFWrite-Host 'ok'\n");
  assert.deepEqual([...encoded.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.notDeepEqual([...encoded.slice(3, 6)], [0xef, 0xbb, 0xbf]);
  assert.equal(new TextDecoder().decode(encoded.slice(3)), "Write-Host 'ok'\n");
});
