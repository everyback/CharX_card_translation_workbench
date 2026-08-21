import textChunk from 'png-chunk-text';
import extractChunks, { type PngChunk } from 'png-chunks-extract';
import encodeChunks from 'png-chunks-encode';

const CARD_KEYWORDS = new Set(['chara', 'ccv3']);

export interface ParsedCardPng {
  card: Record<string, unknown>;
  metadataKeys: string[];
}

export function parseCardPng(buffer: Uint8Array): ParsedCardPng {
  let chunks: PngChunk[];
  try {
    chunks = extractChunks(buffer);
  } catch {
    throw new Error('文件不是有效的 PNG 图片。');
  }

  const candidates: Array<{ keyword: string; text: string }> = [];
  for (const chunk of chunks) {
    if (chunk.name !== 'tEXt') continue;
    try {
      const decoded = textChunk.decode(chunk.data);
      if (CARD_KEYWORDS.has(decoded.keyword)) candidates.push(decoded);
    } catch {
      // Ignore unrelated or malformed text chunks.
    }
  }
  if (!candidates.length) throw new Error('PNG 中没有找到 chara 或 ccv3 角色卡元数据。');

  const ordered = [...candidates].sort((left, right) => priority(right.keyword) - priority(left.keyword));
  let lastError: unknown;
  for (const candidate of ordered) {
    try {
      return {
        card: decodeCard(candidate.text),
        metadataKeys: unique(candidates.map((entry) => entry.keyword)),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`PNG 角色卡元数据无法解析：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export function writeCardPng(
  source: Uint8Array,
  card: Record<string, unknown>,
  metadataKeys: string[] = ['chara'],
): Buffer {
  const chunks = extractChunks(source).filter((chunk) => !isCardTextChunk(chunk));
  const iendIndex = chunks.findIndex((chunk) => chunk.name === 'IEND');
  if (iendIndex < 0) throw new Error('PNG 缺少 IEND 结束块。');

  const keys = unique(metadataKeys.filter((key) => CARD_KEYWORDS.has(key)));
  const targets = keys.length ? keys : ['chara'];
  const encodedCard = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
  chunks.splice(iendIndex, 0, ...targets.map((keyword) => textChunk.encode(keyword, encodedCard)));
  return Buffer.from(encodeChunks(chunks));
}

function decodeCard(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const decoded = trimmed.startsWith('{')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8');
  const card = JSON.parse(decoded) as unknown;
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    throw new Error('角色卡元数据不是 JSON 对象。');
  }
  return card as Record<string, unknown>;
}

function isCardTextChunk(chunk: PngChunk): boolean {
  if (chunk.name !== 'tEXt') return false;
  try {
    return CARD_KEYWORDS.has(textChunk.decode(chunk.data).keyword);
  } catch {
    return false;
  }
}

function priority(keyword: string): number {
  return keyword === 'ccv3' ? 2 : 1;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
