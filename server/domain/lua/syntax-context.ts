/** Locate a changed line using unchanged surrounding code, not matching line numbers.
 * Ambiguous insertions/deletions deliberately have no claimed source counterpart.
 */
export function locateLuaSourceLine(source: string[], draft: string[], line: number): number | undefined {
  let prefix = 0;
  while (prefix < source.length && prefix < draft.length && source[prefix] === draft[prefix]) prefix++;
  if (line <= prefix) return line;
  let suffix = 0;
  while (suffix < source.length - prefix && suffix < draft.length - prefix
    && source[source.length - 1 - suffix] === draft[draft.length - 1 - suffix]) suffix++;
  if (line > draft.length - suffix) return line + source.length - draft.length;
  const positions = new Map<string, number[]>();
  source.forEach((text, index) => {
    const matches = positions.get(text);
    if (matches) matches.push(index);
    else positions.set(text, [index]);
  });
  let before = { source: prefix - 1, draft: prefix - 1 };
  let after = { source: source.length - suffix, draft: draft.length - suffix };
  for (let index = prefix; index < draft.length - suffix; index++) {
    const matches = positions.get(draft[index]);
    if (!draft[index].trim() || matches?.length !== 1) continue;
    const match = matches[0];
    if (match < prefix || match >= source.length - suffix) continue;
    if (index < line - 1) before = { source: match, draft: index };
    else if (index === line - 1) return match + 1;
    else { after = { source: match, draft: index }; break; }
  }
  if (before.source >= after.source || after.source - before.source !== after.draft - before.draft) return undefined;
  return line + before.source - before.draft;
}


/** A reference location is useful even when no exact line pairing exists. */
export function luaSourceReference(source: string[], draft: string[], line: number): number {
  const declaration = draft[line - 1]?.match(/^(\s*(?:local\s+)?function\s+)([^ (]+)(\s*\(.*)$/u);
  if (declaration) {
    const candidates = source.map((text, index) => ({ index, match: text.match(/^(\s*(?:local\s+)?function\s+)([^ (]+)(\s*\(.*)$/u) }))
      .filter(item => item.match && item.match[3] === declaration[3]);
    const ranked = candidates.map(item => {
      const name = item.match![2];
      let prefix = 0;
      while (prefix < name.length && name[prefix] === declaration[2][prefix]) prefix++;
      let suffix = 0;
      while (suffix < name.length - prefix && name[name.length - 1 - suffix] === declaration[2][declaration[2].length - 1 - suffix]) suffix++;
      return { line: item.index + 1, score: prefix + suffix };
    }).sort((a, b) => b.score - a.score);
    if (ranked[0]?.score >= 4 && (!ranked[1] || ranked[0].score > ranked[1].score)) return ranked[0].line;
  }
  return Math.max(1, Math.min(source.length, line));
}
