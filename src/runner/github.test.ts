// The one sentence a `gh` failure becomes (Feitan, zheref/nen#340): redacted,
// and terminal-safe line by line, because it is only ever printed.

import { describe, expect, it } from "vitest";
import type { CommandResult } from "../seam/exec.js";
import { describeFailure } from "./github.js";

const result = (stderr: string, code = 1): CommandResult => ({ code, stdout: "", stderr, spawnFailed: false });

describe("describeFailure", () => {
  it("strips control and invisible characters from every stderr line, and joins them", () => {
    expect(describeFailure(result("HTTP 404: runner NZ\u001b[2K-NNR1\nnot ‮found\r\n"))).toBe("HTTP 404: runner NZ[2K-NNR1 not found");
  });

  it("still redacts a token before it prints", () => {
    expect(describeFailure(result("bad credentials ghp_abcdefghijklmnopqrstuvwxyz0123"))).not.toMatch(/ghp_/);
  });

  it("names the exit code when gh said nothing", () => {
    expect(describeFailure(result("", 4))).toBe("exit 4, no stderr");
  });
});
