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
          match: "gh issue view 5 --repo zheref/nen --json title,body,labels",
          result: { stdout: JSON.stringify({ title: "t", body: "the body", labels: [{ name: "bankai:severity/high" }] }) },
        },
      ],
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/read-back OK/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["idea", "bogus"])).code).toBe(2);
  });
});
