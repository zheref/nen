// src/commit/bodywidth.test.ts -- the repository's own commitlint
// body-max-line-length and footer-max-line-length, read where commitlint
// reads them, the body width nen/workflow.json may declare, and the one check
// both `commit` verbs run (zheref/nen#290).

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommitlintConfigError, CONFIG_CONVENTIONAL } from "./commitlint.js";
import {
  declaredBodyWidth,
  leftOverWarnings,
  lineLengthFindings,
  readLineLengthRules,
  wrapFormatBody,
  wrapWidths,
  type DeclaredWidth,
  type LineLengthRules,
} from "./bodywidth.js";
import { loadWorkflow } from "../schema/workflow.js";

/** A checkout root holding exactly these files. */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nen-bodywidth-"));
  mkdirSync(join(root, ".git"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text, "utf8");
  return root;
}

const conventional = JSON.stringify({ extends: [CONFIG_CONVENTIONAL] });
const rc = (config: unknown): Record<string, string> => ({ ".commitlintrc.json": JSON.stringify(config) });

/** zheref/kro-pwa's commitlint.config.cjs, in shape: code, extending config-conventional, a plugin, and a header rule. */
const KRO_PWA_CONFIG = `module.exports = {
  extends: ['@commitlint/config-conventional'],
  plugins: [{ rules: { 'no-llm-attribution': ({ raw }) => [!/claude/i.test(raw ?? ''), 'no'] } }],
  rules: { 'header-max-length': [2, 'always', 72], 'no-llm-attribution': [2, 'always'] },
}
throw new Error('nen executed the repository config')
`;
const KRO_PWA = { "commitlint.config.cjs": KRO_PWA_CONFIG };

const ABSENT: LineLengthRules = { body: { kind: "absent" }, footer: { kind: "absent" }, shadowed: null };
const declared = (width: number, file = "/r/nen/workflow.json"): DeclaredWidth => ({ file, width });
const rules = (files: Record<string, string>, declaration: DeclaredWidth | null = null): LineLengthRules => readLineLengthRules(repo(files), declaration);

/** A message with a header, this body, and one trailer. */
const message = (body: string, trailer = "Hatsu-Agent: kurapika"): string => `fix: x\n\n${body}\n\n${trailer}\n`;

const LONG = `This rebuilds the capture prompt so that endeavor pills render inline, and the Inbox triage keeps its selection.`;
const NONE = { refusals: [], warnings: [], notes: [] };

describe("readLineLengthRules -- the file ./commitlint.ts finds, resolved the same way", () => {
  it("is absent with no config, and config-conventional's [2, 'always', 100] through extends", () => {
    expect(readLineLengthRules(repo({}), null)).toEqual(ABSENT);
    const root = repo({ ".commitlintrc.json": conventional });
    const file = join(root, ".commitlintrc.json");
    const rule = { kind: "rule", file, origin: "extends", level: 2, max: 100, stated: 100 };
    expect(readLineLengthRules(root, null)).toEqual({ body: rule, footer: rule, shadowed: null });
  });

  it("takes an explicit rule over config-conventional's, each rule on its own", () => {
    const read = rules({ ".commitlintrc.yaml": `extends: ["${CONFIG_CONVENTIONAL}"]\nrules:\n  body-max-line-length: [1, always, 72]\n` });
    expect(read.body).toMatchObject({ kind: "rule", origin: "rules", level: 1, max: 72 });
    expect(read.footer).toMatchObject({ kind: "rule", origin: "extends", level: 2, max: 100 });
  });

  it("reads 'none' with no rule and no config-conventional, and 'off' at level 0", () => {
    const root = repo({ "package.json": JSON.stringify({ commitlint: { rules: { "footer-max-line-length": [0] } } }) });
    const file = join(root, "package.json");
    expect(readLineLengthRules(root, null)).toEqual({ body: { kind: "none", file }, footer: { kind: "off", file }, shadowed: null });
  });

  it("reads a width as commitlint compares it -- never refusing one (review M1)", () => {
    expect(rules(rc({ rules: { "body-max-line-length": [2, "always", "100"] } })).body).toMatchObject({ kind: "rule", max: 100, stated: "100" });
    expect(rules(rc({ rules: { "body-max-line-length": [2, "always"] } })).body).toMatchObject({ kind: "rule", max: 0, stated: undefined });
    expect(rules(rc({ rules: { "footer-max-line-length": [1, "always", "abc"] } })).footer).toMatchObject({ kind: "rule", level: 1, stated: "abc" });
  });

  it("never executes a code config -- kro-pwa's shape -- and reads it as NOT read, naming the file", () => {
    const root = repo(KRO_PWA);
    const read = readLineLengthRules(root, null);
    expect(read.body).toEqual({
      kind: "unreadable",
      file: join(root, "commitlint.config.cjs"),
      cause: `${join(root, "commitlint.config.cjs")} is a JavaScript/TypeScript commitlint config nen does not execute`,
    });
    expect(read.footer).toEqual(read.body);
  });

  it("cannot read the rules through $import, a preset after config-conventional, or a package key that will not parse", () => {
    expect(rules(rc({ $import: "./base.json" })).body).toMatchObject({ kind: "unreadable", cause: expect.stringMatching(/uses cosmiconfig's '\$import'/) });
    expect(rules(rc({ extends: [CONFIG_CONVENTIONAL, "@acme/commitlint"] })).body).toMatchObject({
      kind: "unreadable",
      cause: expect.stringMatching(/extends '@acme\/commitlint'.*stating 'body-max-line-length' under the file's own 'rules' makes it decisive/),
    });
    // An explicit rule is decisive whatever is extended.
    expect(rules(rc({ extends: ["@acme/commitlint"], rules: { "footer-max-line-length": [2, "always", 80] } })).footer).toMatchObject({ kind: "rule", origin: "rules", max: 80 });
    expect(rules({ "package.json": `{ "commitlint": { "extends": [ }` }).body).toMatchObject({
      kind: "unreadable",
      cause: expect.stringMatching(/carries a 'commitlint' key but will not parse \(it is not valid JSON/),
    });
  });

  it("refuses at exit 1 only a shape commitlint itself rejects, naming the line-length rule", () => {
    const thrown = (files: Record<string, string>): CommitlintConfigError => {
      try {
        readLineLengthRules(repo(files), null);
      } catch (error) {
        if (error instanceof CommitlintConfigError) return error;
        throw error;
      }
      throw new Error("expected a CommitlintConfigError");
    };
    const shape = thrown(rc({ rules: { "body-max-line-length": [2, "sometimes", 100] } }));
    expect(shape.rule).toBe("body-max-line-length");
    expect(shape.message).toMatch(/could not be read for its commitlint 'body-max-line-length' rule: rule 'body-max-line-length' must have 'always' or 'never' as its condition, received \[2,"sometimes",100\] -- commitlint refuses the config too$/);
    expect(thrown(rc({ rules: { "footer-max-line-length": [5] } })).message).toMatch(/'footer-max-line-length' rule: rule 'footer-max-line-length' must start with a level of 0, 1 or 2/);
    expect(thrown({ ".commitlintrc.json": "{ nope" }).message).toMatch(/'body-max-line-length' rule: it is not valid JSON/);
    expect(thrown(rc({ rules: [] })).message).toMatch(/'rules' must be an object/);
  });
});

describe("commits.bodyMaxLineLength -- the ruling's precedence, on commits.subjectCase's pattern", () => {
  it("reads the declaration a loaded nen/workflow.json carries, or null", () => {
    const root = repo({});
    expect(declaredBodyWidth(loadWorkflow(root))).toBeNull();
    mkdirSync(join(root, "nen"));
    writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ commits: { bodyMaxLineLength: 150 } }));
    expect(declaredBodyWidth(loadWorkflow(root))).toEqual({ file: join(root, "nen", "workflow.json"), width: 150 });
  });

  it("BINDS where the config is code, or there is none -- the body only; the footer is untouched", () => {
    const root = repo(KRO_PWA);
    const code = readLineLengthRules(root, declared(150));
    expect(code.body).toEqual({
      kind: "declared",
      file: "/r/nen/workflow.json",
      max: 150,
      because: `${join(root, "commitlint.config.cjs")} is a JavaScript/TypeScript commitlint config nen does not execute`,
      commitlintRuns: true,
    });
    expect(code.footer).toMatchObject({ kind: "unreadable" });
    expect(code.shadowed).toBeNull();
    const bare = repo({});
    expect(readLineLengthRules(bare, declared(72)).body).toEqual({
      kind: "declared",
      file: "/r/nen/workflow.json",
      max: 72,
      because: `no commitlint config was found at ${bare}`,
      commitlintRuns: false,
    });
    expect(readLineLengthRules(bare, declared(72)).footer).toEqual({ kind: "absent" });
    expect(rules(rc({ $import: "./base.json" }), declared(120)).body).toMatchObject({ kind: "declared", max: 120, because: expect.stringMatching(/'\$import'/) });
  });

  it("is NOT applied beside a readable data config, which decides -- the note says whether the two agree", () => {
    const agree = rules(rc({ extends: [CONFIG_CONVENTIONAL] }), declared(100));
    expect(agree.body).toMatchObject({ kind: "rule", max: 100 });
    expect(agree.shadowed).toMatch(/^commits\.bodyMaxLineLength in \/r\/nen\/workflow\.json is not applied: .*\.commitlintrc\.json states the commitlint config as data.*The declaration agrees with it: redundant here -- remove it, or keep it in step$/);
    const differ = rules(rc({ extends: [CONFIG_CONVENTIONAL] }), declared(150));
    expect(differ.shadowed).toMatch(
      /^commits\.bodyMaxLineLength in \/r\/nen\/workflow\.json is not applied, and it DIFFERS: .*\.commitlintrc\.json states \[2, "always", 100\] \(@commitlint\/config-conventional's default, through extends\), the declaration states 150; nen follows .*\.commitlintrc\.json, which is what commitlint runs -- align the declaration with it, or remove it$/,
    );
    expect(rules(rc({ rules: { "body-max-line-length": [1, "always", 100] } }), declared(100)).shadowed).toMatch(/DIFFERS: .* states \[1, "always", 100\], the declaration states 100/);
    expect(rules(rc({ rules: {} }), declared(100)).shadowed).toMatch(/DIFFERS: .* states no body-max-line-length rule, the declaration/);
    expect(rules(rc({ rules: { "body-max-line-length": [0] } }), declared(100)).shadowed).toMatch(/DIFFERS: .* states body-max-line-length turned off \(\[0\]\)/);
    expect(rules(rc({ rules: { "body-max-line-length": [2, "always"] } }), declared(100)).shadowed).toMatch(/DIFFERS: .* states \[2, "always", \(no width\)\]/);
  });
});

describe("wrapWidths -- a readable or declared width, none for a rule turned off, else config-conventional's 100", () => {
  it("wraps to the rule, the declaration or 100, and not at all under a rule off or a width no wrap can meet (review L2)", () => {
    expect(wrapWidths(ABSENT)).toEqual({ body: 100, footer: 100 });
    expect(wrapWidths(rules(rc({ rules: { "body-max-line-length": [1, "always", 72], "footer-max-line-length": [0] } })))).toEqual({ body: 72, footer: null });
    expect(wrapWidths(rules(rc({ rules: { "body-max-line-length": [2, "always", 0.5] } })))).toEqual({ body: null, footer: 100 });
    expect(wrapWidths(rules(KRO_PWA))).toEqual({ body: 100, footer: 100 });
    // Where the declaration binds, the --body prose commitlint reads as footer is held -- and wrapped -- to it too (F1).
    expect(wrapWidths(rules(KRO_PWA, declared(150)))).toEqual({ body: 150, footer: 150 });
    expect(wrapWidths(rules({}, declared(72)))).toEqual({ body: 72, footer: 72 });
  });
});

describe("lineLengthFindings -- the one check both verbs run", () => {
  it("refuses a body line over a level-2 rule, naming the line, its length, the rule and where it is set", () => {
    const found = lineLengthFindings(message(LONG), rules(rc({ extends: [CONFIG_CONVENTIONAL] })));
    expect(found.warnings).toEqual([]);
    expect(found.notes).toEqual([]);
    expect(found.refusals).toHaveLength(1);
    expect(found.refusals[0]).toMatch(
      /^line 3 is 112 characters, over the 100 that this repository's commitlint rule 'body-max-line-length' allows \(@commitlint\/config-conventional's default, which .*\.commitlintrc\.json extends\): 'This rebuilds the capture prompt so that endeavor pills rend\.\.\.'\. commitlint refuses this message at commit time, so nen refuses it now: break it at a space so no line is over 100 characters/,
    );
  });

  it("warns, and does not refuse, under a level-1 rule", () => {
    const found = lineLengthFindings(message(LONG), rules(rc({ rules: { "body-max-line-length": [1, "always", 100] } })));
    expect(found.refusals).toEqual([]);
    expect(found.warnings).toHaveLength(1);
    expect(found.warnings[0]).toMatch(/set under 'rules' in .*The rule is at level 1, so commitlint only warns and still commits -- unless the hook runs it with --strict/);
  });

  it("judges a width stated as a string at the number commitlint compares, and says so (review M1)", () => {
    const found = lineLengthFindings(message(LONG), rules(rc({ rules: { "body-max-line-length": [2, "always", "100"] } })));
    expect(found.refusals).toEqual([expect.stringMatching(/over the 100 that .*'body-max-line-length' allows \(set under 'rules' in .*, where the width is "100" and commitlint compares each line against 100\)/)]);
    expect(lineLengthFindings(message("short"), rules(rc({ rules: { "body-max-line-length": [2, "always", "100"] } })))).toEqual(NONE);
  });

  it("judges a width below 1, or not a number, as commitlint does: a message with no body passes, a body is refused -- one finding, said plainly (review M1)", () => {
    const missing = rules(rc({ rules: { "body-max-line-length": [2, "always"] } }));
    expect(lineLengthFindings("fix: x\n", missing)).toEqual(NONE);
    expect(lineLengthFindings("fix: x\n\nsee https://e.com/a\n", missing)).toEqual(NONE);
    const refused = lineLengthFindings("fix: x\n\nfirst\n\nsecond\n", missing);
    expect(refused.refusals).toEqual([
      expect.stringMatching(
        /^the body's lines 3 and 5 break this repository's commitlint rule 'body-max-line-length' \(set under 'rules' in .*, where the width is not stated and commitlint compares each line against 0\): commitlint compares each line's length against 0, so it refuses every body line that is not blank and holds no URL; a message with no body passes\. commitlint refuses this message at commit time, so nen refuses it now: give the rule a width of at least 1 -- @commitlint\/config-conventional's is 100 -- or leave the body out\.$/,
      ),
    ]);
    // NaN and a negative width refuse the blank line between them too.
    const nan = lineLengthFindings("fix: x\n\nfirst\n\nsecond\n", rules(rc({ rules: { "body-max-line-length": [2, "always", "abc"] } })));
    expect(nan.refusals[0]).toMatch(/^the body's lines 3, 4 and 5 break .*compares each line's length against NaN, so it refuses every body line that holds no URL, blank ones included/);
    const negative = lineLengthFindings("fix: x\n\nfirst\n", rules(rc({ rules: { "body-max-line-length": [1, "always", -5] } })));
    expect(negative.refusals).toEqual([]);
    expect(negative.warnings[0]).toMatch(/^the body's line 3 breaks .*against -5.*The rule is at level 1/);
  });

  it("passes a URL-bearing line of any length, as commitlint does", () => {
    expect(lineLengthFindings(message(`See https://github.com/zheref/nen/issues/290 for why ${"the body ".repeat(20)}`), rules(rc({ extends: [CONFIG_CONVENTIONAL] })))).toEqual(NONE);
  });

  it("judges a trailer -- and body prose after a footer token -- under footer-max-line-length", () => {
    const read = rules(rc({ rules: { "body-max-line-length": [2, "always", 200], "footer-max-line-length": [2, "always", 50] } }));
    const found = lineLengthFindings(message(`prose\nRefs #1 ${"x ".repeat(40)}`, `Hatsu-Agent: ${"k".repeat(60)}`), read);
    expect(found.refusals).toHaveLength(2);
    expect(found.refusals[0]).toMatch(/^line 4 is 88 characters, over the 50 that this repository's commitlint rule 'footer-max-line-length' allows/);
    // The trailer's overflow is its one long value, not a break it cannot make: named as the long word (F4).
    expect(found.refusals[1]).toMatch(/^line 6 is 73 characters, .*'footer-max-line-length'.*it holds a word longer than 50 characters, which nen never splits/);
    expect(lineLengthFindings(message("short", `Refs: ${"r ".repeat(30)}`), read).refusals[0]).toMatch(/break it at a space so no line is over 50 characters -- 'nen commit format' wraps --body this way, and never a --trailer/);
  });

  it("names the fix for a long word, preformatted text, and a line with no safe break", () => {
    const found = lineLengthFindings(message(`${"w".repeat(120)}\n    ${"p ".repeat(60)}\nx ${"a".repeat(97)} #1`), rules(rc({ extends: [CONFIG_CONVENTIONAL] })));
    expect(found.refusals[0]).toMatch(/it holds a word longer than 100 characters, which nen never splits -- shorten it \(a line holding an http\(s\) URL is exempt, as commitlint exempts it\)\.$/);
    expect(found.refusals[1]).toMatch(/it is indented as preformatted text \(four spaces or a tab\), which 'nen commit format' never rewraps -- break or shorten it by hand\.$/);
    expect(found.refusals[2]).toMatch(/no break within 100 characters keeps how commitlint reads the message -- each would start a line with a footer token .*reword it\.$/);
  });

  it("says nothing with no config and nothing declared, no such rule, or the rule off -- commitlint checks nothing there", () => {
    const long = message("w".repeat(300));
    expect(lineLengthFindings(long, ABSENT)).toEqual(NONE);
    expect(lineLengthFindings(long, rules(rc({ rules: { "subject-case": [0] } })))).toEqual(NONE);
    expect(lineLengthFindings(long, rules(rc({ extends: [CONFIG_CONVENTIONAL], rules: { "body-max-line-length": [0] } }))).refusals).toEqual([]);
  });

  it("REFUSES a body line over 100 under a code config with nothing declared -- the ruling, 'Refuse at 100, declarable'", () => {
    const root = repo(KRO_PWA);
    const read = readLineLengthRules(root, null);
    const found = lineLengthFindings(message(`short\n${"w".repeat(120)}`), read);
    expect(found.warnings).toEqual([]);
    expect(found.refusals).toEqual([
      expect.stringMatching(
        /^line 4 is 120 characters, over the 100 nen holds the body to because 'body-max-line-length' could not be read \(.*commitlint\.config\.cjs is a JavaScript\/TypeScript commitlint config nen does not execute\) -- @commitlint\/config-conventional's default, the width most commitlint configs inherit: 'w+\.\.\.'\. nen refuses it: it holds a word longer than 100 characters.* -- or, if the repository allows longer lines, declare its width in nen\/workflow\.json's commits\.bodyMaxLineLength\.$/,
      ),
    ]);
    expect(found.notes).toEqual([
      `'body-max-line-length' and 'footer-max-line-length' NOT read: ${join(root, "commitlint.config.cjs")} is a JavaScript/TypeScript commitlint config nen does not execute. So nen holds the body -- every line before the trailer block, wherever commitlint places it -- to @commitlint/config-conventional's 100 characters a line, the width most commitlint configs inherit, and refuses a line over it -- declare the repository's own width in nen/workflow.json's commits.bodyMaxLineLength if it is another; and it judges the trailer block against the same 100 for reference only -- commitlint applies whatever width the file states when the commit is made`,
    ]);
  });

  it("only WARNS for a footer line over 100 there -- the declared key and the ruling name the body only", () => {
    const found = lineLengthFindings(message("short", `Refs: ${"r ".repeat(60)}`), readLineLengthRules(repo(KRO_PWA), null));
    expect(found.refusals).toEqual([]);
    expect(found.warnings).toEqual([expect.stringMatching(/^line 5 is 126 characters: 'footer-max-line-length' NOT checked, because .*For reference only/)]);
  });

  it("notes only the rules whose section has a line in it -- and nothing for a header alone", () => {
    const read = rules(KRO_PWA);
    expect(lineLengthFindings("fix: x\n", read)).toEqual(NONE);
    const footerOnly = lineLengthFindings("fix: x\n\nHatsu-Agent: kurapika\n", read);
    expect(footerOnly.notes).toEqual([expect.stringMatching(/^'footer-max-line-length' NOT read: .*So nen judges the trailer block against the same 100 for reference only/)]);
    const bodyOnly = lineLengthFindings("fix: x\n\nprose\n", read);
    expect(bodyOnly.notes).toEqual([expect.stringMatching(/^'body-max-line-length' NOT read: .*So nen holds the body -- every line before the trailer block, wherever commitlint places it -- to .* and refuses a line over it/)]);
  });

  it("holds the body to a DECLARED width: refused over it, a note naming its source when it passes", () => {
    const root = repo(KRO_PWA);
    const read = readLineLengthRules(root, declared(150));
    const over = lineLengthFindings(message("w".repeat(160)), read);
    expect(over.refusals).toEqual([
      expect.stringMatching(
        /^line 3 is 160 characters, over the body width this repository declares \(commits\.bodyMaxLineLength in \/r\/nen\/workflow\.json, 150; nen applies it because .*commitlint\.config\.cjs is a JavaScript\/TypeScript commitlint config nen does not execute\): 'w+\.\.\.'\. The declaration makes the width binding, so nen refuses it: it holds a word longer than 150 characters/,
      ),
    ]);
    const within = lineLengthFindings(message("w".repeat(120)), read);
    expect(within.refusals).toEqual([]);
    expect(within.notes[0]).toMatch(/^body-max-line-length checked against commits\.bodyMaxLineLength in \/r\/nen\/workflow\.json, 150; nen applies it because .* -- keep the two in step, since commitlint still runs its own rule at commit time$/);
    // Only the footer's NOT read note follows: the body's rule was declared.
    expect(within.notes[1]).toMatch(/^'footer-max-line-length' NOT read: /);
    const bare = lineLengthFindings(message("w".repeat(60), "Refs: #1"), readLineLengthRules(repo({}), declared(50)));
    expect(bare.refusals).toHaveLength(1);
    expect(lineLengthFindings(message("short"), readLineLengthRules(repo({}), declared(50))).notes).toEqual([expect.stringMatching(/applies it because no commitlint config was found at .*[^p]$/)]);
  });

  it("prints the not-applied note on every run beside a readable config, and follows the config", () => {
    const read = rules(rc({ extends: [CONFIG_CONVENTIONAL] }), declared(150));
    expect(lineLengthFindings("fix: x\n", read).notes).toEqual([expect.stringMatching(/DIFFERS/)]);
    const found = lineLengthFindings(message("w".repeat(120)), read);
    expect(found.refusals).toEqual([expect.stringMatching(/over the 100 that this repository's commitlint rule 'body-max-line-length' allows/)]);
  });
});

describe("wrapFormatBody and leftOverWarnings -- `commit format`'s wrap, and its report on it", () => {
  it("returns a body within its limits unchanged, and no note", () => {
    expect(wrapFormatBody(["  why it matters  "], ABSENT)).toEqual({ body: ["why it matters"], warnings: [], notes: [] });
    expect(wrapFormatBody([], ABSENT)).toEqual({ body: [], warnings: [], notes: [] });
    expect(wrapFormatBody(["   "], ABSENT)).toEqual({ body: [], warnings: [], notes: [] });
  });

  it("rewraps and notes which --body lines, to which width, from where", () => {
    const root = repo(rc({ rules: { "body-max-line-length": [2, "always", 72] } }));
    const wrapped = wrapFormatBody([`${LONG}\n\n${LONG}`], readLineLengthRules(root, null));
    expect(wrapped.body[0]?.split("\n").every((line) => line.length <= 72)).toBe(true);
    expect(wrapped.notes).toEqual([
      `--body rewrapped: its lines 1 (112 characters) and 3 (112 characters) were over the 72 characters this repository's commitlint rule 'body-max-line-length' allows (set under 'rules' in ${join(root, ".commitlintrc.json")}), so nen broke them at spaces, never inside a word`,
    ]);
    expect(wrapFormatBody([LONG], ABSENT).notes).toEqual([
      "--body rewrapped: its line 1 (112 characters) was over 100 characters, nen's default width (@commitlint/config-conventional's), since no commitlint rule states one here, so nen broke it at spaces, never inside a word",
    ]);
    expect(wrapFormatBody([LONG], rules(KRO_PWA)).notes[0]).toMatch(/over 100 characters, @commitlint\/config-conventional's default, since 'body-max-line-length' could not be read, so nen broke it/);
    expect(wrapFormatBody([`${LONG} ${LONG}`], rules(KRO_PWA, declared(150))).notes[0]).toMatch(/^--body rewrapped: its line 1 \(225 characters\) was over the 150 characters this repository declares in commits\.bodyMaxLineLength \(\/r\/nen\/workflow\.json\)/);
    const footer = wrapFormatBody([`prose\nRefs #1 ${"x ".repeat(60)}`], ABSENT);
    expect(footer.notes).toEqual([expect.stringMatching(/^--body rewrapped: its line 2 \(127 characters\) was over 100 characters/)]);
  });

  it("numbers a rewrapped line as the --body was given, blank lines it starts with included (review nit)", () => {
    expect(wrapFormatBody([`\n\n${LONG}`], ABSENT).notes[0]).toMatch(/^--body rewrapped: its line 3 \(112 characters\)/);
    expect(wrapFormatBody([`  \n\t\n  ${LONG}`], ABSENT).notes[0]).toMatch(/^--body rewrapped: its line 3 \(112 characters\)/);
  });

  it("does not wrap under a rule the repository turned off, and says nothing (review L2)", () => {
    const off = rules(rc({ extends: [CONFIG_CONVENTIONAL], rules: { "body-max-line-length": [0] } }));
    expect(wrapFormatBody([LONG], off)).toEqual({ body: [LONG], warnings: [], notes: [] });
  });

  it("warns about a line it could not wrap only where no rule judges it -- numbered from message line 3", () => {
    const absent = wrapFormatBody([`short\n${"w".repeat(120)}`], ABSENT);
    expect(absent.warnings).toEqual([
      `line 4 is 120 characters, and 'commit format' could not wrap it to 100: it holds a word longer than that, which nen never splits. No commitlint rule limits it here (no commitlint config was found), so it is emitted as it is: '${"w".repeat(60)}...'.`,
    ]);
    // (./format.ts trims a paragraph, so only a line after the first can keep a preformatted indent.)
    expect(wrapFormatBody([`short\n    ${"p".repeat(120)}`], rules(rc({ rules: {} }))).warnings[0]).toMatch(
      /line 4 .*it is indented as preformatted text, which nen never rewraps\. No commitlint rule limits it here \(.*states no 'body-max-line-length'\)/,
    );
    expect(wrapFormatBody([`x ${"a".repeat(97)} #1`], ABSENT).warnings[0]).toMatch(/could not wrap it to 100: no break within that keeps how commitlint reads the message/);
    // Where a rule or a declaration judges the line, lineLengthFindings names it instead.
    expect(wrapFormatBody(["w".repeat(120)], rules(rc({ extends: [CONFIG_CONVENTIONAL] }))).warnings).toEqual([]);
    expect(wrapFormatBody(["w".repeat(120)], rules({}, declared(100))).warnings).toEqual([]);
    expect(leftOverWarnings([{ index: 0, text: "w".repeat(120), section: "body", why: "unbroken" }], rules(KRO_PWA), 3)).toEqual([]);
  });
});

describe("the message's own prose, wherever commitlint places it (review F1)", () => {
  const TOKEN = "w".repeat(120);
  const NOTE = `fix: a subject\n\nNote: the cache is now keyed by path.\n\nThe trace is at ${TOKEN}\n`;

  it("REFUSES prose commitlint reads as footer, after a 'Note:' line, under a code config -- the hook would refuse it too", () => {
    const found = lineLengthFindings(NOTE, readLineLengthRules(repo(KRO_PWA), null));
    expect(found.warnings).toEqual([]);
    expect(found.refusals).toEqual([
      expect.stringMatching(
        /^line 5 is 136 characters, over the 100 nen holds every line before the trailer block \(commitlint reads this one as footer, after a footer token\) to because 'footer-max-line-length' could not be read \(.*commitlint\.config\.cjs is a JavaScript\/TypeScript commitlint config nen does not execute\)/,
      ),
    ]);
  });

  it("holds that prose to a declared width, where the declaration binds", () => {
    const found = lineLengthFindings(NOTE, readLineLengthRules(repo(KRO_PWA), declared(120)));
    expect(found.refusals).toEqual([expect.stringMatching(/^line 5 is 136 characters, over the body width this repository declares \(commits\.bodyMaxLineLength in .*, 120; .*which holds every line before the trailer block -- commitlint reads this one as footer, after a footer token\)/)]);
    expect(lineLengthFindings(NOTE, readLineLengthRules(repo(KRO_PWA), declared(150))).refusals).toEqual([]);
  });

  it("leaves the TRAILER BLOCK to the footer's reference warning -- the ruling named body lines", () => {
    const message = `fix: x\n\nNote: prose.\n\nRefs: ${TOKEN}\nHatsu-Agent: kurapika\n`;
    const found = lineLengthFindings(message, readLineLengthRules(repo(KRO_PWA), null));
    expect(found.refusals).toEqual([]);
    expect(found.warnings).toEqual([expect.stringMatching(/^line 5 is 126 characters: 'footer-max-line-length' NOT checked, .*For reference only.*it holds a word longer than 100 characters/)]);
    // A final paragraph that is all `Key: value` IS the trailer block, as git and nen's message reader read it -- even with no trailer after it.
    expect(lineLengthFindings(`fix: x\n\nRefs: ${TOKEN}\n`, readLineLengthRules(repo(KRO_PWA), null)).refusals).toEqual([]);
    // One prose line after the trailers makes the last paragraph prose: then it is all held.
    expect(lineLengthFindings(`fix: x\n\nRefs: ${TOKEN}\nand prose\n`, readLineLengthRules(repo(KRO_PWA), null)).refusals).toHaveLength(1);
  });

  it("lets a READABLE footer rule decide the footer's prose, beside an unreadable body one", () => {
    // footer-max-line-length is explicit; the body's rule may come from @acme/commitlint, which nen cannot resolve.
    const mixed = rules(rc({ extends: [CONFIG_CONVENTIONAL, "@acme/commitlint"], rules: { "footer-max-line-length": [2, "always", 150] } }));
    expect(mixed.body.kind).toBe("unreadable");
    expect(lineLengthFindings(NOTE, mixed).refusals).toEqual([]);
    expect(wrapWidths(mixed)).toEqual({ body: 100, footer: 150 });
  });

  it("changes nothing where a readable config decides both: commitlint's own sections, its own rules", () => {
    const found = lineLengthFindings(NOTE, rules(rc({ rules: { "body-max-line-length": [2, "always", 50], "footer-max-line-length": [2, "always", 200] } })));
    expect(found).toEqual({ refusals: [], warnings: [], notes: [] });
  });
});

describe("the trailer block is the reader's own, whatever whitespace follows it (PR #302 review)", () => {
  const TOKEN = "t".repeat(120);
  const code = (): LineLengthRules => readLineLengthRules(repo(KRO_PWA), null);
  /** The one reference warning a long trailer on line 5 gets, and no refusal. */
  const trailerOnly = (message: string): void => {
    const found = lineLengthFindings(message, code());
    expect(found.refusals, JSON.stringify(message)).toEqual([]);
    expect(found.warnings, JSON.stringify(message)).toEqual([expect.stringMatching(/^line 5 is 126 characters: 'footer-max-line-length' NOT checked/)]);
  };

  it.each([
    ["a spaces-only line", `fix: x\n\nshort prose.\n\nRefs: ${TOKEN}\n   \n`],
    ["a tab-only line", `fix: x\n\nshort prose.\n\nRefs: ${TOKEN}\n\t\n`],
    ["CRLF and a mixed whitespace line", `fix: x\r\n\r\nshort prose.\r\n\r\nRefs: ${TOKEN}\r\n \t \r\n`],
    ["several whitespace lines, no final newline", `fix: x\n\nshort prose.\n\nRefs: ${TOKEN}\n  \n\t\n  `],
  ])("keeps a long trailer in the trailer block when %s follows it", (_name, message) => {
    trailerOnly(message);
  });

  it("marks every trailer of a multi-line block, not the whitespace line and the last one", () => {
    trailerOnly(`fix: x\n\nshort prose.\n\nRefs: ${TOKEN}\nHatsu-Agent: kurapika\n  \n`);
  });

  it("never marks the prose above the block as a trailer: a long prose line is still refused", () => {
    const found = lineLengthFindings(`fix: x\n\n${"p".repeat(120)}\n\nRefs: #1\n   \n   \n`, code());
    expect(found.refusals).toEqual([expect.stringMatching(/^line 3 is 120 characters, over the 100 nen holds the body to/)]);
  });

  it("finds a block that follows the header with no blank line, and never counts the header into it", () => {
    const found = lineLengthFindings(`fix: x\nRefs: ${TOKEN}\n \n`, code());
    expect(found.refusals).toEqual([]);
    expect(found.warnings).toEqual([expect.stringMatching(/^line 2 is 126 characters: 'footer-max-line-length' NOT checked/)]);
  });
});
