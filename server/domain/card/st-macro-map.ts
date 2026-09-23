/**
 * SillyTavern macro names → RisuAI macro names.
 *
 * ST macros are camelCase (`{{lastMessageId}}`) while RisuAI registers lowercase
 * names (`lastmessageid`), and a few differ in spelling (`not_equal` vs
 * `notequal`). Without this layer a perfectly normal ST preset is rejected as
 * "contains unverified macros", which is what blocked generalising the
 * conversion: correctness required guessing, so the converter refused instead.
 *
 * The rewrite is deliberately conservative:
 *
 * - Only the **macro name** is touched. Arguments, nesting and surrounding text
 *   are copied byte for byte, so a rename can never damage content.
 * - Names that RisuAI also registers are left alone, including the ones that
 *   already match (`{{settempvar}}`, `{{getvar}}`, `{{random}}`).
 * - Names with no RisuAI counterpart are **preserved and reported**, never
 *   deleted. A preset that uses them still converts; the report says which
 *   behaviour will not run.
 */
import { RISU_KNOWN_MACROS, ST_ARITHMETIC_MACROS, ST_MACRO_ALIASES } from './preset-capability.js';

export type MacroRewriteKind = 'case' | 'alias' | 'expression' | 'unsupported';

export interface MacroRewrite {
  from: string;
  to: string;
  kind: MacroRewriteKind;
  /** Occurrences rewritten (or found, for `unsupported`). */
  count: number;
}

export interface MacroNormalizationResult {
  text: string;
  rewrites: MacroRewrite[];
  /** Distinct macro names RisuAI does not register, left in place. */
  unsupported: string[];
  changed: boolean;
}

/**
 * Names that are not a case variant of a RisuAI macro but still have an
 * equivalent. The table lives in `preset-capability.ts` so the capability
 * reporter and this rewriter cannot disagree about what is migratable.
 */
const NAME_ALIASES = ST_MACRO_ALIASES;

/** Lowercased RisuAI name → its canonical spelling. */
const CANONICAL = new Map<string, string>();
for (const name of RISU_KNOWN_MACROS) {
  const lower = name.toLowerCase();
  if (!CANONICAL.has(lower)) CANONICAL.set(lower, name);
}

/**
 * Can this macro name resolve after normalisation?
 *
 * The capability reporter needs the same knowledge as the rewriter: a name that
 * is only a spelling variant (`lastUserMessage`) or a known alias
 * (`lastusermessage` → `previoususerchat`) is perfectly migratable and must not
 * be reported as a third-party macro that will not expand.
 */
export function isResolvableMacro(name: string): boolean {
  const lower = name.toLowerCase();
  return CANONICAL.has(lower) || NAME_ALIASES.has(lower) || ARITHMETIC.has(lower);
}

/**
 * `{{incvar::x}}` / `{{decvar::x}}` are arithmetic on RisuAI's `addvar`.
 *
 * Keys must match `ST_ARITHMETIC_MACROS` in `preset-capability.ts`.
 */
const ARITHMETIC = new Map<string, number>([
  ['incvar', 1],
  ['decvar', -1],
]);
// Fail loudly at import time if the two tables drift apart.
for (const name of ST_ARITHMETIC_MACROS) {
  if (!ARITHMETIC.has(name)) throw new Error(`算术宏 ${name} 未在 st-macro-map 中定义`);
}

export function normalizeStMacros(source: string): MacroNormalizationResult {
  const rewrites = new Map<string, MacroRewrite>();
  const unsupported = new Set<string>();
  let changed = false;

  const record = (from: string, to: string, kind: MacroRewriteKind): void => {
    const key = `${from}\u0000${to}\u0000${kind}`;
    const existing = rewrites.get(key);
    if (existing) existing.count += 1;
    else rewrites.set(key, { from, to, kind, count: 1 });
  };

  /**
   * Rewrite one `{{name::…}}` token. Nesting is handled by recursing into the
   * argument text, which is where ST puts `{{getvar::x}}` inside `{{#when::…}}`.
   */
  const rewriteToken = (name: string, args: string): string => {
    if (!name) return '';
    const lower = name.toLowerCase();
    // `args` carries its own separator (`::x::y`, or `:1d6` for RisuAI's dice
    // syntax). Preserve it verbatim so rebuilding a token cannot turn `:` into
    // `::`.
    const separator = args.startsWith('::') ? '::' : args.startsWith(':') ? ':' : '';
    const trimmedArgs = args.slice(separator.length);

    // Block keywords are control flow, not macros: `#when`, `:else`, `/when`.
    if (name.startsWith('#') || name.startsWith('/') || name.startsWith(':')) {
      return `{{${name}${args}}}`;
    }

    if (ARITHMETIC.has(lower)) {
      const amount = ARITHMETIC.get(lower) as number;
      record(name, `addvar::${trimmedArgs}::${amount}`, 'expression');
      changed = true;
      return `{{addvar::${trimmedArgs}::${amount}}}`;
    }

    const alias = NAME_ALIASES.get(lower);
    if (alias) {
      record(name, alias, 'alias');
      changed = true;
      return `{{${alias}${args}}}`;
    }

    const canonical = CANONICAL.get(lower);
    if (canonical) {
      if (canonical !== name) {
        record(name, canonical, 'case');
        changed = true;
      }
      return `{{${canonical}${args}}}`;
    }

    // Unknown to RisuAI: keep it so nothing is silently dropped, and report it.
    unsupported.add(name);
    record(name, name, 'unsupported');
    return `{{${name}${args}}}`;
  };

  let out = '';
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('{{', index);
    if (open === -1) {
      out += source.slice(index);
      break;
    }
    out += source.slice(index, open);

    // Macros nest (`{{#when::{{getvar::x}}}}`), so the closing `}}` must be the
    // one that matches this `{{` — taking the first `}}` would slice the token
    // at the inner macro's terminator and lose the inner rewrite.
    let depth = 0;
    let cursor = open;
    let close = -1;
    while (cursor < source.length) {
      if (source.startsWith('{{', cursor)) {
        depth += 1;
        cursor += 2;
        continue;
      }
      if (source.startsWith('}}', cursor)) {
        depth -= 1;
        if (depth === 0) {
          close = cursor;
          break;
        }
        cursor += 2;
        continue;
      }
      cursor += 1;
    }
    if (close === -1) {
      // Unterminated macro: emit the rest verbatim.
      out += source.slice(open);
      break;
    }
    const body = source.slice(open + 2, close);
    // The macro name runs until `::`, whitespace, or the end of the token.
    const nameMatch = /^([#/:]?[A-Za-z_][A-Za-z0-9_]*)/u.exec(body);
    if (!nameMatch) {
      out += source.slice(open, close + 2);
      index = close + 2;
      continue;
    }
    const name = nameMatch[1];
    const rest = body.slice(name.length);
    // Recurse so nested macros are normalised too.
    const inner = normalizeInner(rest);
    out += rewriteToken(name, inner);
    index = close + 2;
  }

  /** Nested args may contain macros; their rewrites must be recorded too. */
  function normalizeInner(fragment: string): string {
    if (!fragment.includes('{{')) return fragment;
    const nested = normalizeStMacros(fragment);
    for (const rewrite of nested.rewrites) {
      for (let i = 0; i < rewrite.count; i += 1) record(rewrite.from, rewrite.to, rewrite.kind);
    }
    for (const name of nested.unsupported) unsupported.add(name);
    if (nested.changed) changed = true;
    return nested.text;
  }

  const list = [...rewrites.values()];
  return {
    text: out,
    rewrites: list.filter((rewrite) => rewrite.kind !== 'unsupported'),
    unsupported: [...unsupported].sort(),
    changed,
  };
}

/** True when the text uses any macro name RisuAI does not register. */
export function hasUnsupportedMacros(source: string): boolean {
  return normalizeStMacros(source).unsupported.length > 0;
}
