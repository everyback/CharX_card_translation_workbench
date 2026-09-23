import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { compressSync, decompressSync } from 'fflate';
import { decode as decodeMsgpack, encode as encodeMsgpack } from 'msgpackr/index-no-eval';
import { decodeRpack, encodeRpack } from './rpack.js';

/**
 * RisuAI `.risup` / `.risupreset` preset container.
 *
 * Layout, mirroring `exportPreset()` in RisuAI `src/ts/storage/database.svelte.ts`:
 *
 *   .risup       = encodeRpack( compress( msgpack({ presetVersion, type, preset }) ) )
 *   .risupreset  =            compress( msgpack({ presetVersion, type, preset }) )
 *
 * where `preset` is AES-256-GCM( msgpack(presetObject) ) with
 *   key = SHA-256("risupreset") and a fixed all-zero 96-bit nonce.
 *
 * RisuAI uses WebCrypto, which appends the GCM tag to the ciphertext; Node keeps
 * it separate, so the tag is concatenated explicitly here.
 */

/** RisuAI derives the preset key from this literal. */
const RISUP_KEY_SOURCE = 'risupreset';
/** RisuAI encrypts preset payloads with a fixed all-zero 96-bit nonce. */
const RISUP_NONCE = Buffer.alloc(12);
/** WebCrypto AES-GCM appends a 128-bit authentication tag. */
const GCM_TAG_BYTES = 16;
/** Envelope versions RisuAI's importer accepts for `type: 'preset'`. */
const SUPPORTED_PRESET_VERSIONS = new Set([0, 2]);
const PRESET_VERSION = 2;

function presetKey(): Buffer {
  return createHash('sha256').update(RISUP_KEY_SOURCE, 'utf8').digest();
}

export function encryptPresetPayload(payload: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-256-gcm', presetKey(), RISUP_NONCE);
  const body = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

export function decryptPresetPayload(payload: Uint8Array): Buffer {
  const source = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (source.length < GCM_TAG_BYTES) throw new Error('RISUP 预设数据过短，无法包含认证标签。');
  const decipher = createDecipheriv('aes-256-gcm', presetKey(), RISUP_NONCE);
  decipher.setAuthTag(source.subarray(source.length - GCM_TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(source.subarray(0, source.length - GCM_TAG_BYTES)),
      decipher.final(),
    ]);
  } catch (error) {
    throw new Error(`RISUP 预设解密失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * RisuAI encodes with msgpackr, which by default may emit its record (0x72)
 * extension. Records are self-describing so RisuAI would read them back, but
 * emitting plain maps keeps the container readable by any msgpack decoder.
 */
function encodeStandardMsgpack(value: unknown): Buffer {
  return Buffer.from(encodeMsgpack(value, { useRecords: false }));
}

/** msgpackr's decoder handles both plain maps and its own record extension. */
function decodeStandardMsgpack(source: Uint8Array): unknown {
  return decodeMsgpack(source);
}

/** Build a `.risup` container (RPack wrapped) from a RisuAI preset object. */
export function encodeRisuPreset(preset: Record<string, unknown>): Buffer {
  const envelope = encodeStandardMsgpack({
    presetVersion: PRESET_VERSION,
    type: 'preset',
    preset: encryptPresetPayload(encodeStandardMsgpack(preset)),
  });
  // fflate stamps the current time into the gzip header by default, which would
  // make two conversions of the same preset differ by a byte. Pin it so the
  // output is reproducible and a re-export can be compared byte for byte.
  return encodeRpack(compressSync(envelope, { mtime: 0 }));
}

export interface DecodedRisuPreset {
  preset: Record<string, unknown>;
  presetVersion: number;
  /** True when the container was RPack wrapped (`.risup`) rather than bare (`.risupreset`). */
  rpackWrapped: boolean;
}

/**
 * Read either a `.risup` or a `.risupreset` container.
 *
 * RPack is a byte substitution, so it destroys the zlib header; trying the bare
 * buffer first and the RPack-decoded buffer second disambiguates the two forms.
 */
export function decodeRisuPreset(source: Uint8Array): DecodedRisuPreset {
  if (!source.length) throw new Error('RISUP 文件为空。');
  const attempts: Array<{ data: Uint8Array; rpackWrapped: boolean }> = [
    { data: source, rpackWrapped: false },
    { data: decodeRpack(source), rpackWrapped: true },
  ];

  let envelope: unknown = null;
  let matched: { data: Uint8Array; rpackWrapped: boolean } | null = null;
  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const decoded = decodeStandardMsgpack(decompressSync(attempt.data));
      if (isRecord(decoded) && decoded.type === 'preset') {
        envelope = decoded;
        matched = attempt;
        break;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (!envelope || !matched) {
    throw new Error(`RISUP 容器无法解析：${lastError instanceof Error ? lastError.message : '未找到预设外壳'}`);
  }

  const record = envelope as Record<string, unknown>;
  const presetVersion = Number(record.presetVersion ?? 0);
  if (!SUPPORTED_PRESET_VERSIONS.has(presetVersion)) {
    throw new Error(`暂不支持 RISUP 预设版本 ${presetVersion}。`);
  }

  const encrypted = record.preset ?? record.pres;
  if (!(encrypted instanceof Uint8Array)) throw new Error('RISUP 外壳缺少加密的预设数据。');

  const preset = decodeStandardMsgpack(decryptPresetPayload(encrypted));
  if (!isRecord(preset)) throw new Error('RISUP 预设内容不是对象。');
  return { preset, presetVersion, rpackWrapped: matched.rpackWrapped };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
