export type IntegrityIssueDestination = 'lua' | 'review';

const LUA_MANAGEMENT_ERROR_CODES = new Set([
  'RISU_LUA_SYNTAX_INVALID',
  'RISU_SCRIPT_INTEGRITY_INVALID',
  'RISU_TEMPLATE_INVALID',
]);

/**
 * Keep structural Risu failures out of the text review queue. Their repair
 * surface is the Lua management page, even when the server cannot associate
 * a stored visible-text segment with the failing code block.
 */
export function integrityIssueDestination(
  payload: Record<string, unknown> | null | undefined,
  message = '',
): IntegrityIssueDestination {
  const code = typeof payload?.code === 'string' ? payload.code : '';
  if (LUA_MANAGEMENT_ERROR_CODES.has(code)) return 'lua';
  return /(?:Risu\s+)?Lua\s+语法|脚本引用(?:完整性)?校验|模板结构(?:校验)?/u.test(message)
    ? 'lua'
    : 'review';
}
