import test from 'node:test';
import assert from 'node:assert/strict';
import { compressSync, decompressSync } from 'fflate';
import { decode as decodeMsgpack, encode as encodeMsgpack } from 'msgpackr/index-no-eval';
import {
  decodeRisuPreset,
  decryptPresetPayload,
  encodeRisuPreset,
  encryptPresetPayload,
} from '../server/domain/card/risup.js';
import { decodeRpack, encodeRpack } from '../server/domain/card/rpack.js';

/** Runs RisuAI's own `decryptBuffer` implementation against a payload. */
async function webCryptoDecrypt(payload: Uint8Array): Promise<Uint8Array> {
  const keyArray = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('risupreset'));
  const key = await crypto.subtle.importKey('raw', keyArray, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, payload);
  return new Uint8Array(plain);
}

/** Runs RisuAI's own `encryptBuffer` implementation. */
async function webCryptoEncrypt(payload: Uint8Array): Promise<Uint8Array> {
  const keyArray = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('risupreset'));
  const key = await crypto.subtle.importKey('raw', keyArray, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, payload);
  return new Uint8Array(encrypted);
}

const SAMPLE = {
  name: '测试预设',
  temperature: 100,
  top_p: 0.95,
  customPromptTemplateToggle: 'style_a=文风A',
  promptTemplate: [
    { type: 'plain', type2: 'main', text: '你是{{char}}', role: 'system' },
    { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
    { type: 'jailbreak', type2: 'normal', text: '{{#when::{{getglobalvar::toggle_style_a}}}}\n风格A\n{{/when}}', role: 'system' },
  ],
};

test('RISUP round-trips a preset object', () => {
  const container = encodeRisuPreset(SAMPLE);
  const decoded = decodeRisuPreset(container);
  assert.equal(decoded.presetVersion, 2);
  assert.equal(decoded.rpackWrapped, true);
  assert.deepEqual(decoded.preset, SAMPLE);
});

test('RISUP container matches the envelope RisuAI expects', () => {
  const container = encodeRisuPreset(SAMPLE);
  const envelope = decodeMsgpack(decompressSync(decodeRpack(container))) as Record<string, unknown>;
  assert.equal(envelope.type, 'preset');
  assert.equal(envelope.presetVersion, 2);
  assert.ok(envelope.preset instanceof Uint8Array, 'preset payload must be a msgpack bin');
});

test('RISUP applies RPack so the compressed header is obscured', () => {
  const container = encodeRisuPreset(SAMPLE);
  const restored = decodeRpack(container);
  // fflate's compressSync emits a gzip stream (1f 8b); RPack must have hidden that magic.
  assert.equal(restored[0], 0x1f);
  assert.equal(restored[1], 0x8b);
  assert.notDeepEqual([container[0], container[1]], [0x1f, 0x8b]);
});

test('RISUP payload decrypts with RisuAI WebCrypto crypto parameters', async () => {
  const payload = encryptPresetPayload(encodeMsgpack(SAMPLE, { useRecords: false }));
  const plain = await webCryptoDecrypt(payload);
  assert.deepEqual(decodeMsgpack(plain), SAMPLE);
});

test('RISUP decrypts payloads produced by RisuAI WebCrypto', async () => {
  const payload = await webCryptoEncrypt(encodeMsgpack(SAMPLE, { useRecords: false }));
  assert.deepEqual(decodeMsgpack(decryptPresetPayload(payload)), SAMPLE);
});

test('RISUP rejects tampered ciphertext instead of returning garbage', () => {
  const payload = Buffer.from(encryptPresetPayload(encodeMsgpack(SAMPLE, { useRecords: false })));
  payload[0] ^= 0xff;
  assert.throws(() => decryptPresetPayload(payload), /解密失败/u);
});

test('RISUP reads a bare .risupreset container without RPack', () => {
  const bare = Buffer.from(compressSync(makeEnvelope(2)));
  const decoded = decodeRisuPreset(bare);
  assert.equal(decoded.rpackWrapped, false);
  assert.deepEqual(decoded.preset, SAMPLE);
});

test('RISUP rejects unsupported preset versions', () => {
  assert.throws(() => decodeRisuPreset(encodeRpack(compressSync(makeEnvelope(9)))), /暂不支持 RISUP 预设版本 9/u);
});

test('RISUP rejects containers that are not presets', () => {
  const envelope = encodeMsgpack({ presetVersion: 2, type: 'character', preset: new Uint8Array([1]) }, { useRecords: false });
  assert.throws(() => decodeRisuPreset(encodeRpack(compressSync(envelope))), /无法解析/u);
});

test('RISUP output is byte-reproducible', async () => {
  // fflate writes the current time into the gzip header unless told otherwise,
  // so identical conversions would differ by a byte and defeat a re-export check.
  const first = encodeRisuPreset(SAMPLE);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = encodeRisuPreset(SAMPLE);
  assert.deepEqual(first, second);
  assert.deepEqual(decodeRisuPreset(second).preset, SAMPLE);
});

function makeEnvelope(presetVersion: number): Buffer {
  return Buffer.from(encodeMsgpack({
    presetVersion,
    type: 'preset',
    preset: encryptPresetPayload(encodeMsgpack(SAMPLE, { useRecords: false })),
  }, { useRecords: false }));
}
