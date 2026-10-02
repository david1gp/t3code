import { describe, expect, it } from "vite-plus/test";

import { composerSkillMentionsResolve } from "@t3tools/shared/composerInlineTokens";

describe("composerSkillMentionsResolve", () => {
  it("resolves exact colon names rather than an offered shorter prefix", () => {
    expect(
      composerSkillMentionsResolve("Use $skill:review now", ["skill", "skill:review"]),
    ).toEqual([
      { type: "skill", value: "skill:review", source: "$skill:review", start: 4, end: 17 },
    ]);
  });

  it.each(["skill)", "skill]", "skill}", "skill:", "skill!", "skill."])(
    "keeps closing punctuation inside the exact offered name %s",
    (name) => {
      const text = `Use $${name}, next`;
      expect(composerSkillMentionsResolve(text, ["skill", name])).toEqual([
        { type: "skill", value: name, source: `$${name}`, start: 4, end: 5 + name.length },
      ]);
      expect(text.slice(5 + name.length)).toBe(", next");
    },
  );

  it.each([")", "]", "}", ".", ",", ";", ":", "!", "?", "),"])(
    "leaves following prose delimiter %s outside the mention range",
    (delimiter) => {
      const text = `Use $skill${delimiter} next`;
      expect(composerSkillMentionsResolve(text, ["skill"])).toEqual([
        { type: "skill", value: "skill", source: "$skill", start: 4, end: 10 },
      ]);
      expect(text.slice(10)).toBe(`${delimiter} next`);
    },
  );

  it.each(["skill", "skill:review", "skill)"])(
    "resolves the complete offered name %s at end of input",
    (name) => {
      expect(composerSkillMentionsResolve(`$${name}`, ["skill", name])).toEqual([
        { type: "skill", value: name, source: `$${name}`, start: 0, end: name.length + 1 },
      ]);
    },
  );

  it("keeps end-of-input closing delimiters outside a shorter offered name", () => {
    expect(composerSkillMentionsResolve("($skill).", ["skill"])).toEqual([
      { type: "skill", value: "skill", source: "$skill", start: 1, end: 7 },
    ]);
  });

  it("matches longest exact names independently of catalog order and without duplicates", () => {
    const text = "$skill:review) $skill:review $skill";
    const expected = [
      { type: "skill", value: "skill:review)", source: "$skill:review)", start: 0, end: 14 },
      { type: "skill", value: "skill:review", source: "$skill:review", start: 15, end: 28 },
      { type: "skill", value: "skill", source: "$skill", start: 29, end: 35 },
    ];
    const names = ["", "skill", "skill:review", "skill:review)", "skill"];
    expect(composerSkillMentionsResolve(text, names)).toEqual(expected);
    expect(composerSkillMentionsResolve(text, names.toReversed())).toEqual(expected);
  });

  it.each([
    "$skill:review)extra",
    "$skill)extra",
    "$skill.extra",
    "$skills",
    "$skill/path",
    "$skill-name",
    "$skill_other",
  ])("leaves unknown skill text %s literal instead of resolving a shorter prefix", (text) => {
    expect(composerSkillMentionsResolve(text, ["skill", "skill:review", "skill)"])).toEqual([]);
  });

  it("leaves an unknown colon-qualified name literal when only its prefix is offered", () => {
    expect(composerSkillMentionsResolve("$skill:review", ["skill"])).toEqual([]);
  });

  it("keeps slash commands and unknown names outside the skill namespace", () => {
    const text = "/skill /unknown $unknown $skill";
    expect(composerSkillMentionsResolve(text, ["skill"])).toEqual([
      { type: "skill", value: "skill", source: "$skill", start: 25, end: 31 },
    ]);
  });

  it.each(["prefix$skill", "\\$skill", "`$skill`", "'$skill'", '"$skill"', "$$skill"])(
    "does not treat embedded, escaped, or quoted text %s as an invocation",
    (text) => {
      expect(composerSkillMentionsResolve(text, ["skill"])).toEqual([]);
    },
  );

  it("supports whitespace and opening punctuation boundaries with stable repeated mention offsets", () => {
    const text = "($skill)\n[$skill]\t{$skill}";
    expect(composerSkillMentionsResolve(text, ["skill"])).toEqual([
      { type: "skill", value: "skill", source: "$skill", start: 1, end: 7 },
      { type: "skill", value: "skill", source: "$skill", start: 10, end: 16 },
      { type: "skill", value: "skill", source: "$skill", start: 19, end: 25 },
    ]);
  });

  it("uses JS string indexes and exact slices after astral characters and currency prefixes", () => {
    const text = "😀 $skill:review), 𑿝skill)";
    const mentions = composerSkillMentionsResolve(text, ["skill:review", "skill)"]);
    expect(mentions).toEqual([
      { type: "skill", value: "skill:review", source: "$skill:review", start: 3, end: 16 },
      { type: "skill", value: "skill)", source: "𑿝skill)", start: 19, end: 27 },
    ]);
    for (const mention of mentions) {
      expect(text.slice(mention.start, mention.end)).toBe(mention.source);
    }
  });

  it("treats catalog names literally rather than as regex patterns or normalized aliases", () => {
    expect(
      composerSkillMentionsResolve("$tools/review.v2+ $Review $review", [
        "tools/review.v2+",
        "Review",
        " review ",
      ]),
    ).toEqual([
      { type: "skill", value: "tools/review.v2+", source: "$tools/review.v2+", start: 0, end: 17 },
      { type: "skill", value: "Review", source: "$Review", start: 18, end: 25 },
    ]);
  });

  it("leaves all text literal when no nonempty names are offered", () => {
    expect(composerSkillMentionsResolve("$skill /skill $unknown", [])).toEqual([]);
    expect(composerSkillMentionsResolve("$skill /skill $unknown", [""])).toEqual([]);
  });
});
