import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { Seams } from "../seam/exec.js";
import { colorCommand } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";

// NEVER `defaultSeams()` HERE (review finding, see ../board/command.test.ts's
// own note): a `run` that throws turns a future regression -- this family
// growing a real `git`/`gh` call -- into an immediate red test rather than a
// silent live subprocess.
const STUB_SEAMS: Seams = {
  run: (): never => {
    throw new Error("must not be called");
  },
  now: (): Date => new Date("2026-01-01T00:00:00Z"),
  env: {},
  probePort: noPortProbe,
  runInteractive: (): never => {
    throw new Error("this verb has no interactive form");
  },
  platform: "linux",
};

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping -- which is the whole subject of these tests.
async function capture(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const code = await runFamily(colorCommand, argv, BANKAI_REPO, false, io, STUB_SEAMS);
  return { code, out, err };
}

describe("nen color status", () => {
  it("resolves by the file's own precedence, exit 0", async () => {
    const result = await capture(["color", "status", "--present", "ready_g1,blocked"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/Blocked/);
    expect(result.out.join("\n")).toMatch(/precedence:/);
  });

  it("refuses a TYPO'D --category at exit 2, the same code as 'ref parse' (zheref/nen#10 item 3)", async () => {
    // The refusal already enumerated the categories the file declares -- the
    // canonical shape of a usage error, "here is what you could have meant" --
    // and exited 1 anyway, so a retry wrapper honouring ../index.ts's own code
    // contract would retry a misspelt category forever against a file that
    // will never grow it. `label apply` and `ref parse` were converted; this
    // one was the last caller-typed token still exiting 1.
    const result = await capture(["color", "status", "--present", "blocked", "--category", "statuss"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/declares no 'statuss' category/);
    // The domain message is carried WHOLE, never re-worded: the enumeration is
    // the actionable half.
    expect(result.err.join("\n")).toMatch(/Categories here: /);
    expect(result.err.join("\n")).toMatch(/Run 'nen color --help'/);
  });

  it("still exits 1 when the set is UNRESOLVED -- a run that failed, not a typo", async () => {
    // The distinction the exit codes exist for: the invocation was well-formed
    // and understood, and the derivation is what produced no answer.
    const result = await capture(["color", "status", "--present", "not-a-value"]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/unresolved:/);
  });
});
