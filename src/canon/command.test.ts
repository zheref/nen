import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { canonCommand } from "./command.js";

async function capture(
  argv: readonly string[],
  // `null` is a real case, not a default-filler: the invocation that never
  // typed --repo at all (zheref/nen#28's subject).
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
  const seams: Seams = {
    run: (): CommandResult => {
      throw new Error("canon makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
  };
  const code = await runFamily(canonCommand, argv, repoFlag, false, io, seams);
  return { code, out, err };
}

function resolveArgs(values: Record<string, string>): string[] {
  const argv = ["canon", "resolve"];
  for (const [key, value] of Object.entries(values)) argv.push(`--${key}`, value);
  return argv;
}

describe("nen canon resolve -- CLI wiring", () => {
  it("resolves the scenario recorded for the target and derives the stack path", async () => {
    const result = await capture(
      resolveArgs({
        target: "zheref/KroApple",
        "always-load": "handbooks/uzf-core.md,handbooks/security-baseline.md",
        "stack-dir": "handbooks/stacks",
      }),
    );
    expect(result.code).toBe(0);
    const text = result.out.join("\n");
    expect(text).toMatch(/scenario: swiftui-tca-uzf-v2/);
    expect(text).toMatch(/always load: handbooks\/uzf-core\.md, handbooks\/security-baseline\.md/);
    expect(text).toMatch(/stack handbook: handbooks\/stacks\/swiftui-tca-uzf-v2\/architecture\.md/);
  });

  it("exits 1 with a 'not recorded anywhere' reason when the target repo is unrecorded", async () => {
    const result = await capture(
      resolveArgs({
        target: "zheref/nonexistent",
        "always-load": "handbooks/uzf-core.md",
        "stack-dir": "handbooks/stacks",
      }),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/is not recorded anywhere/);
  });

  // zheref/nen#28: the same three-way cause split repo scenario got, seen
  // through this verb. A repo the registry records WITHOUT a consumers[]
  // scenario used to produce the byte-identical "not a consumer" refusal an
  // unknown repo gets.
  it("exits 1 telling a recorded non-consumer apart from an unknown repo", async () => {
    const result = await capture(
      resolveArgs({
        target: "zheref/KroCloud",
        "always-load": "handbooks/uzf-core.md",
        "stack-dir": "handbooks/stacks",
      }),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/is recorded in .*under 'pending_onboarding'/);
  });

  // zheref/nen#28: --repo is listed unbracketed on the usage line, so omitting
  // it is refused at the parser like --target/--stack-dir/--always-load --
  // never silently defaulted to the cwd to fail later as "no such file".
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(
      resolveArgs({
        target: "zheref/KroApple",
        "always-load": "handbooks/uzf-core.md",
        "stack-dir": "handbooks/stacks",
      }),
      null,
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("requires --target and --stack-dir", async () => {
    expect((await capture(resolveArgs({}))).code).toBe(2);
    expect((await capture(resolveArgs({ target: "o/n" }))).code).toBe(2);
  });

  // Review finding #19: --always-load used to be optional and silently
  // resolved to "(none)" -- indistinguishable from "this repo truly loads
  // nothing unconditionally".
  it("requires --always-load", async () => {
    const result = await capture(resolveArgs({ target: "zheref/KroApple", "stack-dir": "handbooks/stacks" }));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--always-load/);
  });

  it("refuses an empty --always-load rather than silently resolving to '(none)'", async () => {
    const result = await capture(
      resolveArgs({ target: "zheref/KroApple", "always-load": "", "stack-dir": "handbooks/stacks" }),
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/named no paths/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["canon", "bogus"])).code).toBe(2);
  });
});

describe("nen canon mirror generate|check -- CLI wiring", () => {
  const HEADER_TEMPLATE = "<!-- GENERATED from {ref}/{scenario}/{file} -- DO NOT EDIT. -->\n";
  const HEADER_PATTERN = "^<!-- GENERATED from (?<ref>\\S+)\\/(?<scenario>[^/]+)\\/(?<file>\\S+) -- DO NOT EDIT\\. -->\\n";

  function fixture(): { rulesDir: string; canonValues: string; outDir: string } {
    const base = mkdtempSync(join(tmpdir(), "nen-canon-verb-"));
    const rulesDir = join(base, "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "01-a.md"), "Hello {{NAME}}.\n");
    const canonValues = join(base, "canon-values.yml");
    writeFileSync(canonValues, "scenario: scenario-x\nvalues:\n  NAME: World\n");
    return { rulesDir, canonValues, outDir: join(base, "out") };
  }

  it("generate writes the mirror and exits 0", async () => {
    const { rulesDir, canonValues, outDir } = fixture();
    const result = await capture([
      "canon",
      "mirror",
      "generate",
      "--rules-dir",
      rulesDir,
      "--canon-values",
      canonValues,
      "--out-dir",
      outDir,
      "--ref",
      "v1.0.0",
      "--header-template",
      HEADER_TEMPLATE,
    ]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/written: 01-a\.md/);
  });

  it("check reports OK (exit 0) right after a generate, and drift (exit 1) once the source changes", async () => {
    const { rulesDir, canonValues, outDir } = fixture();
    await capture([
      "canon",
      "mirror",
      "generate",
      "--rules-dir",
      rulesDir,
      "--canon-values",
      canonValues,
      "--out-dir",
      outDir,
      "--ref",
      "v1.0.0",
      "--header-template",
      HEADER_TEMPLATE,
    ]);
    const checkArgs = [
      "canon",
      "mirror",
      "check",
      "--rules-dir",
      rulesDir,
      "--canon-values",
      canonValues,
      "--mirror-dir",
      outDir,
      "--ref",
      "v1.0.0",
      "--header-template",
      HEADER_TEMPLATE,
      "--header-pattern",
      HEADER_PATTERN,
    ];
    expect((await capture(checkArgs)).code).toBe(0);

    writeFileSync(join(rulesDir, "01-a.md"), "Hello {{NAME}}, changed.\n");
    const dirty = await capture(checkArgs);
    expect(dirty.code).toBe(1);
    expect(dirty.out.join("\n")).toMatch(/hand-edited: 01-a\.md/);
  });

  it("refuses an unknown 'canon mirror' subcommand", async () => {
    expect((await capture(["canon", "mirror", "bogus"])).code).toBe(2);
  });
});
