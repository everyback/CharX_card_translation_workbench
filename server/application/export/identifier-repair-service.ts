import { createHash } from 'node:crypto';
import { parseCharx, readCharxEntries, writeCardCharx } from '../../domain/card/charx.js';
import { applyIdentifierRepair, identifierRepairDiagnostics, planIdentifierRepair } from '../../domain/card/identifier-repair.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function inspect(originalBytes: Uint8Array, translatedBytes: Uint8Array) {
  const original = parseCharx(originalBytes);
  const translated = parseCharx(translatedBytes);
  const plan = planIdentifierRepair(original.card, original.module, translated.card, translated.module);
  const originalHash = hash(originalBytes), translatedHash = hash(translatedBytes);
  return { translated, plan, originalHash, translatedHash, planId: hash(Buffer.from(`${originalHash}:${translatedHash}`)) };
}

export function previewIdentifierRepair(originalBytes: Uint8Array, translatedBytes: Uint8Array) {
  const { translated, plan, originalHash, translatedHash, planId } = inspect(originalBytes, translatedBytes);
  return { ...plan, planId, originalHash, translatedHash,
    diagnostics: identifierRepairDiagnostics(translated.module),
    assets: translated.assetCount,
    method: '同一规则输入及类型唯一匹配、完整 HTML 元素和属性布局对齐；仅使用原件中的属性值，需逐项审核。' };
}

export function exportIdentifierRepair(originalBytes: Uint8Array, translatedBytes: Uint8Array,
  approval: { planId: string; approvedIds: string[] }) {
  const { translated, plan, planId } = inspect(originalBytes, translatedBytes);
  if (approval.planId !== planId) throw new Error('上传文件已变化，请重新生成并审核修复清单。');
  const repaired = applyIdentifierRepair(translated.card, translated.module, plan, approval.approvedIds);
  const output = writeCardCharx(translatedBytes, repaired.card, repaired.module);
  // Re-read the actual archive and verify every unrelated entry byte-for-byte.
  const before = readCharxEntries(translatedBytes), after = readCharxEntries(output);
  if (JSON.stringify(Object.keys(before).sort()) !== JSON.stringify(Object.keys(after).sort())) throw new Error('修复导出的归档文件清单发生变化。');
  for (const name of Object.keys(before)) {
    if (name !== 'card.json' && name !== 'module.risum' && hash(before[name]) !== hash(after[name])) throw new Error('修复导出的资源发生变化。');
  }
  if (before['module.risum']) {
    const suffix = (bytes: Uint8Array) => bytes.subarray(Buffer.from(bytes).readUInt32LE(2) + 6);
    if (hash(suffix(before['module.risum'])) !== hash(suffix(after['module.risum']))) throw new Error('模块内嵌资源发生变化。');
  }
  const roundTrip = parseCharx(output);
  if (JSON.stringify(roundTrip.card) !== JSON.stringify(repaired.card)
    || JSON.stringify(roundTrip.module) !== JSON.stringify(repaired.module)) throw new Error('CHARX 回读内容与已审核修复不一致。');
  return { output, repairedCount: approval.approvedIds.length,
    diagnostics: identifierRepairDiagnostics(roundTrip.module), outputHash: hash(output) };
}
