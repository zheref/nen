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

  it("does not read the policy at all when the invocation carries no trailer", async () => {
    // A message that could not have violated the policy must not fail on one.
    const root = repoWithPolicy({ allowedAttributionTrailers: [] });
    writeFileSync(join(root, "nen", "workflow.json"), "{ not json");
    expect((await capture(["commit", "format", "--type", "fix", "--subject", "x"], false, root)).code).toBe(0);
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

// ── the repository's own commitlint subject-case rule (part of zheref/nen#263)

/** A checkout root (it has a `.git` entry) holding exactly these commitlint files, and optionally a trailer policy. */
function repoWithCommitlint(files: Record<string, string>, commits?: unknown): string {
  const root = commits === undefined ? mkdtempSync(join(tmpdir(), "nen-commit-commitlint-")) : repoWithPolicy(commits);
  mkdirSync(join(root, ".git"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

const CONVENTIONAL_RC = { ".commitlintrc.json": JSON.stringify({ extends: ["@commitlint/config-conventional"] }) };

describe("nen commit format -- the repository's commitlint subject-case rule (part of zheref/nen#263)", () => {
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
