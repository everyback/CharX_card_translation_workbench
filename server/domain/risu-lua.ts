import { parse } from 'luaparse';
import {
  applyApprovedSegments,
  isLuaModuleCodePath,
  type ApplicableSegment,
} from './card.js';

export interface LuaSyntaxIssue {
  pathLabel: string;
  message: string;
}

export interface RisuModuleApplyResult {
  draft: Record<string, unknown>;
  ignoredLuaSegments: number;
  syntaxIssues: LuaSyntaxIssue[];
}

export function applyRisuModuleSegments(
  original: Record<string, unknown>,
  segments: ApplicableSegment[],
): RisuModuleApplyResult {
  let ignoredLuaSegments = 0;
  const safeSegments = segments.filter((segment) => {
    const path = parsePath(segment.pathJson);
    if (!isLuaModuleCodePath(path)
      || segment.kind === 'runtime-message'
      || segment.kind === 'lua-string'
      || segment.kind === 'lua-formatted'
      || segment.kind === 'lua-long-string'
      || segment.kind === 'lua-language') return true;
    if (segment.kind === 'lua-button'
      || segment.kind === 'lua-attribute'
      || segment.kind === 'lua-text-node') return true;
    if (wouldChangeSource(segment)) ignoredLuaSegments += 1;
    return false;
  });
  const draft = applySelectedLanguagePromptBridge(applyApprovedSegments(original, safeSegments));
  return {
    draft,
    ignoredLuaSegments,
    syntaxIssues: validateRisuLuaChanges(original, draft),
  };
}

function applySelectedLanguagePromptBridge(module: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'code' && typeof child === 'string') {
        (value as Record<string, unknown>)[key] = bridgeTouhouSelectedLanguage(child);
      } else {
        visit(child);
      }
    }
  };
  visit(module);
  return module;
}

function bridgeTouhouSelectedLanguage(source: string): string {
  if (!source.includes('TH_IsValidUILang') || !source.includes('TH_NewsAuxUpdate')) return source;
  let lines = source.split('\n');
  const helperMarker = 'function set_tab_work(triggerId)';
  const helperIndex = lines.findIndex((line) => line.trim().startsWith(helperMarker));
  if (helperIndex >= 0 && !source.includes('local function TH_SelectedOutputLanguageCode(')) {
    lines.splice(helperIndex, 0, ...SELECTED_LANGUAGE_HELPERS.split('\n'), '');
  }

  const output: string[] = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === 'writeVar(triggerId, "th_story_lang", lang)'
      || trimmed === 'writeVar(triggerId, "th_sidebar_lang", lang)') {
      output.push(line);
      if (lines[index + 1]?.trim() !== 'setChatVar(triggerId, "news_init", "false")') {
        output.push(`${line.match(/^\s*/)?.[0] ?? ''}setChatVar(triggerId, "news_init", "false")`);
      }
      continue;
    }
    if (trimmed.startsWith('parts[#parts + 1] = "SYSTEM EVENT BANNER:')) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      output.push(`${indent}parts[#parts + 1] = "SYSTEM EVENT BANNER: When you actually stage this encounter in the current response (not when merely foreshadowing), mark its onset on its own line with exactly one inline tag. This event side is " .. ev.side .. ", so use " .. evTag .. ". HEADLINE must be one short line in " .. TH_SelectedOutputLanguage(triggerId) .. " (about 10 to 40 characters), announcing the event and fitting the scene, with no < > | characters. Emit at most one such tag per response, and only if the encounter actually occurs this turn."`);
      continue;
    }
    if (trimmed.startsWith('"Use concise Korean if the scene is Korean.')
      || trimmed.startsWith('"无论场景使用何种语言，headline、weather 和 aya')) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      output.push(`${indent}"Use only " .. TH_SelectedOutputLanguage(triggerId) .. " for headline, weather, and aya. Do not add markdown. Headline <= 40 characters. Aya comment <= 80 characters.",`);
      continue;
    }
    if (trimmed.startsWith('parts[#parts + 1] = "中文输出标准：')
      || trimmed.startsWith('parts[#parts + 1] = "한국어 출력 기준:')) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      output.push(`${indent}parts[#parts + 1] = "Selected-language output rule: after the introduction, the narrator must keep speaking. Do not turn non-dialogue paragraphs into neutral novel prose. Keep the selected narrator's voice, judgment, and reactions visible, and use " .. TH_SelectedOutputLanguage(triggerId) .. " consistently."`);
      continue;
    }
    if (trimmed.startsWith('parts[#parts + 1] = "角色对白应保持')
      || (trimmed.startsWith('parts[#parts + 1] = "Character dialogue remains') && trimmed.includes('Korean voice'))) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      output.push(`${indent}parts[#parts + 1] = "Character dialogue must use each speaker's natural voice in " .. TH_SelectedOutputLanguage(triggerId) .. ". The narrator must not hijack dialogue, define {{user}}'s identity, or reveal secrets they could not know."`);
      continue;
    }
    if (trimmed.startsWith('"Rules: Write in Korean if the scene is Korean.')
      || trimmed.startsWith('"规则：只用简体中文书写。')) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      output.push(`${indent}"Rules: Write only in " .. TH_SelectedOutputLanguage(triggerId) .. ". Each line is a first-person inner monologue, <= 40 characters, with no quotation marks or markdown.",`);
      continue;
    }
    if (trimmed.startsWith('"Output JSON only: {\\"thoughts\\"')
      || trimmed.startsWith('"只输出 JSON：{\\"thoughts\\"')) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      output.push(`${indent}"Output JSON only: {\\"thoughts\\":[{\\"name\\":\\"character name in the selected language\\",\\"line\\":\\"inner thought\\"}]}",`);
      continue;
    }
    if (trimmed.startsWith('"你是射命丸文，正在为东方角色扮演聊天撰写')) {
      output.push(`${line.match(/^\s*/)?.[0] ?? ''}"You are Aya Shameimaru writing a compact Bunbunmaru Newspaper status panel for a Touhou RP chat.",`);
      continue;
    }
    if (trimmed.startsWith('"只返回 JSON：{\\"headline\\"')) {
      output.push(`${line.match(/^\s*/)?.[0] ?? ''}"Return only JSON: {\\"headline\\":string,\\"weather\\":string,\\"danger\\":1-5,\\"aya\\":string}",`);
      continue;
    }
    if (trimmed.startsWith('"概括当前场景的实际状态')) {
      output.push(`${line.match(/^\s*/)?.[0] ?? ''}"Summarize the current scene state, not a generic default. If nothing happened, report that calmly.",`);
      continue;
    }
    if (trimmed.startsWith('_parts[#_parts+1] = "隐私模式：')) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      output.push(`${indent}_parts[#_parts+1] = "PRIVACY MODE: This is a public newspaper. Never describe, imply, or gossip about adult or intimate scenes. Report such scenes only in neutral, vague terms and move on. Prohibit explicit words and descriptions of body parts or sexual acts. Keep a restrained newspaper tone."`);
      continue;
    }
    output.push(line);
  }
  lines = output;

  const initIndex = lines.findIndex((line) => line.trim() === 'local function TH_NewsInit(triggerId)');
  if (initIndex >= 0 && !lines[initIndex + 1]?.includes('TH_SelectedNewsDefaults')) {
    lines.splice(initIndex + 1, 0, '  local defaultHeadline, defaultWeather, defaultAya = TH_SelectedNewsDefaults(triggerId)');
  }
  const applyIndex = lines.findIndex((line) => line.trim() === 'local function TH_NewsApply(triggerId, headline, weather, dangerRaw, aya)');
  if (applyIndex >= 0 && !lines[applyIndex + 1]?.includes('TH_SelectedNewsDefaults')) {
    lines.splice(applyIndex + 1, 0, '  local defaultHeadline, defaultWeather, defaultAya = TH_SelectedNewsDefaults(triggerId)');
  }

  return lines.map((line) => {
    if (line.includes('TH_NewsSet(triggerId, "news_headline", "')) {
      return `${line.match(/^\s*/)?.[0] ?? ''}TH_NewsSet(triggerId, "news_headline", defaultHeadline)`;
    }
    if (line.includes('TH_NewsSet(triggerId, "news_weather", "')) {
      return `${line.match(/^\s*/)?.[0] ?? ''}TH_NewsSet(triggerId, "news_weather", defaultWeather)`;
    }
    if (line.includes('TH_NewsSet(triggerId, "news_aya_comment", "')) {
      return `${line.match(/^\s*/)?.[0] ?? ''}TH_NewsSet(triggerId, "news_aya_comment", defaultAya)`;
    }
    return line
      .replace(/TH_NewsCleanText\(headline,\s*"[^"]*",\s*80\)/, 'TH_NewsCleanText(headline, defaultHeadline, 80)')
      .replace(/TH_NewsCleanText\(weather,\s*"[^"]*",\s*40\)/, 'TH_NewsCleanText(weather, defaultWeather, 40)')
      .replace(/TH_NewsCleanText\(aya,\s*"[^"]*",\s*160\)/, 'TH_NewsCleanText(aya, defaultAya, 160)');
  }).join('\n');
}

const SELECTED_LANGUAGE_HELPERS = `local function TH_SelectedOutputLanguageCode(triggerId)
  local lang = tostring(readVar(triggerId, "th_sidebar_lang") or "")
  if not TH_IsValidUILang(lang) then
    lang = tostring(readVar(triggerId, "th_story_lang") or "")
  end
  if not TH_IsValidUILang(lang) then lang = "zh" end
  return lang
end

local function TH_SelectedOutputLanguage(triggerId)
  local labels = { ko = "Korean", en = "English", zh = "Simplified Chinese", ja = "Japanese" }
  return labels[TH_SelectedOutputLanguageCode(triggerId)] or labels.zh
end

local function TH_SelectedNewsDefaults(triggerId)
  local defaults = {
    ko = { "환상향, 오늘도 평화", "맑음", "특별한 사건은 없습니다. 한가롭군요." },
    en = { "Gensokyo, Peaceful Today", "Clear", "No special incidents. Rather quiet today." },
    zh = { "幻想乡，今日和平", "晴朗", "没有特别事件。今天还真清闲。" },
    ja = { "幻想郷、本日も平和", "晴れ", "特別な事件はありません。今日はのどかですね。" },
  }
  local selected = defaults[TH_SelectedOutputLanguageCode(triggerId)] or defaults.zh
  return selected[1], selected[2], selected[3]
end`;

export function validateRisuLuaChanges(
  original: Record<string, unknown>,
  draft: Record<string, unknown>,
): LuaSyntaxIssue[] {
  const originalCode = collectLuaCode(original);
  const draftCode = collectLuaCode(draft);
  const issues: LuaSyntaxIssue[] = [];

  for (const [pathJson, source] of originalCode) {
    const candidate = draftCode.get(pathJson);
    if (candidate == null || candidate === source || !parsesAsLua(source)) continue;
    try {
      parse(candidate, { luaVersion: '5.3' });
    } catch (error) {
      issues.push({
        pathLabel: `模块.${(JSON.parse(pathJson) as Array<string | number>).join('.')}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return issues;
}

function collectLuaCode(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (child: unknown, path: Array<string | number>) => {
    if (typeof child === 'string') {
      if (isLuaModuleCodePath(path)) result.set(JSON.stringify(path), child);
      return;
    }
    if (Array.isArray(child)) {
      child.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (!child || typeof child !== 'object') return;
    for (const [key, entry] of Object.entries(child)) visit(entry, [...path, key]);
  };
  visit(value, []);
  return result;
}

function parsesAsLua(source: string): boolean {
  try {
    parse(source, { luaVersion: '5.3' });
    return true;
  } catch {
    return false;
  }
}

function parsePath(pathJson: string): Array<string | number> {
  try {
    return JSON.parse(pathJson) as Array<string | number>;
  } catch {
    return [];
  }
}

function wouldChangeSource(segment: ApplicableSegment): boolean {
  if (segment.reviewStatus !== 'approved') return false;
  const output = segment.finalText?.trim() || segment.translatedText?.trim();
  return Boolean(output && output !== segment.sourceText);
}
