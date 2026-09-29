// src/commit/commitlint.test.ts -- finding the repository's own commitlint
// `subject-case` rule where commitlint finds it, and the one check both
// `commit` verbs run with it (part of zheref/nen#263).

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMITLINT_SEARCH_PLACES,
  CONFIG_CONVENTIONAL,
  CONVENTIONAL_SUBJECT_CASE,
  CommitlintConfigError,
  commitlintSubject,
  readSubjectCaseRule,
  subjectCaseFindings,
} from "./commitlint.js";

/**
 * A temp directory holding exactly these files -- and a `.git` entry, so it
 * reads as a checkout root, unless `checkoutRoot` is false (the
 * not-a-checkout-root warning is its own test).
 */
function repo(files: Record<string, string>, checkoutRoot = true): string {
  const root = mkdtempSync(join(tmpdir(), "nen-commitlint-"));
  if (checkoutRoot) mkdirSync(join(root, ".git"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text, "utf8");
  return root;
}

const conventional = JSON.stringify({ extends: [CONFIG_CONVENTIONAL] });
const explicit = (rule: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ ...extra, rules: { "subject-case": rule } });

function thrown(root: string): CommitlintConfigError {
  try {
    readSubjectCaseRule(root);
  } catch (error) {
    if (error instanceof CommitlintConfigError) return error;
    throw error;
  }
  throw new Error("expected a CommitlintConfigError");
}

describe("where the config is found -- commitlint's own search places, in its order", () => {
  it("finds nothing in a checkout root with no config, and the check then says nothing", () => {
    const root = repo({});
    expect(readSubjectCaseRule(root)).toEqual({ kind: "absent" });
    expect(subjectCaseFindings(root, "fix: Start the timer")).toEqual({ refusals: [], warnings: [] });
  });

  it("says 'NOT checked' when nothing is found in a directory with no .git entry -- commitlint would look in the parents", () => {
    const root = repo({}, false);
    expect(subjectCaseFindings(root, "fix: Start the timer")).toEqual({
      refusals: [],
      warnings: [`subject-case NOT checked: no commitlint config at ${root}, and commitlint also looks in parent directories -- pass --repo <checkout root>`],
    });
    // A .git FILE counts too -- that is what a worktree or a submodule has.
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n");
    expect(subjectCaseFindings(root, "fix: Start the timer")).toEqual({ refusals: [], warnings: [] });
    // And a config found there is read whatever the directory is.
    const found = repo({ ".commitlintrc.json": JSON.stringify({ extends: [CONFIG_CONVENTIONAL] }) }, false);
    expect(subjectCaseFindings(found, "fix: Start the timer").refusals).toHaveLength(1);
  });

  it("lists @commitlint/load 21.2.3's eighteen places, data first, package.json first of all", () => {
    expect(COMMITLINT_SEARCH_PLACES).toHaveLength(18);
    expect(COMMITLINT_SEARCH_PLACES.slice(0, 6)).toEqual(["package.json", "package.yaml", ".commitlintrc", ".commitlintrc.json", ".commitlintrc.yaml", ".commitlintrc.yml"]);
  });

  it("reads every data form: .json, .yaml, .yml, the extensionless rc as JSON or YAML, package.json and package.yaml", () => {
    const forms: Record<string, Record<string, string>> = {
      ".commitlintrc.json": { ".commitlintrc.json": conventional },
      ".commitlintrc.yaml": { ".commitlintrc.yaml": `extends:\n  - "${CONFIG_CONVENTIONAL}"\n` },
      ".commitlintrc.yml": { ".commitlintrc.yml": `extends: ['${CONFIG_CONVENTIONAL}']\n` },
      ".commitlintrc (JSON)": { ".commitlintrc": conventional },
      ".commitlintrc (YAML)": { ".commitlintrc": `extends: "${CONFIG_CONVENTIONAL}"\n` },
      "package.json": { "package.json": JSON.stringify({ name: "x", commitlint: { extends: CONFIG_CONVENTIONAL } }) },
      "package.yaml": { "package.yaml": `name: x\ncommitlint:\n  extends: ["${CONFIG_CONVENTIONAL}"]\n` },
    };
    for (const [form, files] of Object.entries(forms)) {
      const rule = readSubjectCaseRule(repo(files));
      expect(rule.kind, form).toBe("rule");
      if (rule.kind === "rule") expect(rule.origin, form).toBe("extends");
    }
  });

  it("takes the FIRST place that holds a config: package.json's 'commitlint' key beats .commitlintrc.json", () => {
    const root = repo({
      "package.json": JSON.stringify({ commitlint: { rules: { "subject-case": [2, "always", "upper-case"] } } }),
      ".commitlintrc.json": conventional,
    });
    const rule = readSubjectCaseRule(root);
    expect(rule).toMatchObject({ kind: "rule", file: join(root, "package.json"), origin: "rules", when: "always" });
  });

  it("steps past a package.json with no 'commitlint' key, a blank file, a null one and a directory, as cosmiconfig does", () => {
    const root = repo({
      "package.json": JSON.stringify({ name: "x" }),
      "package.yaml": "name: x\n",
      ".commitlintrc": "   \n",
      ".commitlintrc.yaml": "null\n",
      ".commitlintrc.yml": "# only a comment\n",
    });
    mkdirSync(join(root, ".commitlintrc.json"));
    writeFileSync(join(root, "commitlint.config.js"), "  \n");
    expect(readSubjectCaseRule(root)).toEqual({ kind: "absent" });
    writeFileSync(join(root, "commitlint.config.ts"), "export default {}\n");
    expect(readSubjectCaseRule(root)).toMatchObject({ kind: "unreadable", file: join(root, "commitlint.config.ts") });
  });

  it("never executes a JavaScript or TypeScript config -- every code extension is 'not checked', naming the file", () => {
    for (const place of COMMITLINT_SEARCH_PLACES.filter((name): boolean => /\.(?:js|cjs|mjs|ts|cts|mts)$/.test(name))) {
      // If nen ever evaluated this file, the throw would surface as a test error.
      const root = repo({ [place]: "throw new Error('nen executed the repository config');\n" });
      const rule = readSubjectCaseRule(root);
      expect(rule, place).toMatchObject({ kind: "unreadable", file: join(root, place) });
      if (rule.kind === "unreadable") expect(rule.reason).toMatch(/does not execute a repository's code/);
    }
  });

  it("prefers a data config that comes first in the order over a code config beside it", () => {
    const root = repo({ ".commitlintrc.json": conventional, "commitlint.config.js": "module.exports = {}\n" });
    expect(readSubjectCaseRule(root)).toMatchObject({ kind: "rule", file: join(root, ".commitlintrc.json") });
  });
});


describe("a package file is commitlint's only through a 'commitlint' key", () => {
  it("steps past a package file whose text has no 'commitlint' key WITHOUT parsing it -- an anchored package.yaml, a malformed package.json", () => {
    const anchored = repo({ "package.yaml": "defaults: &defaults\n  node: 20\nengines: *defaults\n" });
    expect(readSubjectCaseRule(anchored)).toEqual({ kind: "absent" });
    expect(subjectCaseFindings(anchored, "fix: Start the timer")).toEqual({ refusals: [], warnings: [] });
    const malformed = repo({ "package.json": '{ "name": "x", "devDependencies": { "@commitlint/cli": "^21" ' });
    expect(readSubjectCaseRule(malformed)).toEqual({ kind: "absent" });
    // ...and the search goes on past it, to the config that IS commitlint's.
    const beside = repo({ "package.json": "{ nope", ".commitlintrc.json": conventional });
    expect(readSubjectCaseRule(beside)).toMatchObject({ kind: "rule", file: join(beside, ".commitlintrc.json") });
  });

  it("makes a package file that carries the key but will not parse a 'NOT checked' warning, never exit 1", () => {
    for (const [place, text] of [
      ["package.json", '{ "commitlint": { "extends": ["@commitlint/config-conventional"] '],
      ["package.yaml", "base: &b\n  x: 1\ncommitlint:\n  extends: ['@commitlint/config-conventional']\nother: *b\n"],
    ] as const) {
      const root = repo({ [place]: text });
      const rule = readSubjectCaseRule(root);
      expect(rule, place).toMatchObject({ kind: "unreadable", file: join(root, place) });
      if (rule.kind === "unreadable") expect(rule.reason, place).toMatch(/carries a 'commitlint' key, but nen could not parse the file/);
      const found = subjectCaseFindings(root, "fix: Start the timer");
      expect(found.refusals).toEqual([]);
      expect(found.warnings).toEqual([expect.stringMatching(/^subject-case NOT checked: .*For reference only/)]);
    }
  });

  it("does not take a dependency name for the key, and parses a file whose nested key only looks like one", () => {
    const dependency = repo({ "package.json": JSON.stringify({ devDependencies: { "@commitlint/cli": "^21", "commitlint-plugin-x": "1" } }) });
    expect(readSubjectCaseRule(dependency)).toEqual({ kind: "absent" });
    const nested = repo({ "package.json": JSON.stringify({ scripts: { commitlint: "commitlint --edit" } }) });
    expect(readSubjectCaseRule(nested)).toEqual({ kind: "absent" });
  });
});

describe("which rule the config states -- explicit rules, then extends", () => {
  it("resolves @commitlint/config-conventional, as a string or in a list, to its published default and its parser", () => {
    for (const extended of [CONFIG_CONVENTIONAL, [CONFIG_CONVENTIONAL]]) {
      const root = repo({ ".commitlintrc.json": JSON.stringify({ extends: extended }) });
      expect(readSubjectCaseRule(root)).toEqual({ kind: "rule", file: join(root, ".commitlintrc.json"), origin: "extends", ...CONVENTIONAL_SUBJECT_CASE, grammar: "conventionalcommits" });
    }
    expect(CONVENTIONAL_SUBJECT_CASE.level).toBe(2);
    expect(CONVENTIONAL_SUBJECT_CASE.when).toBe("never");
    expect(CONVENTIONAL_SUBJECT_CASE.checks.map((check): string => check.case)).toEqual(["sentence-case", "start-case", "pascal-case", "upper-case"]);
  });

  it("lets an explicit rules['subject-case'] override what is extended -- including turning it off", () => {
    const off = repo({ ".commitlintrc.json": explicit([0], { extends: [CONFIG_CONVENTIONAL] }) });
    expect(readSubjectCaseRule(off)).toMatchObject({ kind: "rule", origin: "rules", level: 0 });
    expect(subjectCaseFindings(off, "fix: Start the timer")).toEqual({ refusals: [], warnings: [] });
    const lower = repo({ ".commitlintrc.json": explicit([2, "always", "lower-case"], { extends: [CONFIG_CONVENTIONAL, "@acme/commitlint-config"] }) });
    expect(readSubjectCaseRule(lower)).toMatchObject({ kind: "rule", origin: "rules", level: 2, when: "always", checks: [{ when: "always", case: "lower-case" }] });
  });

  it("states NO rule when nothing is extended and the rules do not name it -- commitlint checks nothing either", () => {
    const rulesOnly = repo({ ".commitlintrc.json": JSON.stringify({ rules: { "header-max-length": [2, "always", 72] } }) });
    expect(readSubjectCaseRule(rulesOnly)).toEqual({ kind: "none", file: join(rulesOnly, ".commitlintrc.json") });
    const empty = repo({ ".commitlintrc.json": JSON.stringify({ extends: [] }) });
    expect(readSubjectCaseRule(empty)).toEqual({ kind: "none", file: join(empty, ".commitlintrc.json") });
    expect(subjectCaseFindings(empty, "fix: Start the timer")).toEqual({ refusals: [], warnings: [] });
  });

  it("will not guess a preset it cannot read AFTER config-conventional -- it may set the rule, so 'not checked'", () => {
    const after = repo({ ".commitlintrc.json": JSON.stringify({ extends: [CONFIG_CONVENTIONAL, "@acme/commitlint-config"] }) });
    const rule = readSubjectCaseRule(after);
    expect(rule.kind).toBe("unreadable");
    if (rule.kind === "unreadable") expect(rule.reason).toMatch(/extends '@acme\/commitlint-config'.*Stating 'subject-case' under the file's own 'rules'/);
    expect(readSubjectCaseRule(repo({ ".commitlintrc.json": JSON.stringify({ extends: "./local-preset.js" }) })).kind).toBe("unreadable");
  });

  it("ignores a preset BEFORE config-conventional -- config-conventional sets the rule over it", () => {
    const before = repo({ ".commitlintrc.json": JSON.stringify({ extends: ["@acme/commitlint-config", CONFIG_CONVENTIONAL] }) });
    expect(readSubjectCaseRule(before)).toMatchObject({ kind: "rule", origin: "extends" });
  });

  it("does not follow cosmiconfig's $import -- 'not checked', said", () => {
    const rule = readSubjectCaseRule(repo({ ".commitlintrc.json": JSON.stringify({ $import: "./base.json", rules: { "subject-case": [2, "always", "lower-case"] } }) }));
    expect(rule.kind).toBe("unreadable");
    if (rule.kind === "unreadable") expect(rule.reason).toMatch(/\$import/);
  });

  it("normalizes the case list as commitlint does: a bare value, a list, object entries, an absent list", () => {
    const read = (rule: unknown): unknown => readSubjectCaseRule(repo({ ".commitlintrc.json": explicit(rule) }));
    expect(read([2, "always", "lower-case"])).toMatchObject({ checks: [{ when: "always", case: "lower-case" }] });
    expect(read([2, "always", { case: "upper-case", when: "never" }])).toMatchObject({ checks: [{ when: "never", case: "upper-case" }] });
    expect(read([1, "never", ["kebab-case", { case: "snake-case", when: "sometimes" }]])).toMatchObject({
      level: 1,
      checks: [
        { when: "always", case: "kebab-case" },
        { when: "always", case: "snake-case" },
      ],
    });
    expect(read([2, "always"])).toMatchObject({ checks: [] });
    // A disabled rule is never run, so a list commitlint could not evaluate does not matter.
    expect(read([0, "never", ["shouty-case"]])).toMatchObject({ level: 0, checks: [] });
  });

  it("reads the header with commitlint's DEFAULT parser only when nothing names another", () => {
    const grammar = (config: Record<string, unknown>): unknown => readSubjectCaseRule(repo({ ".commitlintrc.json": explicit([2, "never", "sentence-case"], config) }));
    expect(grammar({})).toMatchObject({ grammar: "default" });
    expect(grammar({ parserPreset: "conventional-changelog-conventionalcommits" })).toMatchObject({ grammar: "conventionalcommits" });
    expect(grammar({ extends: [CONFIG_CONVENTIONAL] })).toMatchObject({ grammar: "conventionalcommits" });
    // A preset extended beside the rule may supply a parserPreset, so the default is not assumed.
    expect(grammar({ extends: ["@acme/commitlint-config"] })).toMatchObject({ grammar: "conventionalcommits" });
  });
});

describe("the subject commitlint's parser finds -- recorded from commitlint 21.2.3 on the headers themselves", () => {
  it("splits a header as conventional-changelog-conventionalcommits and -angular do, greedy scope and all", () => {
    expect(commitlintSubject("feat(x)!: Foo bar", "conventionalcommits")).toBe("Foo bar");
    expect(commitlintSubject("fix(a): Foo (b): bar", "conventionalcommits")).toBe("bar");
    expect(commitlintSubject("fix: ", "conventionalcommits")).toBe("");
    expect(commitlintSubject("feat: Foo bar", "default")).toBe("Foo bar");
    expect(commitlintSubject("feat!: Foo bar", "default")).toBeNull();
    expect(commitlintSubject("feat(x)!: Foo bar", "default")).toBeNull();
    expect(commitlintSubject("fix(a): Foo (b): bar", "default")).toBe("bar");
  });

  it("judges the subject commitlint finds, not the one nen was handed: 'fix(a): Foo (b): bar' passes config-conventional", () => {
    const root = repo({ ".commitlintrc.json": conventional });
    expect(subjectCaseFindings(root, "fix(a): Foo (b): bar")).toEqual({ refusals: [], warnings: [] });
    expect(subjectCaseFindings(root, "fix(a): foo (b): Bar").refusals[0]).toContain("subject 'Bar' breaks");
    expect(subjectCaseFindings(root, "feat(x)!: Foo bar").refusals[0]).toContain("subject 'Foo bar' breaks");
  });

  it("gives a '!' header no verdict under a rules-only config -- commitlint's default parser cannot split it -- and says so", () => {
    const root = repo({ ".commitlintrc.json": explicit([2, "never", ["sentence-case"]]) });
    for (const header of ["feat!: Foo bar", "feat(x)!: Foo bar"]) {
      const found = subjectCaseFindings(root, header);
      expect(found.refusals, header).toEqual([]);
      expect(found.warnings, header).toEqual([expect.stringMatching(/^subject-case NOT checked: .*names no parserPreset and extends no preset.*default parser \(conventional-changelog-angular's\).*no '!' form/)]);
    }
    expect(subjectCaseFindings(root, "feat: Foo bar").refusals).toHaveLength(1);
    const named = repo({ ".commitlintrc.json": explicit([2, "never", ["sentence-case"]], { parserPreset: "conventional-changelog-conventionalcommits" }) });
    expect(subjectCaseFindings(named, "feat!: Foo bar").refusals).toHaveLength(1);
  });
});

describe("a config nen cannot read the rule from is a CommitlintConfigError, naming the file and the fault", () => {
  const cases: Record<string, readonly [Record<string, string>, string, RegExp]> = {
    "invalid JSON": [{ ".commitlintrc.json": '{ "extends": [' }, ".commitlintrc.json", /not valid JSON/],
    "YAML nen's strict reader refuses": [{ ".commitlintrc.yaml": "base: &b\n  x: 1\nrules: *b\n" }, ".commitlintrc.yaml", /YAML reader refused it/],
    "an extensionless rc that is neither JSON nor YAML": [{ ".commitlintrc": "rules: [unclosed\n" }, ".commitlintrc", /YAML reader refused it/],
    "a config that is not an object": [{ ".commitlintrc.json": '["@commitlint/config-conventional"]' }, ".commitlintrc.json", /a commitlint config is an object/],
    "a package.json 'commitlint' key that parses into no object": [{ "package.json": JSON.stringify({ commitlint: "conventional" }) }, "package.json", /a commitlint config is an object/],
    "rules that are not an object": [{ ".commitlintrc.json": JSON.stringify({ rules: ["subject-case"] }) }, ".commitlintrc.json", /'rules' must be an object/],
    "extends that is not a string or strings": [{ ".commitlintrc.json": JSON.stringify({ extends: [1] }) }, ".commitlintrc.json", /'extends' must be a string or a list of strings/],
    "a rule that is not an array": [{ ".commitlintrc.json": explicit("never") }, ".commitlintrc.json", /must be an array/],
    "a non-numeric level": [{ ".commitlintrc.json": explicit(["2", "never"]) }, ".commitlintrc.json", /a level of 0, 1 or 2/],
    "a rule of the wrong length": [{ ".commitlintrc.json": explicit([2]) }, ".commitlintrc.json", /2 or 3 items long/],
    "a rule too long": [{ ".commitlintrc.json": explicit([2, "never", "lower-case", "extra"]) }, ".commitlintrc.json", /2 or 3 items long/],
    "a level out of range": [{ ".commitlintrc.json": explicit([3, "never", "lower-case"]) }, ".commitlintrc.json", /a level of 0, 1 or 2/],
    // config-validator's schema admits exactly 0, 1 and 2 -- 1.5 fails commitlint's load.
    "a fractional level": [{ ".commitlintrc.json": explicit([1.5, "never", "sentence-case"]) }, ".commitlintrc.json", /a level of 0, 1 or 2/],
    "a disabled rule whose condition is still invalid": [{ ".commitlintrc.json": explicit([0, "sometimes"]) }, ".commitlintrc.json", /'always' or 'never'/],
    "a condition that is neither always nor never": [{ ".commitlintrc.json": explicit([2, "sometimes", "lower-case"]) }, ".commitlintrc.json", /'always' or 'never'/],
    "a case commitlint does not know": [{ ".commitlintrc.json": explicit([2, "never", ["shouty-case"]]) }, ".commitlintrc.json", /not a case commitlint knows.*Unknown target case/],
    "an object entry with no case": [{ ".commitlintrc.json": explicit([2, "never", [{ when: "never" }]]) }, ".commitlintrc.json", /not a case commitlint knows/],
  };
  for (const [name, [files, file, fault]] of Object.entries(cases)) {
    it(`refuses ${name}`, () => {
      const root = repo(files);
      const error = thrown(root);
      expect(error.file).toBe(join(root, file));
      expect(error.message).toContain(`${join(root, file)} could not be read for its commitlint 'subject-case' rule`);
      expect(error.message).toMatch(fault);
      // subjectCaseFindings is the verbs' door, and it does not swallow it.
      expect(() => subjectCaseFindings(root, "fix: start the timer")).toThrow(CommitlintConfigError);
    });
  }
});

describe("subjectCaseFindings -- the one check both commit verbs run", () => {
  it("refuses the issue's own subjects under config-conventional, naming the rule, the file and the fix", () => {
    const root = repo({ ".commitlintrc.json": conventional });
    for (const subject of ["Start the timer", "Escape key closes the modal"]) {
      const found = subjectCaseFindings(root, `fix(ui): ${subject}`);
      expect(found.warnings).toEqual([]);
      expect(found.refusals).toHaveLength(1);
      const [line] = found.refusals;
      expect(line).toContain(`subject '${subject}'`);
      expect(line).toContain(`${CONFIG_CONVENTIONAL}'s default, which ${join(root, ".commitlintrc.json")} extends`);
      expect(line).toContain("subject must not be sentence-case");
      expect(line).toMatch(/start the subject with a lower-case word/);
      expect(line).toMatch(/inside `backticks`/);
    }
  });

  it("passes a lower-case subject, a backticked proper name, and a digit-leading one", () => {
    const root = repo({ ".commitlintrc.json": conventional });
    for (const subject of ["start the timer", "`Escape` key closes the modal", "2fa for admins"]) {
      expect(subjectCaseFindings(root, `fix: ${subject}`), subject).toEqual({ refusals: [], warnings: [] });
    }
  });

  it("makes a level-1 break a warning, and says commitlint still commits unless --strict", () => {
    const root = repo({ ".commitlintrc.json": explicit([1, "never", ["sentence-case"]]) });
    const found = subjectCaseFindings(root, "fix: Start the timer");
    expect(found.refusals).toEqual([]);
    expect(found.warnings).toHaveLength(1);
    expect(found.warnings[0]).toMatch(/set under 'rules' in .*\.commitlintrc\.json.*level 1.*--strict/);
  });

  it("words the fix for the rule actually broken: 'not <case>' for never, 'to <case>' for always", () => {
    const never = repo({ ".commitlintrc.json": explicit([2, "never", "lower-case"]) });
    expect(subjectCaseFindings(never, "fix: start the timer").refusals[0]).toMatch(/recase the subject so it is not lower-case/);
    const always = repo({ ".commitlintrc.json": explicit([2, "always", "lower-case"]) });
    expect(subjectCaseFindings(always, "fix: Start the timer").refusals[0]).toMatch(/recase the subject to lower-case --/);
    const either = repo({ ".commitlintrc.json": explicit([2, "always", ["kebab-case", "snake-case"]]) });
    expect(subjectCaseFindings(either, "fix: Start the timer").refusals[0]).toMatch(/recase the subject to one of kebab-case, snake-case/);
  });

  it("says 'NOT checked' for a code config -- that commitlint still refuses AFTER the commit -- with config-conventional's verdict only as a labelled reference", () => {
    const root = repo({ "commitlint.config.cjs": "module.exports = { extends: ['@commitlint/config-conventional'] }\n" });
    const refused = subjectCaseFindings(root, "fix: Escape closes it");
    expect(refused.refusals).toEqual([]);
    expect(refused.warnings).toHaveLength(1);
    expect(refused.warnings[0]).toMatch(/^subject-case NOT checked: .*commitlint\.config\.cjs is a JavaScript\/TypeScript commitlint config/);
    expect(refused.warnings[0]).toMatch(/when the commit is made, after the commit exists\./);
    expect(refused.warnings[0]).toMatch(/For reference only: .*would be refused \(subject must not be sentence-case\)/);
    const fine = subjectCaseFindings(root, "fix: start the timer");
    expect(fine.warnings).toHaveLength(1);
    expect(fine.warnings[0]).toMatch(/NOT checked/);
    expect(fine.warnings[0]).not.toMatch(/For reference/);
  });

  it("adds no reference line when the rule nen could not read is an unresolved preset and the subject is fine", () => {
    const root = repo({ ".commitlintrc.json": JSON.stringify({ extends: ["@acme/commitlint-config"] }) });
    const found = subjectCaseFindings(root, "feat: add a thing");
    expect(found.refusals).toEqual([]);
    expect(found.warnings).toEqual([expect.stringMatching(/^subject-case NOT checked: .*extends '@acme\/commitlint-config'/)]);
  });
});
