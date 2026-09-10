import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { wcCommand } from "./command.js";

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  // `null` is a real case: the invocation that never typed --repo (zheref/nen#28).
  repoFlag: string | null = BANKAI_REPO,
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
  const scripted = new ScriptedSeams(script);
  const seams: Seams = scripted;
  const code = await runFamily(wcCommand, argv, repoFlag, false, io, seams);
  return { code, out, err };
}

describe("nen wc classify -- CLI wiring", () => {
  it("reports must-move for a dirty trunk", async () => {
    const result = await capture(["wc", "classify"], [
      { match: "git symbolic-ref --short HEAD", result: { stdout: "main\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M x.ts\n" } },
    ]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/case: must-move/);
  });

  it("always exits 0 -- a report, not a guard", async () => {
    const result = await capture(["wc", "classify"], [
      { match: "git symbolic-ref --short HEAD", result: { stdout: "main\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M x.ts\n" } },
    ]);
    expect(result.code).toBe(0);
  });

  // zheref/nen#28: the usage line lists --repo unbracketed, so omitting it is
  // refused by name -- never silently read as "classify the process's cwd".
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["wc", "classify"], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["wc", "bogus"])).code).toBe(2);
  });
});

/** A real file on disk holding `content`, for `--message-file` (a real fs read). */
function messageFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-wc-squash-msg-"));
  const path = join(dir, "message.txt");
  writeFileSync(path, content, "utf8");
  return path;
}

const CLEAN = { match: "git status --porcelain=v1 -uall", result: { stdout: "" } };
const MERGE_BASE = { match: "git merge-base main HEAD", result: { stdout: "base0000\n" } };
const ANCESTOR_OK = { match: "git merge-base --is-ancestor main HEAD", result: { code: 0 } };
const NO_UPSTREAM = { match: "git rev-parse --abbrev-ref @{upstream}", result: { code: 1 } };
const TWO_COMMITS = {
  match: "git log base0000..HEAD --format=%H%x09%s",
  result: { stdout: "sha2\tsecond commit\nsha1\tfirst commit\n" },
};

describe("nen wc squash -- CLI wiring", () => {
  it("refuses an OMITTED --repo at exit 2, naming the flag", async () => {
    const result = await capture(["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("refuses an OMITTED --onto at exit 2", async () => {
    const result = await capture(["wc", "squash", "--message-file", messageFile("feat: x\n")]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--onto is required/);
  });

  it("refuses an OMITTED --message-file at exit 2", async () => {
    const result = await capture(["wc", "squash", "--onto", "main"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--message-file is required/);
  });

  it("refuses a --message-file that fails Conventional Commits shape, at exit 2, naming every reason", async () => {
    const result = await capture([
      "wc",
      "squash",
      "--onto",
      "main",
      "--message-file",
      messageFile(`bogus: ${"x".repeat(80)}\n`),
    ]);
    expect(result.code).toBe(2);
    const message = result.err.join("\n");
    expect(message).toMatch(/not one of/);
    expect(message).toMatch(/72-character/);
  });

  it("refuses a dirty working tree at exit 2, and never even reads --onto's ancestry", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")],
      [{ match: "git status --porcelain=v1 -uall", result: { stdout: " M dirty.ts\n" } }],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/dirty.ts/);
  });

  it("refuses --onto not an ancestor of HEAD, at exit 2", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")],
      [CLEAN, MERGE_BASE, { match: "git merge-base --is-ancestor main HEAD", result: { code: 1 } }],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/not an ancestor/);
  });

  it("refuses a folded commit already on the upstream, at exit 2, naming it as already published", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")],
      [
        CLEAN,
        MERGE_BASE,
        ANCESTOR_OK,
        TWO_COMMITS,
        { match: "git rev-parse --abbrev-ref @{upstream}", result: { stdout: "origin/work\n" } },
        { match: "git fetch origin work", result: { code: 0 } },
        { match: "git merge-base --is-ancestor sha1 origin/work", result: { code: 0 } },
      ],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/already published; squashing would rewrite pushed history/);
  });

  it("exits 0 with one line, not a refusal, when fewer than two commits would fold", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")],
      [CLEAN, MERGE_BASE, ANCESTOR_OK, { match: "git log base0000..HEAD --format=%H%x09%s", result: { stdout: "" } }],
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/nothing to squash/);
  });

  it("--dry-run prints the folded commits and the message, and touches neither reset nor commit", async () => {
    const script = [CLEAN, MERGE_BASE, ANCESTOR_OK, TWO_COMMITS, NO_UPSTREAM];
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: add a thing\n\nCloses: #4\n"), "--dry-run"],
      script,
    );
    expect(result.code).toBe(0);
    const out = result.out.join("\n");
    expect(out).toMatch(/would fold 2 commit\(s\)/);
    expect(out).toContain("sha1 first commit");
    expect(out).toContain("sha2 second commit");
    expect(out).toContain("feat: add a thing");
    expect(out).toContain("Closes: #4");
  });

  it("performs the real squash: reset --soft then commit -F, in that order, after every refusal has passed", async () => {
    const path = messageFile("feat: add a thing\n");
    const script = [
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      TWO_COMMITS,
      NO_UPSTREAM,
      { match: "git reset --soft base0000", result: { code: 0 } },
      { match: `git commit -F ${path}`, result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "newsha00\n" } },
    ];
    const result = await capture(["wc", "squash", "--onto", "main", "--message-file", path], script);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("squashed into newsha00");
  });

  it("--json prints the nen.wc.squash/v0.1 contract, folded oldest-first, newSha set", async () => {
    const path = messageFile("feat: add a thing\n");
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const seams: Seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      TWO_COMMITS,
      NO_UPSTREAM,
      { match: "git reset --soft base0000", result: { code: 0 } },
      { match: `git commit -F ${path}`, result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "newsha00\n" } },
    ]);
    const code = await runFamily(wcCommand, ["wc", "squash", "--onto", "main", "--message-file", path], BANKAI_REPO, true, io, seams);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(parsed["contract"]).toBe("nen.wc.squash/v0.1");
    expect(parsed["onto"]).toBe("main");
    expect(parsed["mergeBase"]).toBe("base0000");
    expect(parsed["folded"]).toEqual(["sha1", "sha2"]);
    expect(parsed["newSha"]).toBe("newsha00");
    expect(parsed["dryRun"]).toBe(false);
  });
});
