import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { commitCommand } from "./command.js";

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
    runInteractive: (): never => {
      throw new Error("this verb has no interactive form");
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
