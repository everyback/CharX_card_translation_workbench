export function cardSpecificationLabel(spec: string): string {
  switch (spec) {
    case 'chara_card_v3': return 'Character Card V3 (CCv3)';
    case 'chara_card_v2': return 'Character Card V2 (CCv2)';
    case 'legacy_tavern_card': return 'Tavern Card V1';
    case 'chara_card_v2_or_v3': return 'Character Card V2/V3';
    case 'risu_module': return 'RisuAI Module';
    case 'unknown': return '未识别的角色卡规范';
    default: return spec || '未声明角色卡规范';
  }
}

export function cardSpecificationDetail(spec: string, version: string): string {
  if (spec === 'legacy_tavern_card') return '旧版 Tavern Card，无 spec 字段';
  if (spec === 'chara_card_v2_or_v3') return '存在 data 结构，但未声明 spec';
  if (spec === 'risu_module') return version ? `模块版本 ${version}` : 'RisuAI 独立模块，不是角色卡规范';
  return version ? `规范版本 ${version}` : '未声明规范版本';
}

export function containerFormatLabel(sourceFormat: string): string {
  switch (sourceFormat.toLowerCase()) {
    case 'png': return 'PNG 图像容器';
    case 'json': return 'JSON 文档';
    case 'charx': return 'CHARX 资源容器';
    case 'risum': return 'RISUM 模块容器';
    default: return sourceFormat ? `${sourceFormat.toUpperCase()} 文件` : '未知文件容器';
  }
}

export function platformExtensionLabels(
  extensionKeys: readonly string[],
  modulePresent: boolean,
): string[] {
  const keys = new Set(extensionKeys.map((key) => key.toLowerCase()));
  const labels: string[] = [];
  if (keys.has('risuai') || modulePresent) labels.push('RisuAI');
  if (keys.has('tavern_helper')) labels.push('Tavern Helper');
  if (keys.has('regex_scripts')) labels.push('SillyTavern Regex');
  if (keys.has('depth_prompt')) labels.push('Depth Prompt');
  return labels;
}
