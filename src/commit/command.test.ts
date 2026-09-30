import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { commitCommand } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";

async function capture(
  argv: readonly string[],
  json = false,
  repoFlag: string | null = null,
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const seams: Seams = {
    run: (): CommandResult => {
      throw new Error("commit format makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("this verb has no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("this verb has no watched form");
    },
    platform: "linux",
  };
  const code = await runFamily(commitCommand, argv, repoFlag, json, io, seams);
  return { code, out, err };
}

/** A repository whose `nen/workflow.json` says exactly this. */
function repoWithPolicy(commits: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "nen-commit-policy-"));
  mkdirSync(join(root, "nen"), { recursive: true });
  writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ commits }));
  return root;
}

describe("nen commit write -- there is no --sign-off, and the refusal says where the trailer goes (zheref/nen#231)", () => {
  it("refuses --sign-off as unknown at exit 2, naming the --trailer alternative", async () => {
    const result = await capture(["commit", "write", "--repo", ".", "--message-file", "m.txt", "--sign-off"]);
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/unknown option '--sign-off'/);
    expect(err).toMatch(/there is no --sign-off .*'Signed-off-by' is an attribution-shaped trailer .* pass it as --trailer "Signed-off-by: Name <email>"/);
    // The hint is for that spelling alone: another unknown flag gets none.
    const other = await capture(["commit", "write", "--repo", ".", "--message-file", "m.txt", "--signoff"]);
    expect(other.code).toBe(2);
    expect(other.err.join("\n")).not.toMatch(/there is no --sign-off/);
  });
});

describe("nen commit format -- CLI wiring", () => {
  it("prints the formatted message", async () => {
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "stop dropping the last row"]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["fix: stop dropping the last row"]);
  });

  it("passes --scope, --body and --trailer through", async () => {
    const result = await capture([
      "commit",
      "format",
      "--type",
      "feat",
      "--scope",
      "cli",
      "--subject",
      "add a verb",
      "--body",
      "why",
      "--trailer",
      "Closes=#4",
    ]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toBe("feat(cli): add a verb\n\nwhy\n\nCloses: #4");
  });

  it("exits 2 on a shape violation, printing every refusal", async () => {
    const result = await capture(["commit", "format", "--type", "bogus", "--subject", ""]);
    expect(result.code).toBe(2);
    expect(result.err.length).toBeGreaterThan(0);
  });

  it("requires --type and --subject", async () => {
    expect((await capture(["commit", "format", "--type", "feat"])).code).toBe(2);
    expect((await capture(["commit", "format", "--subject", "x"])).code).toBe(2);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["commit", "bogus"])).code).toBe(2);
  });
});

// ── the trailer policy, when the repository states one ──────────────────────

describe("nen commit format -- nen/workflow.json's attribution-trailer policy", () => {
  it("changes NOTHING when the repository has no policy file", async () => {
    // The default surface is "shape, never content". A guard that fired
    // without the repository asking for it would be this verb deciding
    // somebody's commit convention for them.
    const empty = mkdtempSync(join(tmpdir(), "nen-commit-nopolicy-"));
    const result = await capture(
      ["commit", "format", "--type", "fix", "--subject", "x", "--trailer", "Co-Authored-By=A <a@b>"],
      false,
      empty,
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("Co-Authored-By: A <a@b>");
  });

  it("refuses an attribution trailer the policy does not admit, naming it AND the file", async () => {
    const root = repoWithPolicy({ allowedAttributionTrailers: ["X-Agent"] });
    const result = await capture(
      ["commit", "format", "--type", "fix", "--subject", "x", "--trailer", "Co-Authored-By=A"],
      false,
      root,
    );
    expect(result.code).toBe(2);
    const message = result.err.join("\n");
    expect(message).toContain("'Co-Authored-By'");
    expect(message).toContain(join(root, "nen", "workflow.json"));
    expect(message).toContain("commits.allowedAttributionTrailers");
    // Nothing was printed on stdout: a refused message is not half-formatted.
    expect(result.out).toEqual([]);
  });

  it("admits a trailer the policy lists, in any spelling of its case", async () => {
    const root = repoWithPolicy({ allowedAttributionTrailers: ["Co-Authored-By"] });
    const result = await capture(
      ["commit", "format", "--type", "fix", "--subject", "x", "--trailer", "co-authored-by=A"],
      false,
      root,
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("co-authored-by: A");
  });

  it("refuses a lower-cased attribution trailer too -- every reader of the commit ignores case", async () => {
    const root = repoWithPolicy({ allowedAttributionTrailers: [] });
    expect(
      (
        await capture(
          ["commit", "format", "--type", "fix", "--subject", "x", "--trailer", "co-authored-by=A"],
          false,
          root,
        )
      ).code,
    ).toBe(2);
  });

  it("refuses a key the policy's own forbiddenTrailers adds, which nen has never heard of", async () => {
    const root = repoWithPolicy({ forbiddenTrailers: ["Written-By-A-Robot"] });
    const result = await capture(
      ["commit", "format", "--type", "fix", "--subject", "x", "--trailer", "Written-By-A-Robot=yes"],
      false,
      root,
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("'Written-By-A-Robot'");
  });

  it("leaves an ordinary trailer alone -- 'Closes' is not attribution-shaped", async () => {
    const root = repoWithPolicy({ allowedAttributionTrailers: [] });
    const result = await capture(
      ["commit", "format", "--type", "fix", "--subject", "x", "--trailer", "Closes=#4"],
      false,
      root,
    );
    expect(result.code).toBe(0);
  });

  it("names EVERY refused trailer in one pass, not just the first", async () => {
    const root = repoWithPolicy({ allowedAttributionTrailers: [] });
    const result = await capture(
      [
        "commit",
        "format",
        "--type",
        "fix",
        "--subject",
        "x",
        "--trailer",
        "Co-Authored-By=A,Claude-Session=1",
      ],
      false,
      root,
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("'Co-Authored-By'");
    expect(result.err.join("\n")).toContain("'Claude-Session'");
  });

  it("reports a SHAPE violation and a policy refusal together", async () => {
    const root = repoWithPolicy({ allowedAttributionTrailers: [] });
    const result = await capture(
      [
        "commit",
        "format",
        "--type",
        "fix",
        "--subject",
        "a subject long enough to blow well past the seventy-two character convention line",
        "--trailer",
        "Co-Authored-By=A",
      ],
      false,
      root,
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/72-character convention/);
    expect(result.err.join("\n")).toContain("'Co-Authored-By'");
  });

  it("reads the policy on EVERY run now, trailer or not: commits.subjectCase can refuse any subject (zheref/nen#263)", async () => {
    // No message is one that could not have violated the policy any more, so a
    // malformed file is exit 1 without a --trailer too -- nen will not shape a
    // message under a policy it could not read.
    const root = repoWithPolicy({ allowedAttributionTrailers: [] });
    writeFileSync(join(root, "nen", "workflow.json"), "{ not json");
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "x"], false, root);
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/states the commit policy -- which attribution trailers a commit may carry, commits\.subjectCase and commits\.bodyMaxLineLength -- and nen will not shape a message under a policy it could not read/);
  });

  it("exits 1, not 2, on a MALFORMED policy -- the invocation was correct", async () => {
    const root = repoWithPolicy({ allowedAttributionTrailers: [] });
    writeFileSync(join(root, "nen", "workflow.json"), '{"coverage":{"minimum":95,"ideal":10}}');
    const result = await capture(
      ["commit", "format", "--type", "fix", "--subject", "x", "--trailer", "Closes=#4"],
      false,
      root,
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("does not ascend");
    expect(result.err.join("\n")).toContain("schema check");
  });
});

// ── the repository's own commitlint subject-case rule (zheref/nen#263)

/** A checkout root (it has a `.git` entry) holding exactly these commitlint files, and optionally a trailer policy. */
function repoWithCommitlint(files: Record<string, string>, commits?: unknown): string {
  const root = commits === undefined ? mkdtempSync(join(tmpdir(), "nen-commit-commitlint-")) : repoWithPolicy(commits);
  mkdirSync(join(root, ".git"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

const CONVENTIONAL_RC = { ".commitlintrc.json": JSON.stringify({ extends: ["@commitlint/config-conventional"] }) };

describe("nen commit format -- the repository's commitlint subject-case rule (zheref/nen#263)", () => {
  it("refuses the issue's own subjects at exit 2, before any message is printed, with commitlint's verdict", async () => {
    const root = repoWithCommitlint(CONVENTIONAL_RC);
    for (const subject of ["Start the timer", "Escape key closes the modal"]) {
      const result = await capture(["commit", "format", "--type", "fix", "--subject", subject], false, root);
      expect(result.code, subject).toBe(2);
      expect(result.out).toEqual([]);
      const err = result.err.join("\n");
      expect(err).toContain(`nen: subject '${subject}' breaks this repository's commitlint rule 'subject-case'`);
      expect(err).toContain("subject must not be sentence-case");
      expect(err).toContain(join(root, ".commitlintrc.json"));
    }
  });

  it("formats the lower-case subject exactly as before, and a backticked proper name too", async () => {
    const root = repoWithCommitlint(CONVENTIONAL_RC);
    const lower = await capture(["commit", "format", "--type", "fix", "--subject", "start the timer"], false, root);
    expect(lower).toMatchObject({ code: 0, out: ["fix: start the timer"], err: [] });
    const quoted = await capture(["commit", "format", "--type", "fix", "--subject", "`Escape` key closes the modal"], false, root);
    expect(quoted).toMatchObject({ code: 0, out: ["fix: `Escape` key closes the modal"], err: [] });
  });

  it("judges the subject the header will carry -- trimmed -- as commitlint's parser would see it", async () => {
    const root = repoWithCommitlint(CONVENTIONAL_RC);
    expect((await capture(["commit", "format", "--type", "fix", "--subject", "  Start the timer  "], false, root)).code).toBe(2);
  });

  it("changes NOTHING in a checkout root with no commitlint config", async () => {
    const root = repoWithCommitlint({});
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "Start the timer"], false, root);
    expect(result).toMatchObject({ code: 0, out: ["fix: Start the timer"], err: [] });
  });

  it("warns, at exit 0, when it finds no config in a directory that is not a checkout root -- commitlint would look in the parents", async () => {
    const checkout = repoWithCommitlint(CONVENTIONAL_RC);
    const subdirectory = join(checkout, "packages", "web");
    mkdirSync(subdirectory, { recursive: true });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "Start the timer"], false, subdirectory);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["fix: Start the timer"]);
    expect(result.err).toEqual([
      `nen: warning: subject-case NOT checked: no commitlint config at ${subdirectory}, and commitlint also looks in parent directories -- pass --repo <checkout root>`,
    ]);
    // Pointed at the checkout root, as the warning says, the rule is found and applied.
    expect((await capture(["commit", "format", "--type", "fix", "--subject", "Start the timer"], false, checkout)).code).toBe(2);
  });

  it("is not stopped by a package manifest in a repository with no commitlint (M1): no key, no parse, no warning", async () => {
    const anchored = repoWithCommitlint({ "package.yaml": "defaults: &defaults\n  node: 20\nengines: *defaults\n" });
    expect(await capture(["commit", "format", "--type", "fix", "--subject", "start the timer"], false, anchored)).toMatchObject({ code: 0, out: ["fix: start the timer"], err: [] });
    const malformed = repoWithCommitlint({ "package.json": '{ "name": "x", ' });
    expect(await capture(["commit", "format", "--type", "fix", "--subject", "start the timer"], false, malformed)).toMatchObject({ code: 0, out: ["fix: start the timer"], err: [] });
  });

  it("makes a package.json that carries the 'commitlint' key but will not parse a warning at exit 0, not a failure", async () => {
    const root = repoWithCommitlint({ "package.json": '{ "commitlint": { "extends": ["@commitlint/config-conventional"] ' });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "Start the timer"], false, root);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["fix: Start the timer"]);
    expect(result.err).toEqual([expect.stringMatching(/^nen: warning: subject-case NOT checked: .*package\.json carries a 'commitlint' key, but nen could not parse the file/)]);
  });

  it("judges the subject commitlint's parser finds in the header -- a '!' header under a rules-only config gets no verdict, said", async () => {
    const rulesOnly = repoWithCommitlint({ ".commitlintrc.json": JSON.stringify({ rules: { "subject-case": [2, "never", ["sentence-case"]] } }) });
    const bang = await capture(["commit", "format", "--type", "feat", "--breaking", "--subject", "Foo bar"], false, rulesOnly);
    expect(bang.code).toBe(0);
    expect(bang.out).toEqual(["feat!: Foo bar"]);
    expect(bang.err).toEqual([expect.stringMatching(/^nen: warning: subject-case NOT checked: .*default parser.*'feat!: Foo bar'/)]);
    expect((await capture(["commit", "format", "--type", "feat", "--subject", "Foo bar"], false, rulesOnly)).code).toBe(2);
    // Under config-conventional's parser the same '!' header IS judged.
    expect((await capture(["commit", "format", "--type", "feat", "--breaking", "--subject", "Foo bar"], false, repoWithCommitlint(CONVENTIONAL_RC))).code).toBe(2);
  });

  it("names a subject-case refusal together with a shape violation and a refused trailer -- one pass, three problems", async () => {
    const root = repoWithCommitlint(CONVENTIONAL_RC, { allowedAttributionTrailers: [] });
    const result = await capture(
      ["commit", "format", "--type", "bogus", "--subject", "Start the timer", "--trailer", "Co-Authored-By=A"],
      false,
      root,
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/not one of/);
    expect(err).toContain("'Co-Authored-By'");
    expect(err).toContain("subject must not be sentence-case");
  });

  it("makes a level-1 rule a warning line and still prints the message at exit 0", async () => {
    const root = repoWithCommitlint({ ".commitlintrc.json": JSON.stringify({ rules: { "subject-case": [1, "always", "lower-case"] } }) });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "Start the timer"], false, root);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["fix: Start the timer"]);
    expect(result.err).toEqual([expect.stringMatching(/^nen: warning: subject 'Start the timer' breaks .*subject must be lower-case.*level 1/)]);
  });

  it("does NOT protect a code config's repository: 'Escape closes it' exits 0 under a warning, and commitlint refuses it later", async () => {
    // The limit this effort leaves, pinned so nobody reads the verb as covering it.
    const root = repoWithCommitlint({ "commitlint.config.cjs": "module.exports = { extends: ['@commitlint/config-conventional'] }\n" });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "Escape closes it"], false, root);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["fix: Escape closes it"]);
    expect(result.err.join("\n")).toMatch(/NOT checked: .*after the commit exists\. For reference only: .*would be refused \(subject must not be sentence-case\)/);
  });

  it("never executes a JavaScript config: a 'NOT checked' warning naming the file, exit 0, and --json keeps its one key", async () => {
    const root = repoWithCommitlint({ "commitlint.config.cjs": "throw new Error('nen executed the repository config');\n" });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "Start the timer"], true, root);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({ message: "fix: Start the timer" });
    const err = result.err.join("\n");
    expect(err).toMatch(/^nen: warning: subject-case NOT checked: /);
    expect(err).toContain(join(root, "commitlint.config.cjs"));
    expect(err).toMatch(/For reference only: .*subject must not be sentence-case/);
  });

  it("exits 1, not 2, on a .commitlintrc it cannot read -- naming the file and the fault, and claiming nothing more", async () => {
    const root = repoWithCommitlint({ ".commitlintrc.json": '{ "extends": [' });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "start the timer"], false, root);
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err).toEqual([
      expect.stringMatching(
        new RegExp(`^nen: ${join(root, ".commitlintrc.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} could not be read for its commitlint 'subject-case' rule: it is not valid JSON .*nen will not call a subject well-formed under a subject-case rule it could not read: fix the file, then run this again\\.$`),
      ),
    ]);
  });

  it("reports a malformed trailer policy AND a malformed commitlint config together, at exit 1", async () => {
    const root = repoWithCommitlint({ ".commitlintrc.json": JSON.stringify({ rules: { "subject-case": [2] } }) }, { allowedAttributionTrailers: [] });
    writeFileSync(join(root, "nen", "workflow.json"), '{"coverage":{"minimum":95,"ideal":10}}');
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--trailer", "Closes=#4"], false, root);
    expect(result.code).toBe(1);
    const err = result.err.join("\n");
    expect(err).toContain("does not ascend");
    expect(err).toContain("2 or 3 items long");
  });

  it("refuses an --repo that does not exist at exit 2, even with no --trailer -- the config is read on every run now", async () => {
    const missing = join(tmpdir(), "nen-commit-no-such-repo", "nowhere");
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "x"], false, missing);
    expect(result.code).toBe(2);
  });
});

describe("nen commit format -- commits.subjectCase in nen/workflow.json, the rule declared as data (zheref/nen#263)", () => {
  const KRO_PWA = { "commitlint.config.cjs": "module.exports = { extends: ['@commitlint/config-conventional'] }\n" };

  it("refuses 'Escape closes it' at exit 2 in a kro-pwa-shaped repo that declares 'config-conventional'", async () => {
    const root = repoWithCommitlint(KRO_PWA, { subjectCase: "config-conventional" });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "Escape closes it"], false, root);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err).toEqual([
      expect.stringMatching(
        /^nen: subject 'Escape closes it' breaks the subject-case rule this repository declares \(commits\.subjectCase in .*nen\/workflow\.json, 'config-conventional'.*nen applies it because .*commitlint\.config\.cjs is a JavaScript\/TypeScript commitlint config nen does not execute\): subject must not be sentence-case\./,
      ),
    ]);
  });

  it("warns at exit 0 in the SAME repo without the key -- only the declaration binds", async () => {
    const root = repoWithCommitlint(KRO_PWA);
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "Escape closes it"], false, root);
    expect(result.code).toBe(0);
    expect(result.err).toEqual([expect.stringMatching(/^nen: warning: subject-case NOT checked: .*commits\.subjectCase/)]);
  });

  it("prints the message and a note naming nen/workflow.json when the subject passes the declared rule", async () => {
    const root = repoWithCommitlint(KRO_PWA, { subjectCase: "config-conventional" });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "escape closes it"], true, root);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({ message: "fix: escape closes it" });
    expect(result.err).toEqual([expect.stringMatching(/^nen: note: subject-case checked against commits\.subjectCase in .*nen\/workflow\.json/)]);
  });

  it("applies an explicit tuple: [2, 'always', 'lower-case'] refuses a capitalized subject", async () => {
    const root = repoWithCommitlint(KRO_PWA, { subjectCase: [2, "always", "lower-case"] });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "Start the timer"], false, root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/the rule \[2,"always",\["lower-case"\]\].*subject must be lower-case/);
  });

  it("lets a readable data commitlint config win over the declaration, and says the declaration was not applied", async () => {
    const root = repoWithCommitlint(CONVENTIONAL_RC, { subjectCase: [2, "always", "upper-case"] });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "start the timer"], false, root);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["fix: start the timer"]);
    expect(result.err).toEqual([
      expect.stringMatching(/^nen: note: commits\.subjectCase in .*nen\/workflow\.json is not applied, and it DIFFERS: .*\.commitlintrc\.json states .*, the declaration states \[2,"always",\["upper-case"\]\]; nen follows .*\.commitlintrc\.json, which is what commitlint runs/),
    ]);
    // An agreeing declaration is only redundant, and says so.
    const agreeing = repoWithCommitlint(CONVENTIONAL_RC, { subjectCase: "config-conventional" });
    const same = await capture(["commit", "format", "--type", "fix", "--subject", "start the timer"], false, agreeing);
    expect(same.code).toBe(0);
    expect(same.err).toEqual([expect.stringMatching(/^nen: note: .* is not applied: .*The declaration agrees with it: redundant here/)]);
  });

  it("applies where there is no commitlint config at all", async () => {
    const root = repoWithCommitlint({}, { subjectCase: "config-conventional" });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "Start the timer"], false, root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("because no commitlint config was found at");
  });

  it.each([
    ["conventional", "commits.subjectCase"],
    [[3, "never", "lower-case"], "commits.subjectCase[0]"],
    [[2, "never", ["shouty-case"]], "commits.subjectCase[2][0]"],
  ])("refuses a malformed commits.subjectCase %j at exit 1, by pointer %s", async (subjectCase, pointer) => {
    const root = repoWithCommitlint(KRO_PWA, { subjectCase });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "start the timer"], false, root);
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toContain(pointer);
  });

  it("leaves a repository with no key and no commitlint config unchanged", async () => {
    const root = repoWithCommitlint({}, { allowedAttributionTrailers: [] });
    expect(await capture(["commit", "format", "--type", "fix", "--subject", "Start the timer"], false, root)).toMatchObject({ code: 0, out: ["fix: Start the timer"], err: [] });
  });
});

describe("nen commit format -- declared-rule outcomes at the verb: exit code and line prefix (zheref/nen#263)", () => {
  const KRO_PWA = { "commitlint.config.cjs": "module.exports = { extends: ['@commitlint/config-conventional'] }\n" };
  it.each([
    ["no commitlint config + 'config-conventional'", {}, "config-conventional", 2, /^nen: subject 'Start the timer' breaks the subject-case rule this repository declares.*because no commitlint config was found/, false],
    ["an unresolved preset + 'config-conventional'", { ".commitlintrc.json": JSON.stringify({ extends: ["@acme/commitlint-config"] }) }, "config-conventional", 2, /^nen: subject 'Start the timer' breaks .*extends '@acme\/commitlint-config', which nen cannot resolve/, false],
    ["a code config + a level-1 declaration", KRO_PWA, [1, "never", ["sentence-case"]], 0, /^nen: warning: subject 'Start the timer' breaks the subject-case rule this repository declares.*declared at level 1, so nen only warns/, true],
    ["a code config + a level-0 declaration", KRO_PWA, [0], 0, /^nen: note: subject-case is off: commits\.subjectCase in .*the rule \[0\] disables it/, true],
  ] as const)("%s", async (_name, files, subjectCase, code, line, printed) => {
    const root = repoWithCommitlint(files, { subjectCase });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "Start the timer"], false, root);
    expect(result.code).toBe(code);
    expect(result.err).toEqual([expect.stringMatching(line)]);
    expect(result.out).toEqual(printed ? ["fix: Start the timer"] : []);
  });

  it("names a malformed nen/workflow.json first and the message's own shape fault after it, at exit 1", async () => {
    const root = repoWithCommitlint({}, { allowedAttributionTrailers: [] });
    writeFileSync(join(root, "nen", "workflow.json"), "{ not json");
    const result = await capture(["commit", "format", "--type", "bogus", "--subject", "start the timer"], false, root);
    expect(result.code).toBe(1);
    expect(result.err[0]).toMatch(/nen\/workflow\.json.*nen will not shape a message under a policy it could not read/);
    expect(result.err.slice(1)).toEqual([expect.stringMatching(/^nen: type 'bogus' is not one of/)]);
  });
});

// ── the body's line length: commitlint's body-/footer-max-line-length (zheref/nen#290)

describe("nen commit format -- --body wrapped to the width commitlint holds it to (zheref/nen#290)", () => {
  /** zheref/kro-pwa's shape: a code config extending config-conventional, with its own header rule. */
  const KRO_PWA = {
    "commitlint.config.cjs":
      "module.exports = { extends: ['@commitlint/config-conventional'], rules: { 'header-max-length': [2, 'always', 72] } }\nthrow new Error('nen executed the repository config')\n",
  };
  /** A sentence of 144 characters -- the issue's shape: one --body line past config-conventional's 100. */
  const SENTENCE =
    "This rebuilds the capture prompt so that endeavor pills are rendered inline and the pane-hosted Inbox triage keeps its selection across reloads.";
  /** A 75-character header: `feat(capture): ` (15) and a 60-character subject. */
  const SUBJECT_75 = "rebuild the capture prompt and pane-hosted inbox triage flow";
  const lengths = (out: readonly string[]): number[] => out.join("\n").split("\n").map((line) => line.length);

  it("fixture: the two inputs are the ones the issue names -- a 144-character sentence and a 75-character header", () => {
    expect(SENTENCE.length).toBe(144);
    expect(`feat(capture): ${SUBJECT_75}`.length).toBe(75);
  });

  it("wraps a --body line over config-conventional's 100 at spaces, notes it, and exits 0 (AC1)", async () => {
    const root = repoWithCommitlint(CONVENTIONAL_RC);
    const result = await capture(["commit", "format", "--type", "fix", "--scope", "capture", "--subject", "rebuild the prompt", "--body", SENTENCE], false, root);
    expect(result.code).toBe(0);
    const message = result.out.join("\n");
    expect(message).toBe(
      "fix(capture): rebuild the prompt\n\nThis rebuilds the capture prompt so that endeavor pills are rendered inline and the pane-hosted\nInbox triage keeps its selection across reloads.",
    );
    expect(Math.max(...lengths(result.out))).toBeLessThanOrEqual(100);
    // Never inside a word: the words are the caller's, in order.
    expect(message.split("\n").slice(2).join(" ")).toBe(SENTENCE);
    expect(result.err).toEqual([
      expect.stringMatching(
        /^nen: note: --body rewrapped: its line 1 \(144 characters\) was over the 100 characters this repository's commitlint rule 'body-max-line-length' allows \(@commitlint\/config-conventional's default, which .*\.commitlintrc\.json extends\), so nen broke it at spaces, never inside a word$/,
      ),
    ]);
  });

  it("refuses at exit 2 a line the wrap cannot shorten under a readable level-2 rule, naming the line (AC1)", async () => {
    const root = repoWithCommitlint(CONVENTIONAL_RC);
    const token = `src/${"deeply/nested/".repeat(8)}module.ts`;
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "move the module", "--body", `It moved to ${token} today.`], false, root);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    const err = result.err.join("\n");
    expect(err).toMatch(new RegExp(`^nen: line 4 is ${token.length} characters, over the 100 that this repository's commitlint rule 'body-max-line-length' allows`, "m"));
    expect(err).toMatch(/it holds a word longer than 100 characters, which nen never splits -- shorten it/);
  });

  it("still names a header over 72 characters before any git commit -- a 75-character header is refused at exit 2 (AC2)", async () => {
    for (const root of [repoWithCommitlint({}), repoWithCommitlint(CONVENTIONAL_RC), repoWithCommitlint(KRO_PWA)]) {
      const result = await capture(["commit", "format", "--type", "feat", "--scope", "capture", "--subject", SUBJECT_75], false, root);
      expect(result.code).toBe(2);
      expect(result.out).toEqual([]);
      expect(result.err.join("\n")).toContain(`nen: header line is 75 characters, over the 72-character convention: 'feat(capture): ${SUBJECT_75}'`);
    }
  });

  it("fixture: a 75-character header and a 144-character body sentence -- the verb's own output names BOTH, in one run (AC3)", async () => {
    for (const [name, root] of [
      ["kro-pwa's code config", repoWithCommitlint(KRO_PWA)],
      ["a data config", repoWithCommitlint(CONVENTIONAL_RC)],
      ["no config", repoWithCommitlint({})],
    ] as const) {
      const result = await capture(["commit", "format", "--type", "feat", "--scope", "capture", "--subject", SUBJECT_75, "--body", SENTENCE], false, root);
      expect(result.code, name).toBe(2);
      expect(result.out, name).toEqual([]);
      const err = result.err.join("\n");
      expect(err, name).toContain("nen: header line is 75 characters, over the 72-character convention");
      expect(err, name).toMatch(/nen: note: --body rewrapped: its line 1 \(144 characters\) was over (the )?100 characters/);
    }
  });

  it("emits a message within its limits byte for byte, and says nothing, where a rule is read (AC4)", async () => {
    const body = `Why it matters.\n\n- a list item\n- another, with https://example.com/${"x".repeat(120)}\n${"y".repeat(100)}`;
    const expected = `fix(commit): keep the message as typed\n\n${body}\n\nHatsu-Agent: kurapika`;
    for (const root of [repoWithCommitlint(CONVENTIONAL_RC), repoWithCommitlint({})]) {
      const result = await capture(
        ["commit", "format", "--type", "fix", "--scope", "commit", "--subject", "keep the message as typed", "--body", body, "--trailer", "Hatsu-Agent=kurapika"],
        false,
        root,
      );
      expect(result.code).toBe(0);
      expect(result.out.join("\n")).toBe(expected);
      expect(result.err).toEqual([]);
    }
  });

  it("wraps a code config's body at config-conventional's 100 and says the width was NOT read -- never executing it", async () => {
    const root = repoWithCommitlint(KRO_PWA);
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "rebuild the prompt", "--body", SENTENCE], false, root);
    expect(result.code).toBe(0);
    expect(Math.max(...lengths(result.out))).toBeLessThanOrEqual(100);
    const err = result.err.join("\n");
    expect(err).toMatch(/nen: note: --body rewrapped: its line 1 \(144 characters\) was over 100 characters, @commitlint\/config-conventional's default, since 'body-max-line-length' could not be read/);
    expect(err).toMatch(/nen: note: 'body-max-line-length' NOT read: .*commitlint\.config\.cjs is a JavaScript\/TypeScript commitlint config nen does not execute\. So nen holds the body -- every line before the trailer block, wherever commitlint places it -- to @commitlint\/config-conventional's 100 characters a line.*and refuses a line over it -- declare the repository's own width in nen\/workflow\.json's commits\.bodyMaxLineLength/);
  });

  it("leaves a URL-bearing line whole whatever its length, as commitlint exempts it", async () => {
    const root = repoWithCommitlint(CONVENTIONAL_RC);
    const line = `The discussion is at https://github.com/zheref/nen/issues/290#issuecomment-1234567890 and ${"it ran long ".repeat(8)}`.trim();
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "cite the thread", "--body", line], false, root);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toBe(`fix: cite the thread\n\n${line}`);
    expect(result.err).toEqual([]);
  });

  it("wraps to an explicit narrower width, and only warns for what it cannot wrap under a level-1 rule", async () => {
    const root = repoWithCommitlint({ ".commitlintrc.json": JSON.stringify({ rules: { "body-max-line-length": [1, "always", 72] } }) });
    const wrapped = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--body", SENTENCE], false, root);
    expect(wrapped.code).toBe(0);
    expect(Math.max(...lengths(wrapped.out))).toBeLessThanOrEqual(72);
    const token = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--body", "w".repeat(80)], false, root);
    expect(token.code).toBe(0);
    expect(token.err.join("\n")).toMatch(/nen: warning: line 3 is 80 characters, over the 72 .*The rule is at level 1/);
  });

  it("warns, with no rule to refuse it, when it cannot wrap a line where no commitlint config exists", async () => {
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--body", "w".repeat(120)], false, repoWithCommitlint({}));
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toBe(`fix: x\n\n${"w".repeat(120)}`);
    expect(result.err).toEqual([expect.stringMatching(/^nen: warning: line 3 is 120 characters, and 'commit format' could not wrap it to 100: .*No commitlint rule limits it here \(no commitlint config was found\)/)]);
  });

  it("never wraps a --trailer, and refuses one over a level-2 footer width at exit 2", async () => {
    const root = repoWithCommitlint(CONVENTIONAL_RC);
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--trailer", `Refs=${"a ".repeat(55)}end`], false, root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/^nen: line 3 is 119 characters, over the 100 that this repository's commitlint rule 'footer-max-line-length' allows/m);
  });

  it("keeps --json's one key, carrying the wrapped message", async () => {
    const root = repoWithCommitlint(CONVENTIONAL_RC);
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--body", SENTENCE], true, root);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["message"]);
    expect(String(parsed["message"]).split("\n").every((line) => line.length <= 100)).toBe(true);
  });

  it("exits 1 only on a line-length rule of a shape commitlint rejects, naming the rule -- and names it beside a broken policy file", async () => {
    const root = repoWithCommitlint({ ".commitlintrc.json": JSON.stringify({ rules: { "body-max-line-length": [2, "sometimes", 100] } }) });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "x"], false, root);
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      expect.stringMatching(
        /^nen: .*\.commitlintrc\.json could not be read for its commitlint 'body-max-line-length' rule: rule 'body-max-line-length' must have 'always' or 'never' as its condition.*nen will not call a message well-formed under a body-max-line-length rule it could not read: fix the file, then run this again\.$/,
      ),
    ]);
    const both = repoWithCommitlint({ ".commitlintrc.json": JSON.stringify({ rules: { "footer-max-line-length": [5] } }) }, { allowedAttributionTrailers: [] });
    writeFileSync(join(both, "nen", "workflow.json"), '{"coverage":{"minimum":95,"ideal":10}}');
    const broken = await capture(["commit", "format", "--type", "fix", "--subject", "x"], false, both);
    expect(broken.code).toBe(1);
    expect(broken.err.join("\n")).toContain("does not ascend");
    expect(broken.err.join("\n")).toContain("'footer-max-line-length' rule");
  });
});

describe("nen commit format -- the review's settle: widths commitlint accepts, a rule turned off, and --body numbering (zheref/nen#290)", () => {
  const LONG = "This rebuilds the capture prompt so that endeavor pills are rendered inline and the pane-hosted Inbox triage keeps its selection across reloads.";

  it("takes a width stated as a string, as commitlint does -- origin/main's exit 0 is kept, and the width is applied (M1)", async () => {
    const root = repoWithCommitlint({ ".commitlintrc.json": JSON.stringify({ rules: { "body-max-line-length": [2, "always", "100"] } }) });
    const bare = await capture(["commit", "format", "--type", "fix", "--subject", "x"], false, root);
    expect(bare).toMatchObject({ code: 0, out: ["fix: x"], err: [] });
    const wrapped = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--body", LONG], false, root);
    expect(wrapped.code).toBe(0);
    expect(wrapped.out.join("\n").split("\n").every((line) => line.length <= 100)).toBe(true);
  });

  it("passes a subject-only message under a rule with no width, and refuses a body there, saying what commitlint does (M1)", async () => {
    const root = repoWithCommitlint({ ".commitlintrc.json": JSON.stringify({ rules: { "body-max-line-length": [2, "always"] } }) });
    expect(await capture(["commit", "format", "--type", "fix", "--subject", "x"], false, root)).toMatchObject({ code: 0, out: ["fix: x"], err: [] });
    const body = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--body", "why it matters"], false, root);
    expect(body.code).toBe(2);
    expect(body.err).toEqual([
      expect.stringMatching(/^nen: the body's line 3 breaks this repository's commitlint rule 'body-max-line-length' .*commitlint compares each line's length against 0, so it refuses every body line that is not blank and holds no URL; a message with no body passes\./),
    ]);
  });

  it("does not wrap under a rule the repository turned off, and says nothing (L2)", async () => {
    const root = repoWithCommitlint({ ".commitlintrc.json": JSON.stringify({ extends: ["@commitlint/config-conventional"], rules: { "body-max-line-length": [0] } }) });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--body", LONG], false, root);
    expect(result).toMatchObject({ code: 0, out: [`fix: x\n\n${LONG}`], err: [] });
  });

  it("numbers the rewrapped line as the --body was given, blank lines it starts with included (nit)", async () => {
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--body", `\n\n${LONG}`], false, repoWithCommitlint({}));
    expect(result.err).toEqual([expect.stringMatching(/^nen: note: --body rewrapped: its line 3 \(144 characters\)/)]);
  });
});

describe("nen commit format -- the maintainer's ruling on #290: refuse at 100, declarable in commits.bodyMaxLineLength", () => {
  const KRO_PWA = { "commitlint.config.cjs": "module.exports = { extends: ['@commitlint/config-conventional'] }\nthrow new Error('nen executed the repository config')\n" };
  const TOKEN = "w".repeat(120);

  it("REFUSES at exit 2 a body line it cannot bring under 100 when the config is code and nothing is declared", async () => {
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--body", `see ${TOKEN}`], false, repoWithCommitlint(KRO_PWA));
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/^nen: line 4 is 120 characters, over the 100 nen holds the body to because 'body-max-line-length' could not be read .*declare its width in nen\/workflow\.json's commits\.bodyMaxLineLength\.$/m);
  });

  it("holds the body to a DECLARED width instead: 150 admits the line, and the note names the declaration", async () => {
    const root = repoWithCommitlint(KRO_PWA, { bodyMaxLineLength: 150 });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--body", `see ${TOKEN}`], false, root);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toBe(`fix: x\n\nsee ${TOKEN}`);
    expect(result.err.join("\n")).toMatch(/nen: note: body-max-line-length checked against commits\.bodyMaxLineLength in .*nen\/workflow\.json, 150; nen applies it because .*commitlint\.config\.cjs is a JavaScript\/TypeScript commitlint config nen does not execute -- keep the two in step/);
    const over = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--body", "w".repeat(160)], false, root);
    expect(over.code).toBe(2);
    expect(over.err.join("\n")).toMatch(/^nen: line 3 is 160 characters, over the body width this repository declares \(commits\.bodyMaxLineLength in .*, 150;/m);
  });

  it("binds where there is no commitlint config at all, too", async () => {
    const root = repoWithCommitlint({}, { bodyMaxLineLength: 72 });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--body", "w".repeat(80)], false, root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/over the body width this repository declares \(commits\.bodyMaxLineLength in .*, 72; nen applies it because no commitlint config was found at /);
  });

  it("refuses a malformed declaration at exit 1, by pointer", async () => {
    const root = repoWithCommitlint(KRO_PWA, { bodyMaxLineLength: "150" });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "x"], false, root);
    expect(result.code).toBe(1);
    expect(result.err).toEqual([expect.stringMatching(/^nen: .*nen\/workflow\.json: at commits\.bodyMaxLineLength, the declared body width must be a whole number of at least 1/)]);
  });

  it("lets a readable data config decide, with a note that the declaration differs", async () => {
    const root = repoWithCommitlint(CONVENTIONAL_RC, { bodyMaxLineLength: 150 });
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--body", `see ${TOKEN}`], false, root);
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/nen: note: commits\.bodyMaxLineLength in .*nen\/workflow\.json is not applied, and it DIFFERS: .*\.commitlintrc\.json states \[2, "always", 100\].*the declaration states 150; nen follows/);
    expect(err).toMatch(/^nen: line 4 is 120 characters, over the 100 that this repository's commitlint rule 'body-max-line-length' allows/m);
  });
});

describe("nen commit format -- --body prose commitlint reads as footer is held to the ruled width (review F1, F4)", () => {
  const KRO_PWA = { "commitlint.config.cjs": "module.exports = { extends: ['@commitlint/config-conventional'] }\nthrow new Error('nen executed the repository config')\n" };
  const TOKEN = "w".repeat(120);

  it("refuses at exit 2 an unwrappable line after a 'Note:' paragraph, under a code config and nothing declared", async () => {
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "a subject", "--body", `Note: the cache is now keyed by path.\n\nThe trace is at ${TOKEN}`], false, repoWithCommitlint(KRO_PWA));
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/^nen: line 6 is 120 characters, over the 100 nen holds every line before the trailer block \(commitlint reads this one as footer, after a footer token\) to because 'footer-max-line-length' could not be read/m);
  });

  it("wraps a wrappable one at that width instead, and exits 0", async () => {
    const prose = "The trace is at the far end of a long sentence that keeps going well past the hundred characters commitlint allows here.";
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "a subject", "--body", `Note: the cache is now keyed by path.\n\n${prose}`], false, repoWithCommitlint(KRO_PWA));
    expect(result.code).toBe(0);
    const lines = result.out.join("\n").split("\n");
    expect(lines.every((line) => line.length <= 100)).toBe(true);
    expect(lines.slice(4).join(" ")).toBe(prose);
  });

  it("names an overlong --trailer value as the long word it is, not as a break it cannot make (F4)", async () => {
    const code = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--trailer", `Refs=${TOKEN}`], false, repoWithCommitlint(KRO_PWA));
    expect(code.code).toBe(0);
    expect(code.err.join("\n")).toMatch(/nen: warning: line 3 is 126 characters: 'footer-max-line-length' NOT checked, .*To clear it: it holds a word longer than 100 characters, which nen never splits/);
    expect(code.err.join("\n")).not.toMatch(/no break within/);
    const data = await capture(["commit", "format", "--type", "fix", "--subject", "x", "--trailer", `Refs=${TOKEN}`], false, repoWithCommitlint(CONVENTIONAL_RC));
    expect(data.code).toBe(2);
    expect(data.err.join("\n")).toMatch(/'footer-max-line-length' allows .*it holds a word longer than 100 characters/);
  });
});

describe("nen commit format -- cannot end its message in a whitespace-only line, so its trailer block never shifts (PR #302 review)", () => {
  it("trims --body and renders --trailer last: a long trailer after a spaces-only --body line is still only warned", async () => {
    const TOKEN = "t".repeat(120);
    const root = repoWithCommitlint({ "commitlint.config.cjs": "module.exports = { extends: ['@commitlint/config-conventional'] }\n" });
    for (const argv of [
      ["--body", `short prose.\n\nRefs: ${TOKEN}\n   `],
      ["--body", "short prose.\n   ", "--trailer", `Refs=${TOKEN}`],
    ]) {
      const result = await capture(["commit", "format", "--type", "fix", "--subject", "x", ...argv], false, root);
      expect(result.code, JSON.stringify(argv)).toBe(0);
      expect(result.out.join("\n").endsWith(`Refs: ${TOKEN}`), JSON.stringify(argv)).toBe(true);
      expect(result.err.join("\n"), JSON.stringify(argv)).toMatch(/nen: warning: line 5 is 126 characters: 'footer-max-line-length' NOT checked/);
    }
  });
});
