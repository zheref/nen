import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { scaffoldCommand } from "./command.js";

async function capture(argv: readonly string[], repoFlag: string | null): Promise<{ code: number; out: string[]; err: string[] }> {
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
      throw new Error("scaffold init makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
  };
  const code = await runFamily(scaffoldCommand, argv, repoFlag, false, io, seams);
  return { code, out, err };
}

describe("nen scaffold init -- CLI wiring", () => {
  it("creates directories and installs the hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-scaffold-verb-"));
    const result = await capture(
      ["scaffold", "init", "--directories", "src,tests", "--agent-trailer", "X-Agent", "--run-trailer", "X-Run", "--marker-env", "X_CI"],
      root,
    );
    expect(result.code).toBe(0);
    expect(existsSync(join(root, "src"))).toBe(true);
    expect(existsSync(join(root, ".git", "hooks", "commit-msg"))).toBe(true);
    expect(result.out.join("\n")).toMatch(/hook: installed/);
  });

  it("requires --agent-trailer, --run-trailer and --marker-env", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-scaffold-verb-"));
    expect((await capture(["scaffold", "init"], root)).code).toBe(2);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["scaffold", "bogus"], null)).code).toBe(2);
  });

  // zheref/nen#28: the usage line lists --repo unbracketed, so omitting it is
  // refused by name -- a scaffold that defaulted to the cwd would write
  // directories and a hook into whatever repository the process stood in.
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(
      ["scaffold", "init", "--agent-trailer", "X-Agent", "--run-trailer", "X-Run", "--marker-env", "X_CI"],
      null,
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  // Review finding #5: the verb must surface and exit non-zero on a refused hook install.
  it("exits 1 and never clobbers a pre-existing, different commit-msg hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-scaffold-verb-"));
    const hookPath = join(root, ".git", "hooks", "commit-msg");
    mkdirSync(dirname(hookPath), { recursive: true });
    const projectsOwnHook = "#!/bin/sh\n# owned by the project\nexit 0\n";
    writeFileSync(hookPath, projectsOwnHook);

    const result = await capture(
      ["scaffold", "init", "--agent-trailer", "X-Agent", "--run-trailer", "X-Run", "--marker-env", "X_CI"],
      root,
    );
    expect(result.code).toBe(1);
    expect(readFileSync(hookPath, "utf8")).toBe(projectsOwnHook);
    expect(result.err.join("\n")).toMatch(/already exists/);
  });

  // Review finding #11: a trailer key or marker env var outside its legal
  // charset is interpolated raw into the generated shell hook.
  it("refuses an --agent-trailer that would inject into the generated shell hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-scaffold-verb-"));
    const result = await capture(
      ["scaffold", "init", "--agent-trailer", "A'; echo PWNED >&2; #", "--run-trailer", "X-Run", "--marker-env", "X_CI"],
      root,
    );
    expect(result.code).toBe(2);
    expect(existsSync(join(root, ".git", "hooks", "commit-msg"))).toBe(false);
  });

  it("refuses a --marker-env that is not a legal shell identifier", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-scaffold-verb-"));
    const result = await capture(
      ["scaffold", "init", "--agent-trailer", "X-Agent", "--run-trailer", "X-Run", "--marker-env", "1; rm -rf /"],
      root,
    );
    expect(result.code).toBe(2);
  });
});
