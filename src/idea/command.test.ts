import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { ideaCommand } from "./command.js";

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
  const seams: Seams = new ScriptedSeams(script);
  const code = await runFamily(ideaCommand, argv, repoFlag, false, io, seams);
  return { code, out, err };
}

describe("nen idea file -- CLI wiring", () => {
  it("requires --target", async () => {
    const result = await capture(["idea", "file"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--target/);
  });

  it("requires --body-file", async () => {
    expect((await capture(["idea", "file", "--target", "o/n"])).code).toBe(2);
  });

  // zheref/nen#28: the usage line lists --repo unbracketed, so omitting it is
  // refused by name, before any file is read.
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["idea", "file", "--target", "o/n"], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("exits 0 and reports OK on a clean read-back round trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-idea-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "the body");
    const result = await capture(
      [
        "idea",
        "file",
        "--target",
        "zheref/nen",
        "--title",
        "t",
        "--body-file",
        bodyFile,
        "--label",
        "bankai:severity/high",
        "--assignee",
        "me",
      ],
      [
        {
          match: `gh issue create --repo zheref/nen --title t --body-file ${bodyFile} --assignee me --label bankai:severity/high`,
          result: { stdout: "https://github.com/zheref/nen/issues/5\n" },
        },
        {
          match: "gh api repos/zheref/nen/issues/5",
          result: { stdout: JSON.stringify({ title: "t", body: "the body", labels: [{ name: "bankai:severity/high" }] }) },
        },
      ],
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/read-back OK/);
  });

  // zheref/nen#77: the read-back now says WHICH CLASS of object answered. A
  // pull request here means the verification fetch reached a different object
  // than the one just filed, so the verdict is refused rather than rendered.
  it("exits 1 and names the issue when the read-back answers with a pull request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-idea-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "the body");
    const result = await capture(
      [
        "idea",
        "file",
        "--target",
        "zheref/nen",
        "--title",
        "t",
        "--body-file",
        bodyFile,
        "--label",
        "bankai:severity/high",
        "--assignee",
        "me",
      ],
      [
        {
          match: `gh issue create --repo zheref/nen --title t --body-file ${bodyFile} --assignee me --label bankai:severity/high`,
          result: { stdout: "https://github.com/zheref/nen/issues/5\n" },
        },
        {
          match: "gh api repos/zheref/nen/issues/5",
          result: {
            stdout: JSON.stringify({
              number: 5,
              title: "t",
              body: "the body",
              labels: [{ name: "bankai:severity/high" }],
              pull_request: { url: "https://api.github.com/repos/zheref/nen/pulls/5" },
            }),
          },
        },
      ],
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/idea filed as #5, but the read-back answered with a PULL REQUEST/);
    // NEVER the confident verdict: every compared field matched above, so a
    // verb without the class check would have printed exactly this line.
    expect(result.out.join("\n")).not.toMatch(/read-back OK/);
  });

  // THE --json SHAPE OF THIS FAILURE, PINNED. It is deliberately NOT the
  // `refused: true` object the 'issue' family's object-class refusals emit:
  // "refused" means "I declined to act on your input", and here the verb has
  // already acted -- the issue is filed. This is a read-back that could not
  // confirm what it read, which is the failure `idea file` has always
  // surfaced as an error line and exit 1, with no result object because there
  // is no verdict to report. The test exists so that contract is a decision on
  // the record rather than an accident of where the throw lands.
  it("--json emits no verdict object for that failure -- exit 1 and the message on stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-idea-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "the body");
    const result = await capture(
      [
        "idea",
        "file",
        "--target",
        "zheref/nen",
        "--title",
        "t",
        "--body-file",
        bodyFile,
        "--label",
        "bankai:severity/high",
        "--assignee",
        "me",
        "--json",
      ],
      [
        {
          match: `gh issue create --repo zheref/nen --title t --body-file ${bodyFile} --assignee me --label bankai:severity/high`,
          result: { stdout: "https://github.com/zheref/nen/issues/5\n" },
        },
        {
          match: "gh api repos/zheref/nen/issues/5",
          result: {
            stdout: JSON.stringify({
              number: 5,
              title: "t",
              body: "the body",
              labels: [{ name: "bankai:severity/high" }],
              pull_request: { url: "https://api.github.com/repos/zheref/nen/pulls/5" },
            }),
          },
        },
      ],
    );
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/PULL REQUEST, not an issue/);
  });

  it("idea --help documents the read-back's object-class check", async () => {
    const result = await capture(["idea", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/The read-back also checks WHICH CLASS OF OBJECT answered/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["idea", "bogus"])).code).toBe(2);
  });
});

// zheref/nen#94. `--forbid-family` was declared in the flag spec and forwarded
// into `fileIdea`'s FileRequest exactly as `issue file`'s is -- so it worked,
// and nothing outside the source tree said it existed.
describe("nen idea --help -- every flag the spec accepts is documented", () => {
  it("documents --forbid-family, with what it does", () => {
    expect(ideaCommand.usage).toContain("--forbid-family ns:family");
    expect(ideaCommand.usage).toContain("declares off-limits");
  });

  it("documents every value flag the spec accepts", () => {
    // The rule rather than the one instance: a flag the parser takes and the
    // help never names is a flag only the source tells a caller about, which is
    // how this one went unmentioned in the first place.
    for (const flag of ideaCommand.flags.values ?? []) {
      expect(ideaCommand.usage, `--${flag}`).toContain(`--${flag}`);
    }
  });
});

// zheref/nen#93's rule, applied to this family's fifth copy of the same check.
describe("nen idea file -- --target refuses the way every other family does", () => {
  it("refuses a MALFORMED --target at exit 2, not 1", async () => {
    const result = await capture([
      "idea", "file", "--target", "not-a-slug", "--title", "t",
      "--body-file", "x", "--label", "a", "--assignee", "u",
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/owner\/name/);
  });

  it("refuses a MISSING --target at exit 2, naming the flag", async () => {
    const result = await capture([
      "idea", "file", "--title", "t", "--body-file", "x", "--label", "a", "--assignee", "u",
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--target owner\/name is required/);
  });
});
