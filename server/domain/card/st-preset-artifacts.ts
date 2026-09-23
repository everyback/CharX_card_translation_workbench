import { strToU8, zipSync } from 'fflate';
import { convertStPreset, presetControlNamespace, type StPresetConversionOptions } from './st-preset-convert.js';
import { encodeRisuPreset } from './risup.js';

/** The CLI and HTTP exporter share one conversion and archival contract. */
export function buildStPresetArtifacts(
  original: Record<string, unknown>,
  draft: Record<string, unknown>,
  options: StPresetConversionOptions = {},
) {
  const converted = convertStPreset(draft, { ...options, controlNamespace: presetControlNamespace(original) });
  const runnable = !converted.report.issues.some((issue) => issue.severity === 'error');
  const risup = runnable ? encodeRisuPreset(converted.preset) : null;
  return { ...converted, runnable, risup };
}

export function encodeStPresetBundle(
  original: Record<string, unknown>,
  draft: Record<string, unknown>,
  artifacts: ReturnType<typeof buildStPresetArtifacts>,
) {
  const json = (value: unknown) => strToU8(JSON.stringify(value, null, 2));
  const files: Record<string, Uint8Array> = {
    'original.st.json': json(original),
    'draft.st.json': json(draft),
    'conversion.report.json': json(artifacts.report),
    'converted.preview.json': json(artifacts.preset),
    'README.md': strToU8(artifacts.runnable
      ? '# 预设转换存档\n\nconverted.risup 可导入 RisuAI；请同时阅读转换报告中的位置、格式和未映射字段差异。已通过格式转换，不代表经过真实请求语义验证。\n'
      : '# 预设迁移存档\n\n存在未完成迁移的运行行为，本包不含可运行 .risup。converted.preview.json 仅用于检查，不能视为可运行预设。请依据 conversion.report.json 处理变量、注入或正则问题。原始与编辑后的 ST 定义均完整保留。\n'),
  };
  if (artifacts.risup) files['converted.risup'] = artifacts.risup;
  return zipSync(files);
}
