import type { ComposerInlineToken } from "./composerInlineTokens.ts";

/**
 * Resolve complete skill mentions against offered names, without changing prompt
 * text or attaching provider IDs. Ranges use JS string indexes and exclude prose
 * delimiters. Unlike live composer tokenization, end-of-input is complete here.
 */
export function composerSkillMentionsResolve(
  text: string,
  offeredNames: ReadonlyArray<string>,
): ReadonlyArray<Extract<ComposerInlineToken, { type: "skill" }>> {
  const names = [...new Set(offeredNames)].filter((name) => name.length > 0);
  if (names.length === 0) return [];
  names.sort((left, right) => right.length - left.length);

  const mentions: Extract<ComposerInlineToken, { type: "skill" }>[] = [];
  const prefixes = /(^|[\s([{])(\p{Sc})/gu;
  // A punctuation run is prose only when it ends at whitespace/end-of-input.
  // Thus `$skill:review` and `$skill)extra` cannot select a shorter `$skill`.
  const boundary = /[.,;:!?)}\]]*(?=\s|$)/uy;

  for (const prefix of text.matchAll(prefixes)) {
    const start = prefix.index + (prefix[1]?.length ?? 0);
    if (start < (mentions.at(-1)?.end ?? 0)) continue;
    const nameStart = start + (prefix[2]?.length ?? 0);

    for (const name of names) {
      if (!text.startsWith(name, nameStart)) continue;
      const end = nameStart + name.length;
      boundary.lastIndex = end;
      if (!boundary.test(text)) continue;

      mentions.push({ type: "skill", value: name, source: text.slice(start, end), start, end });
      break;
    }
  }

  return mentions;
}
