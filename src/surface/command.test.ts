// src/surface/command.test.ts -- the family through ../index.ts, so the exit
// codes and the --json documents are the ones a caller actually gets.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "../index.js";
import { markerFor } from "./mirror.js";
import { CHECK_CONTRACT, GENERATE_CONTRACT } from "./command.js";

const SKILLS = join(process.cwd(), "src", "surface", "fixtures", "skills");
const AGENTS = join(process.cwd(), "src", "surface", "fixtures", "agents");

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
  return { code: await run(argv, io), out, err };
}

const tempDir = (): string => mkdtempSync(join(tmpdir(), "nen-surface-cmd-"));

const generateArgv = (surface: string, out: string, extra: readonly string[] = []): readonly string[] => [
  "surface",
  "mirror",
  "generate",
  "--source",
  SKILLS,
  "--agents",
  AGENTS,
  "--surface",
  surface,
  "--out",
  out,
  "--invocation-prefix",
  "demo:",
  ...extra,
];

const checkArgv = (surface: string, out: string): readonly string[] => [
  "surface",
  "mirror",
  "check",
  "--source",
  SKILLS,
  "--agents",
  AGENTS,
  "--surface",
  surface,
  "--out",
  out,
  "--invocation-prefix",
  "demo:",
];

describe("nen surface mirror generate", () => {
  it("writes the mirror and reports the three lists", async () => {
    const out = tempDir();
    const result = await capture(generateArgv("cursor", out));
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "surface: cursor (.cursor/skills/<name>/SKILL.md)",
      `out: ${out}`,
      "written: agents/scout.md, alpha/SKILL.md, beta/SKILL.md",
      "unchanged: (none)",
      "deleted (orphaned): (none)",
    ]);
    expect(readdirSync(out).sort()).toEqual(["agents", "alpha", "beta"]);
  });

  it("prints the row's caveat on stderr, so --json stays ONE document", async () => {
    const out = tempDir();
    const result = await capture([...generateArgv("codex", out), "--json"]);
    expect(result.err.join("\n")).toContain("AGENTS.md as prose");
    const document = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(document["contract"]).toBe(GENERATE_CONTRACT);
    expect(document["surface"]).toBe("codex");
    expect(document["skillsPath"]).toBe(".agents/skills/<name>/SKILL.md");
    expect(document["dryRun"]).toBe(false);
    expect(document["written"]).toEqual(["AGENTS.md", "alpha/SKILL.md", "beta/SKILL.md"]);
  });

  it("--dry-run reports what it would write and writes nothing", async () => {
    const out = tempDir();
    const result = await capture([...generateArgv("codex", out), "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out[1]).toBe(`out: ${out} (--dry-run: nothing written)`);
    expect(result.out).toContain("written: AGENTS.md, alpha/SKILL.md, beta/SKILL.md");
    expect(readdirSync(out)).toEqual([]);
  });

  it("mirrors without --agents at all", async () => {
    const out = tempDir();
    const result = await capture([
      "surface",
      "mirror",
      "generate",
      "--source",
      SKILLS,
      "--surface",
      "codex",
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["alpha", "beta"]);
  });

  it("leaves an invocation mention alone without --invocation-prefix", async () => {
    const out = tempDir();
    await capture(["surface", "mirror", "generate", "--source", SKILLS, "--surface", "codex", "--out", out]);
    expect(readFileSync(join(out, "beta", "SKILL.md"), "utf8")).toContain("demo:beta");
  });
});

describe("nen surface mirror check", () => {
  it("exits 0 on a mirror with no drift", async () => {
    const out = tempDir();
    await capture(generateArgv("codex", out));
    const result = await capture(checkArgv("codex", out));
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "surface: codex",
      "ok: 3",
      "missing: (none)",
      "extra: (none)",
      "stale: (none)",
      "hand-edited: (none)",
    ]);
  });

  it("exits 1 on drift, and the --json report names every class", async () => {
    const out = tempDir();
    await capture(generateArgv("codex", out));
    rmSync(join(out, "beta", "SKILL.md"));
    writeFileSync(join(out, "alpha", "SKILL.md"), `${markerFor("codex")}\nedited by hand\n`);
    mkdirSync(join(out, "gamma"));
    writeFileSync(join(out, "gamma", "SKILL.md"), `${markerFor("codex")}\norphan\n`);
    const result = await capture([...checkArgv("codex", out), "--json"]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(report["contract"]).toBe(CHECK_CONTRACT);
    expect(report["missing"]).toEqual(["beta/SKILL.md"]);
    expect(report["extra"]).toEqual(["gamma/SKILL.md"]);
    expect(report["handEdited"]).toEqual(["alpha/SKILL.md"]);
  });

  it("calls a mirror generated for another surface STALE, not hand-edited", async () => {
    const out = tempDir();
    await capture(generateArgv("codex", out));
    const result = await capture([...checkArgv("cursor", out), "--json"]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(report["stale"]).toEqual(["alpha/SKILL.md", "beta/SKILL.md"]);
    expect(report["handEdited"]).toEqual([]);
  });

  it("writes nothing at all -- a check over a drifted mirror leaves it drifted", async () => {
    const out = tempDir();
    await capture(generateArgv("cursor", out));
    rmSync(join(out, "beta"), { recursive: true });
    await capture(checkArgv("cursor", out));
    expect(readdirSync(out).sort()).toEqual(["agents", "alpha"]);
  });
});

describe("the refusals, every one at exit 2", () => {
  const refusal = async (argv: readonly string[]): Promise<string> => {
    const result = await capture(argv);
    expect(result.code).toBe(2);
    return result.err.join("\n");
  };

  it("refuses a surface that is not a row, listing the ones that are", async () => {
    const message = await refusal(generateArgv("emacs", tempDir()));
    expect(message).toContain("is not in the table");
    expect(message).toContain("codex, cursor");
  });

  it("refuses an --out inside --source", async () => {
    const message = await refusal(generateArgv("codex", join(SKILLS, "mirror")));
    expect(message).toContain("resolves inside --source");
  });

  it("refuses --out that IS --source", async () => {
    expect(await refusal(generateArgv("codex", SKILLS))).toContain("resolves inside --source");
  });

  it("refuses a --source with no SKILL.md under it", async () => {
    const message = await refusal([
      "surface",
      "mirror",
      "generate",
      "--source",
      tempDir(),
      "--surface",
      "codex",
      "--out",
      tempDir(),
    ]);
    expect(message).toContain("holds no <name>/SKILL.md");
  });

  it("refuses a missing --source, --surface or --out by name", async () => {
    expect(await refusal(["surface", "mirror", "generate", "--surface", "codex", "--out", tempDir()])).toContain(
      "--source is required",
    );
    expect(await refusal(["surface", "mirror", "generate", "--source", SKILLS, "--out", tempDir()])).toContain(
      "--surface is required",
    );
    expect(await refusal(["surface", "mirror", "generate", "--source", SKILLS, "--surface", "codex"])).toContain(
      "--out is required",
    );
  });

  it("refuses an empty --agents rather than silently mirroring no personas", async () => {
    const argv = ["surface", "mirror", "generate", "--source", SKILLS, "--surface", "codex", "--out", tempDir(), "--agents", ""];
    expect(await refusal(argv)).toContain("--agents was given an empty value");
  });

  it("refuses --dry-run on check, which never writes anyway", async () => {
    const out = tempDir();
    await capture(generateArgv("codex", out));
    expect(await refusal([...checkArgv("codex", out), "--dry-run"])).toContain(
      "not read by 'surface mirror check'",
    );
  });

  it("refuses to overwrite a file this verb did not write", async () => {
    const out = tempDir();
    mkdirSync(join(out, "alpha"));
    writeFileSync(join(out, "alpha", "SKILL.md"), "hand written\n");
    const message = await refusal(generateArgv("codex", out));
    expect(message).toContain("refusing to overwrite");
    expect(readFileSync(join(out, "alpha", "SKILL.md"), "utf8")).toBe("hand written\n");
  });

  it("refuses a subcommand this family has not got", async () => {
    expect(await refusal(["surface", "mirror"])).toContain("unknown 'surface mirror' subcommand");
    expect(await refusal(["surface", "mirror", "install"])).toContain("unknown 'surface mirror' subcommand");
    expect(await refusal(["surface", "install"])).toContain("unknown 'surface' subcommand");
  });
});

describe("--help", () => {
  it("lists every surface the table carries", async () => {
    const result = await capture(["surface", "--help"]);
    expect(result.code).toBe(0);
    const text = result.out.join("\n");
    expect(text).toContain("codex");
    expect(text).toContain("cursor");
    expect(text).toContain("src/surface/rules.ts");
  });
});
