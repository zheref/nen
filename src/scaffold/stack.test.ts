// src/scaffold/stack.test.ts -- the stack-aware half of `nen scaffold`.
//
// EVERY REPOSITORY HERE IS A TEMPORARY COPY. The `detect` marker trees live in
// `src/shu/fixtures/` and this verb WRITES, so a test that pointed it at one
// would scaffold the repository's own fixtures -- the exact accident
// `--repo`'s no-cwd-default rule exists for one level up.
//
// EVERY SPAWN IS SCRIPTED. The seam handed to each run either refuses to be
// called at all (the dry-run and no-install cases, where a spawn IS the
// failure) or records what it was asked to run (the toolchain cases, where the
// assertion is about which argv reached it). Nothing here starts a program.

import { describe, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { detect } from "../shu/detect.js";
import { shuCommand } from "../shu/command.js";
import { EMPTY_TREE, GATSBY_SITE, NEXTJS_MULTI, NEXTJS_SINGLE, markerTree } from "../shu/fixtures/paths.js";
import {
  COLORS_FILE,
  CONTRACT_FILE,
  GATES_FILE,
  LABELS_FILE,
  LEGACY_MIGRATABLE_FILES,
  REPOS_FILE,
  resolveSchemaFile,
} from "../schema/source.js";
import { looksLikeOwnerSlug } from "../repo/root.js";
import { VERSION } from "../version.js";
import { scaffoldCommand } from "./command.js";
import { MIGRATED_FILES, scaffoldInit, type ToolsOutcome } from "./init.js";
import { postStepDir } from "./new.js";
import { compareNenRefs, minimumNenRef } from "./templates.js";

const TRAILERS = ["--agent-trailer", "X-Agent", "--run-trailer", "X-Run", "--marker-env", "X_CI"];
const HOOK = { agentTrailer: "X-Agent", runTrailer: "X-Run", markerEnvVar: "X_AUTOMATED" };

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  /** Every argv the seam was asked to run, `exe arg arg` per entry. */
  readonly spawned: string[];
}

/** A seam whose every call is a test failure: nothing may spawn. */
function refusingSeams(): Seams {
  return {
    run: (): CommandResult => {
      throw new Error("this invocation must spawn NOTHING");
    },
    runInteractive: (): never => {
      throw new Error("this verb has no interactive form");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
    platform: "linux",
  };
}

/** A seam that records what it was asked to run and answers a fixed result. */
function recordingSeams(spawned: string[], result?: Partial<CommandResult>): Seams {
  return {
    ...refusingSeams(),
    run: (exe, argv): CommandResult => {
      spawned.push([exe, ...argv].join(" "));
      return { code: 0, stdout: "9.15.9\n", stderr: "", spawnFailed: false, ...result };
    },
  };
}

async function capture(argv: readonly string[], repoFlag: string | null, seams?: Seams): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const spawned: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const code = await runFamily(
    scaffoldCommand,
    argv,
    repoFlag,
    argv.includes("--json"),
    io,
    seams ?? recordingSeams(spawned),
  );
  return { code, out, err, spawned };
}

function tempCopy(fixture: string): string {
  const root = mkdtempSync(join(tmpdir(), "nen-scaffold-stack-"));
  cpSync(fixture, root, { recursive: true });
  return root;
}

function tempEmpty(): string {
  return mkdtempSync(join(tmpdir(), "nen-scaffold-stack-"));
}

/**
 * Can this host make a symlink at all?
 *
 * WINDOWS NEEDS A PRIVILEGE FOR ONE. Creating a symlink there requires either
 * Developer Mode or SeCreateSymbolicLinkPrivilege, and a CI runner may have
 * neither -- so the containment tests below PROBE first and return without
 * asserting when the probe fails, rather than failing a platform for a
 * capability the test needs and the product does not. The probe link is removed
 * either way.
 */
function linkable(probe: string, target: string): boolean {
  try {
    symlinkSync(target, probe, "junction");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every entry under a tree, repo-relative and `/`-separated, sorted.
 *
 * DIRECTORIES ARE LISTED TOO, with a trailing slash, and that is not cosmetic:
 * an earlier draft listed files only, and a seeded mutant that made `--dry-run`
 * create every `--directories` entry (and `.git/hooks/`) passed the whole
 * suite -- an empty directory is a write nobody asked for, and a comparison
 * that cannot see one cannot prove "wrote nothing".
 */
function tree(root: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      found.push(`${name}/`, ...tree(root, `${name}/`));
    } else {
      found.push(name);
    }
  }
  return found.sort();
}

// ── the taxonomy layer is unchanged ─────────────────────────────────────────

describe("the taxonomy layer is byte-identical to v0.2.0", () => {
  it("prints v0.2.0's three lines first, in v0.2.0's words", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(
      [
        "scaffold",
        "init",
        "--stack",
        "nextjs",
        "--directories",
        "src,tests",
        ...TRAILERS,
        "--canon-values-path",
        ".claude/canon-values.yml",
        "--scenario",
        "scenario-x",
      ],
      root,
    );
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe(
      `created directories: ${join(root, "src")}, ${join(root, "tests")}, ${join(root, ".git", "hooks")}, ${join(root, ".claude")}`,
    );
    expect(result.out[1]).toBe(`hook: installed (${join(root, ".git", "hooks", "commit-msg")})`);
    // The trunk guard's own line sits between the two, because it is the
    // second HOOK and the summary lists the hooks together.
    expect(result.out[2]).toBe(`pre-commit: installed (${join(root, ".git", "hooks", "pre-commit")})`);
    expect(result.out[3]).toBe(`canon-values: ${join(root, ".claude", "canon-values.yml")}`);
  });

  it("writes the same hook bytes and the same canon-values bytes", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    await capture(
      ["scaffold", "init", "--stack", "nextjs", ...TRAILERS, "--canon-values-path", "cv.yml", "--scenario", "s"],
      root,
    );
    const hook = readFileSync(join(root, ".git", "hooks", "commit-msg"), "utf8");
    expect(hook.startsWith("#!/bin/sh\n")).toBe(true);
    expect(hook).toContain("X-Agent");
    expect(hook).toContain("X_CI");
    expect(readFileSync(join(root, "cv.yml"), "utf8")).toBe(
      [
        "# Generated by 'nen scaffold init'. Bind every {{TOKEN}} 'nen canon mirror generate'",
        "# needs for this repo's rule set. See handbooks/stacks/<scenario>/rules/placeholders.md",
        "# in the canon source for the token registry.",
        "scenario: s",
        "values:",
        "  # TOKEN_NAME: literal value",
        "",
      ].join("\n"),
    );
  });
});

// ── the stack, stated or accepted, never guessed ────────────────────────────

describe("nen never guesses a stack", () => {
  it("refuses with neither flag, naming BOTH ways forward, at exit 2", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(["scaffold", "init", ...TRAILERS], root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--stack <id>/);
    expect(result.err.join("\n")).toMatch(/--accept-detected/);
    // And it refused BEFORE the first write.
    expect(existsSync(join(root, ".git", "hooks", "commit-msg"))).toBe(false);
    expect(existsSync(join(root, "nen"))).toBe(false);
  });

  it("refuses with BOTH flags: they say the same thing two ways and can disagree", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(
      ["scaffold", "init", "--stack", "nextjs", "--accept-detected", ...TRAILERS],
      root,
    );
    expect(result.code).toBe(2);
    expect(existsSync(join(root, "nen"))).toBe(false);
  });

  it("refuses an unknown --stack, listing the ids it knows, before any write", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(["scaffold", "init", "--stack", "no-such-stack", ...TRAILERS], root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/Known: .*nextjs/);
    expect(existsSync(join(root, ".git"))).toBe(false);
  });

  it("refuses --accept-detected on a tree with no marker at all", async () => {
    const root = tempCopy(EMPTY_TREE);
    const result = await capture(["scaffold", "init", "--accept-detected", ...TRAILERS], root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/nothing to accept/);
  });
});

// ── --accept-detected writes exactly what `detect --write` writes ───────────

describe("--accept-detected writes exactly detect's own proposal", () => {
  for (const [what, fixture] of [
    ["a single nextjs lane", NEXTJS_SINGLE],
    ["a gatsby site", GATSBY_SITE],
    ["an expo tree", markerTree("expo")],
    ["an ambiguous tree (two stacks in one directory)", markerTree("ambiguous")],
    ["a multi-lane tree (defaultLane null)", NEXTJS_MULTI],
  ] as const) {
    it(`accepts ${what}`, async () => {
      const root = tempCopy(fixture);
      const expected = detect(root, "linux").proposal;
      expect(expected, "the fixture must actually detect").not.toBeNull();
      const result = await capture(["scaffold", "init", "--accept-detected", ...TRAILERS], root);
      expect(result.code).toBe(0);
      expect(JSON.parse(readFileSync(join(root, "nen", "contract.json"), "utf8"))).toEqual(expected);
    });
  }

  it("does NOT treat ambiguity as an error -- the proposal is written, seats and all", async () => {
    const root = tempCopy(NEXTJS_MULTI);
    const result = await capture(["scaffold", "init", "--accept-detected", ...TRAILERS], root);
    expect(result.code).toBe(0);
    const written = JSON.parse(readFileSync(join(root, "nen", "contract.json"), "utf8")) as {
      project: { defaultLane: string | null; lanes: Record<string, unknown> };
    };
    expect(Object.keys(written.project.lanes).length).toBeGreaterThan(1);
    expect(written.project.defaultLane).toBeNull();
    // And the notes a maintainer has to answer are on screen, not swallowed.
    expect(result.out.join("\n")).toMatch(/defaultLane is null/);
  });

  it("writes the declaration INTO ABSENCE ONLY, and never over a decision", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    mkdirSync(join(root, "nen"), { recursive: true });
    const theirs = '{"$schema":"nen.contract/v0.1","project":{"lanes":{"a":{"stack":"nextjs","cwd":"."}},"defaultLane":"a","verbs":{"a":{}}}}\n';
    writeFileSync(join(root, "nen", "contract.json"), theirs, "utf8");
    const result = await capture(["scaffold", "init", "--accept-detected", ...TRAILERS], root);
    // THE MUTATION THIS CATCHES: the presence check dropped, so a hand-written
    // declaration is silently replaced by an inferred one.
    expect(result.code).toBe(1);
    expect(readFileSync(join(root, "nen", "contract.json"), "utf8")).toBe(theirs);
    expect(result.out.join("\n")).toMatch(/refused: nen\/contract\.json/);
    // And the block it would have written is still printed, to paste or diff.
    expect(result.out.join("\n")).toMatch(/"nen\.contract\/v0\.1"/);
  });

  it("is idempotent: a second run changes nothing and says so per item", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const first = await capture(["scaffold", "init", "--accept-detected", "--directories", "src", ...TRAILERS], root);
    expect(first.code).toBe(0);
    const after = tree(root);
    const second = await capture(["scaffold", "init", "--accept-detected", "--directories", "src", ...TRAILERS], root);
    expect(second.code).toBe(0);
    expect(tree(root)).toEqual(after);
    expect(second.out[0]).toBe("created directories: (none -- all already existed)");
    for (const path of [
      ".git/hooks/commit-msg",
      "nen/contract.json",
      ".github/workflows/nen-shu.yml",
      ".gitignore",
    ]) {
      expect(second.out.join("\n"), path).toContain(`skipped: ${path}`);
    }
  });

  it("prints detect's withheld-row notes, so the open questions are visible", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(["scaffold", "init", "--accept-detected", ...TRAILERS], root);
    expect(result.out.join("\n")).toMatch(/a lane's NAME is proposed/);
  });
});

describe("--stack narrows, and never invents a command", () => {
  it("takes only the named stack's lanes out of a mixed tree", async () => {
    const root = tempCopy(markerTree("ambiguous"));
    const all = detect(root, "linux");
    expect(new Set(all.lanes.map((lane): string => lane.stack)).size).toBeGreaterThan(1);
    await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    const written = JSON.parse(readFileSync(join(root, "nen", "contract.json"), "utf8")) as {
      project: { lanes: Record<string, { stack: string }> };
    };
    for (const lane of Object.values(written.project.lanes)) expect(lane.stack).toBe("nextjs");
  });

  it("declares an EMPTY verb map when no marker answered for the stated stack", async () => {
    const root = tempCopy(EMPTY_TREE);
    const result = await capture(["scaffold", "init", "--stack", "gatsby", ...TRAILERS], root);
    expect(result.code).toBe(0);
    const written = JSON.parse(readFileSync(join(root, "nen", "contract.json"), "utf8")) as {
      project: { lanes: Record<string, unknown>; verbs: Record<string, unknown> };
    };
    expect(Object.keys(written.project.lanes)).toEqual(["gatsby"]);
    expect(written.project.verbs["gatsby"]).toEqual({});
    expect(result.out.join("\n")).toMatch(/every row here is yours to write/);
  });
});

// ── the schemas/ -> nen/ migration ──────────────────────────────────────────

function seedLegacy(root: string, body: string, where: "schemas" | "nen" = "schemas"): string {
  const path = join(root, where, "labels.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
  return path;
}

describe("the schemas/ -> nen/ migration is a COPY", () => {
  it("copies each legacy file and LEAVES THE ORIGINAL, printing the removal command", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const legacy = seedLegacy(root, '{"labels":[]}\n');
    const result = await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    expect(result.code).toBe(0);
    // THE MUTATION THIS CATCHES: a migration that moved instead of copying.
    expect(existsSync(legacy)).toBe(true);
    expect(readFileSync(join(root, "nen", "labels.json"), "utf8")).toBe('{"labels":[]}\n');
    expect(result.out.join("\n")).toMatch(/git rm schemas\/labels\.json/);
    expect(result.out.join("\n")).toMatch(/migrated: schemas\/labels\.json -> nen\/labels\.json/);
  });

  it("skips a pair that is already byte-identical, and says the removal is all that is left", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    seedLegacy(root, '{"labels":[]}\n');
    seedLegacy(root, '{"labels":[]}\n', "nen");
    const result = await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/\(skipped\)/);
    expect(result.out.join("\n")).toMatch(/git rm schemas\/labels\.json/);
  });

  it("REFUSES a pair whose bytes differ, naming both paths, and touches neither", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    seedLegacy(root, '{"labels":["legacy"]}\n');
    seedLegacy(root, '{"labels":["current"]}\n', "nen");
    const result = await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/schemas\/labels\.json/);
    expect(result.out.join("\n")).toMatch(/nen\/labels\.json/);
    expect(readFileSync(join(root, "schemas", "labels.json"), "utf8")).toBe('{"labels":["legacy"]}\n');
    expect(readFileSync(join(root, "nen", "labels.json"), "utf8")).toBe('{"labels":["current"]}\n');
  });

  it("covers exactly the files the LOADER still falls back for, and no others", async () => {
    // BOTH DIRECTIONS, AND NEITHER IS THE LIST COMPARED TO ITSELF. The set is
    // computed against `resolveSchemaFile`'s own answer for each of the five
    // canonical paths, so a hand-written list re-introduced here -- which is
    // the drift this guards -- fails whichever way it is wrong: a file the
    // loader still falls back for that the scaffold stopped copying (a
    // repository that keeps working by fallback and never finishes migrating),
    // or one it copies that no released nen ever read from `schemas/`.
    const root = tempEmpty();
    const hasLegacy = (file: string): boolean => resolveSchemaFile(root, file).legacy !== null;
    const everyTaxonomyFile = [LABELS_FILE, REPOS_FILE, COLORS_FILE, GATES_FILE, CONTRACT_FILE];
    expect([...MIGRATED_FILES].sort()).toEqual(everyTaxonomyFile.filter(hasLegacy).sort());
    expect([...MIGRATED_FILES]).toEqual([...LEGACY_MIGRATABLE_FILES]);
    expect(MIGRATED_FILES.length).toBeGreaterThan(0);
    // And the one file with no legacy location is not in it: no released nen
    // ever looked for a contract under `schemas/`, and migrating one would
    // invent a claim over a filename in a directory nen no longer owns.
    expect(MIGRATED_FILES).not.toContain(CONTRACT_FILE);
  });

  it("has nothing to say about a repository with no schemas/ at all", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(["scaffold", "init", "--stack", "nextjs", "--json", ...TRAILERS], root);
    expect((JSON.parse(result.out.join("\n")) as { migrated: unknown[] }).migrated).toEqual([]);
  });
});

// ── the CI workflow ─────────────────────────────────────────────────────────

describe("the stack's CI workflow", () => {
  it("is added from the template the catalogue names, and pins nen by ref", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    const body = readFileSync(join(root, ".github", "workflows", "nen-shu.yml"), "utf8");
    expect(body).toContain("runs-on: ubuntu-latest");
    expect(body).toMatch(/NEN_REF: v\d+\.\d+\.\d+/);
    expect(body).not.toContain("{{");
  });

  it("takes the ref from the repository's OWN dependency block when it has one", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    mkdirSync(join(root, "nen"), { recursive: true });
    // A declaration with a dependency block and no project block: the project
    // write is refused (it is a file that exists) and the CI ref still comes
    // from what this repository already decided.
    cpSync(
      join(process.cwd(), "src", "schema", "fixtures", "shu-tools-repo", "nen", "contract.json"),
      join(root, "nen", "contract.json"),
    );
    await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    expect(readFileSync(join(root, ".github", "workflows", "nen-shu.yml"), "utf8")).toContain(
      "NEN_REF: v0.3.0",
    );
  });

  it("skips an identical workflow and REFUSES a different one, with no --force", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    const second = await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    expect(second.code).toBe(0);
    expect(second.out.join("\n")).toMatch(/skipped: \.github\/workflows\/nen-shu\.yml/);

    const theirs = "name: theirs\non: push\n";
    writeFileSync(join(root, ".github", "workflows", "nen-shu.yml"), theirs, "utf8");
    const third = await capture(["scaffold", "init", "--stack", "nextjs", "--force", ...TRAILERS], root);
    expect(third.code).toBe(1);
    expect(readFileSync(join(root, ".github", "workflows", "nen-shu.yml"), "utf8")).toBe(theirs);
  });

  it("adds none for a stack the catalogue proposes no template for, and says so", async () => {
    const root = tempCopy(EMPTY_TREE);
    const result = await capture(["scaffold", "init", "--stack", "dotnet-winui", ...TRAILERS], root);
    expect(result.code).toBe(0);
    expect(existsSync(join(root, ".github"))).toBe(false);
    expect(result.out.join("\n")).toMatch(/no CI workflow/);
  });
});

// ── .gitignore upkeep ───────────────────────────────────────────────────────

describe(".gitignore upkeep", () => {
  it("creates one when there is none", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".nen/");
  });

  it("APPENDS to an existing one and never reorders what is already there", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const theirs = "node_modules\n.env\n";
    writeFileSync(join(root, ".gitignore"), theirs, "utf8");
    await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    const after = readFileSync(join(root, ".gitignore"), "utf8");
    expect(after.startsWith(theirs)).toBe(true);
    expect(after).toContain(".nen/");
  });

  it("adds nothing when BOTH entries are already there", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const theirs = "dist\n.nen/\nReports/\n";
    writeFileSync(join(root, ".gitignore"), theirs, "utf8");
    await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(theirs);
  });

  it("appends a newline first when the file did not end with one", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    writeFileSync(join(root, ".gitignore"), "dist", "utf8");
    await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    expect(readFileSync(join(root, ".gitignore"), "utf8").split("\n")[0]).toBe("dist");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("\n.nen/\n");
  });
});

// ── --dry-run ───────────────────────────────────────────────────────────────

describe("--dry-run writes nothing and spawns nothing", () => {
  it("leaves the tree byte-identical, and never calls the seam", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const before = tree(root);
    // A seam whose every call throws: a probe here would fail the test rather
    // than pass unnoticed.
    const result = await capture(
      ["scaffold", "init", "--accept-detected", "--dry-run", "--directories", "src", ...TRAILERS],
      root,
      refusingSeams(),
    );
    expect(result.code).toBe(0);
    expect(tree(root)).toEqual(before);
    expect(result.out.join("\n")).toMatch(/would-create: nen\/contract\.json/);
    expect(result.out.join("\n")).toMatch(/would check/);
    // Not one line of this report may claim a write happened -- including the
    // directory line, which is v0.2.0's wording in every other form.
    expect(result.out[0]).toMatch(/^would create directories: /);
    expect(result.out.join("\n")).not.toMatch(/^created/m);
    expect(result.out[1]).toMatch(/^hook: would-install /);
  });

  it("reports the toolchain step as 'would check' rather than checking", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(
      ["scaffold", "init", "--stack", "nextjs", "--dry-run", "--json", ...TRAILERS],
      root,
      refusingSeams(),
    );
    expect((JSON.parse(result.out.join("\n")) as { tools: unknown }).tools).toBeNull();
  });

  it("refuses --dry-run --install-tools: one says nothing happens, the other changes the host", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(
      ["scaffold", "init", "--stack", "nextjs", "--dry-run", "--install-tools", ...TRAILERS],
      root,
      refusingSeams(),
    );
    expect(result.code).toBe(2);
  });
});

// ── the closing toolchain check ─────────────────────────────────────────────

/**
 * A repository that already declares ONE installable toolchain entry.
 *
 * Written here rather than copied from a fixture because the subject is one
 * narrow question -- does `scaffold init` reach the installer, and only when
 * told to -- and a fixture built to exercise four installers at once answers
 * it with "no, because an unrelated entry refused the whole run", which would
 * pass this test for the wrong reason.
 */
function toolchainRepo(): string {
  const root = tempEmpty();
  writeFileSync(join(root, "next.config.mjs"), "export default {};\n", "utf8");
  writeFileSync(join(root, "package.json"), '{"name":"t","private":true}\n', "utf8");
  mkdirSync(join(root, "nen"), { recursive: true });
  writeFileSync(
    join(root, "nen", "contract.json"),
    `${JSON.stringify(
      {
        $schema: "nen.contract/v0.1",
        project: {
          lanes: { web: { stack: "nextjs", cwd: "." } },
          defaultLane: "web",
          verbs: { web: { build: { unsupported: "not this test's subject" } } },
          toolchain: {
            pnpm: {
              version: "9.15.9",
              probe: ["pnpm", "--version"],
              versionFrom: "first-semver-on-stdout",
              installer: "corepack",
              why: "the one installer this release enables.",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return root;
}

describe("the closing toolchain check", () => {
  it("runs `shu tools` in CHECK mode and prints its table plus the --install command", async () => {
    const root = toolchainRepo();
    const spawned: string[] = [];
    const result = await capture(
      ["scaffold", "init", "--stack", "nextjs", ...TRAILERS],
      root,
      recordingSeams(spawned, { code: 0, stdout: "1.0.0\n" }),
    );
    // The declaration already exists, so that one write is refused -- and the
    // host is still checked, because scaffolding and the host are two questions.
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/mode:\s+check/);
    // `shu tools`'s OWN advice, relayed rather than re-worded: the two lines it
    // writes when the check did not pass, including the `--install` command
    // this verb names and never runs.
    expect(result.out.join("\n")).toMatch(/nen shu tools --repo .* --install --dry-run/);
    expect(result.out.join("\n")).toMatch(/nen shu tools --repo .* --install {2,}# run them/);
    expect(spawned.length).toBeGreaterThan(0);
  });

  it("INSTALLS NOTHING without --install-tools", async () => {
    const root = toolchainRepo();
    const spawned: string[] = [];
    await capture(
      ["scaffold", "init", "--stack", "nextjs", ...TRAILERS],
      root,
      recordingSeams(spawned, { code: 0, stdout: "1.0.0\n" }),
    );
    // THE MUTATION THIS CATCHES: `--install-tools` implied. Every argv the seam
    // saw must be a version probe the declaration named, and none of them the
    // installer.
    expect(spawned.filter((line): boolean => line.startsWith("corepack"))).toEqual([]);
    expect(spawned.some((line): boolean => line.includes("--version"))).toBe(true);
  });

  it("--install-tools runs the install, and only then", async () => {
    const root = toolchainRepo();
    const spawned: string[] = [];
    await capture(
      ["scaffold", "init", "--stack", "nextjs", "--install-tools", ...TRAILERS],
      root,
      recordingSeams(spawned, { code: 0, stdout: "1.0.0\n" }),
    );
    expect(spawned).toContain("corepack enable");
    expect(spawned).toContain("corepack prepare pnpm@9.15.9 --activate");
  });

  it("says so, rather than crashing, when the check cannot report", async () => {
    // No declaration at all is written yet on a dry-run-free tree with a
    // refusing seam? No: this is the case where the contract IS written and
    // carries no toolchain, which is the common one after a first scaffold.
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(
      ["scaffold", "init", "--stack", "nextjs", ...TRAILERS],
      root,
      refusingSeams(),
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/tools:\s+\(none declared\)/);
  });
});

describe("the injected checker", () => {
  it("is called exactly once, with install=false unless --install-tools", () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const calls: boolean[] = [];
    const tools = (install: boolean): ToolsOutcome => {
      calls.push(install);
      return { report: { contract: "x" }, lines: ["checked"] };
    };
    scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: "nextjs", tools });
    expect(calls).toEqual([false]);
    scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: "nextjs", installTools: true, tools });
    expect(calls).toEqual([false, true]);
  });

  it("is not called at all on a dry run", () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const result = scaffoldInit({
      root,
      platform: "linux",
      directories: [],
      hook: HOOK,
      stack: "nextjs",
      dryRun: true,
      tools: (): ToolsOutcome => {
        throw new Error("a dry run must not check the host");
      },
    });
    expect(result.tools).toBeNull();
  });
});

// ── --json ──────────────────────────────────────────────────────────────────

describe("--json", () => {
  it("publishes init's keys in one order, with the contract string first", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(["scaffold", "init", "--stack", "nextjs", "--json", ...TRAILERS], root);
    const document = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(document)).toEqual(["contract", "writes", "migrated", "tools", "exitCode"]);
    expect(document["contract"]).toBe("nen.scaffold.init/v0.1");
    const writes = document["writes"] as { path: string; action: string; why: string }[];
    expect(Object.keys(writes[0] ?? {})).toEqual(["path", "action", "why"]);
  });

  it("publishes new's keys in the same order, with its own contract string", async () => {
    const dir = join(tempEmpty(), "fresh");
    const result = await capture(
      ["scaffold", "new", "--stack", "nextjs", "--name", "kro-site", "--dir", dir, "--json"],
      null,
    );
    const document = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(document)).toEqual(["contract", "writes", "migrated", "tools", "exitCode"]);
    expect(document["contract"]).toBe("nen.scaffold.new/v0.1");
    expect(document["tools"]).toBeNull();
    // Stdout is ONE document and nothing else; the post-steps -- prose the
    // shape has no field for -- are relayed to stderr rather than dropped.
    expect((): unknown => JSON.parse(result.out.join("\n"))).not.toThrow();
    expect(result.err.join("\n")).toMatch(/post-steps \(nen does NOT run these\):/);
    expect(result.err.join("\n")).toMatch(/git init/);
  });

  it("relays init's notes to stderr under --json, leaving stdout one document", async () => {
    const root = tempCopy(NEXTJS_MULTI);
    const result = await capture(["scaffold", "init", "--accept-detected", "--json", ...TRAILERS], root);
    expect((): unknown => JSON.parse(result.out.join("\n"))).not.toThrow();
    expect(result.err.join("\n")).toMatch(/defaultLane is null/);
  });
});

// ── nen scaffold new ────────────────────────────────────────────────────────

describe("nen scaffold new", () => {
  it("refuses a --dir that is not empty, with no --force and no merge", async () => {
    const dir = tempCopy(NEXTJS_SINGLE);
    const result = await capture(
      ["scaffold", "new", "--stack", "nextjs", "--name", "kro", "--dir", dir],
      null,
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is not empty/);
    expect(existsSync(join(dir, "nen"))).toBe(false);
  });

  it("writes a tree `nen shu detect` then recognises, with the declaration detect proposes", async () => {
    const dir = join(tempEmpty(), "kro-site");
    const result = await capture(
      ["scaffold", "new", "--stack", "nextjs", "--name", "kro-site", "--dir", dir],
      null,
    );
    expect(result.code).toBe(0);
    expect(tree(dir)).toEqual([
      ".git/",
      ".git/hooks/",
      ".git/hooks/pre-commit",
      ".github/",
      ".github/workflows/",
      ".github/workflows/nen-shu.yml",
      ".gitignore",
      "nen/",
      "nen/contract.json",
      "nen/workflow.json",
      "next.config.ts",
      "package.json",
    ]);
    // The declaration is detect's own proposal off the marker this verb wrote.
    const report = detect(dir, "linux");
    expect(report.lanes.map((lane): string => lane.stack)).toEqual(["nextjs"]);
    expect(JSON.parse(readFileSync(join(dir, "nen", "contract.json"), "utf8"))).toEqual(report.proposal);
    // {{name}} really was substituted, everywhere.
    expect(readFileSync(join(dir, "package.json"), "utf8")).toContain('"kro-site"');
    for (const file of tree(dir).filter((entry): boolean => !entry.endsWith("/"))) {
      expect(readFileSync(join(dir, file), "utf8"), file).not.toContain("{{");
    }
  });

  it("prints every post-step and RUNS NONE -- the seam is never called", async () => {
    const dir = join(tempEmpty(), "kro-site");
    const result = await capture(
      ["scaffold", "new", "--stack", "nextjs", "--name", "kro", "--dir", dir],
      null,
      refusingSeams(),
    );
    expect(result.code).toBe(0);
    const printed = result.out.join("\n");
    expect(printed).toMatch(/post-steps \(nen does NOT run these\):/);
    expect(printed).toMatch(/git init/);
    expect(printed).toMatch(/nen shu tools --repo/);
  });

  it("--dry-run prints the tree it would write and writes nothing", async () => {
    const parent = tempEmpty();
    const dir = join(parent, "kro-site");
    const result = await capture(
      ["scaffold", "new", "--stack", "nextjs", "--name", "kro", "--dir", dir, "--dry-run"],
      null,
      refusingSeams(),
    );
    expect(result.code).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(tree(parent)).toEqual([]);
    expect(result.out.join("\n")).toMatch(/would-create: next\.config\.ts/);
    expect(result.out.join("\n")).toMatch(/would-create: nen\/contract\.json/);
  });

  it("writes the hook when a trailer convention is stated, and names it as a post-step when not", async () => {
    const withHook = join(tempEmpty(), "a");
    await capture(["scaffold", "new", "--stack", "nextjs", "--name", "a", "--dir", withHook, ...TRAILERS], null);
    expect(readFileSync(join(withHook, ".git", "hooks", "commit-msg"), "utf8")).toContain("X-Agent");

    const without = join(tempEmpty(), "b");
    const result = await capture(["scaffold", "new", "--stack", "nextjs", "--name", "b", "--dir", without], null);
    // NO COMMIT-MSG HOOK WITHOUT THE CONVENTION IT WOULD ENFORCE -- but the
    // TRUNK GUARD is still written, because it enforces `branch.base` rather
    // than a trailer pair and every repository has a trunk.
    expect(existsSync(join(without, ".git", "hooks", "commit-msg"))).toBe(false);
    expect(existsSync(join(without, ".git", "hooks", "pre-commit"))).toBe(true);
    expect(result.out.join("\n")).toMatch(/scaffold init --repo .* --agent-trailer <key>/);
  });

  it("refuses a --name that would have to be escaped into a manifest", async () => {
    const dir = join(tempEmpty(), "x");
    const result = await capture(
      ["scaffold", "new", "--stack", "nextjs", "--name", 'a" , "evil": "1', "--dir", dir],
      null,
    );
    expect(result.code).toBe(2);
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses a stack whose marker nen cannot honestly write, naming the way forward", async () => {
    for (const stack of ["gradle-android", "xcode-ios"]) {
      const dir = join(tempEmpty(), stack);
      const result = await capture(
        ["scaffold", "new", "--stack", stack, "--name", "app", "--dir", dir],
        null,
      );
      expect(result.code, stack).toBe(2);
      expect(result.err.join("\n")).toMatch(/scaffold init --repo/);
      expect(existsSync(dir)).toBe(false);
    }
  });

  it("refuses a stack the catalogue proposes no template for", async () => {
    const dir = join(tempEmpty(), "x");
    const result = await capture(
      ["scaffold", "new", "--stack", "dotnet-winui", "--name", "app", "--dir", dir],
      null,
    );
    expect(result.code).toBe(2);
    expect(existsSync(dir)).toBe(false);
  });

  it("writes a declaration `nen shu` reads and answers from, without a second chore", async () => {
    // THE CLAIM, STATED EXACTLY. `scaffold new` writes the nen-owned slice; it
    // does not write a framework's own project, so every command row of the
    // declaration it produces is a WITHHELD SEAT -- nen cross-checked each one
    // against this tree and could confirm none, which is the honest answer for
    // a tree with a marker and no dependencies yet.
    //
    // So the assertion is not "the build runs": it is that `nen shu` reads this
    // declaration, resolves the lane, and answers from the repository's own
    // words -- exit 4, "this lane declares no 'build'" -- rather than failing
    // to parse, refusing the tree, or (worst) substituting a plausible command.
    // The generated CI file tolerates exactly this code for exactly this
    // reason. `init` on a complete tree is where a row becomes a command, and
    // the case below that one is what proves it.
    const dir = join(tempEmpty(), "kro-site");
    await capture(["scaffold", "new", "--stack", "nextjs", "--name", "kro-site", "--dir", dir], null);
    const result = await runShu(["shu", "build", "--dry-run"], dir);
    expect(result.code).toBe(4);
    expect(result.err.join("\n")).toMatch(/lane 'nextjs' \(nextjs\) declares no 'build'/);
  });

  it("and on a COMPLETE tree, `scaffold init` produces a declaration `shu build --dry-run` runs", async () => {
    // The other end of the same claim, on a repository that carries what a
    // build needs: `scaffold init --accept-detected` and then `shu build
    // --dry-run` prints the argv the declaration states, spawning nothing --
    // the seam here refuses every call.
    const root = tempCopy(NEXTJS_SINGLE);
    const scaffolded = await capture(["scaffold", "init", "--accept-detected", ...TRAILERS], root);
    expect(scaffolded.code).toBe(0);
    const result = await runShu(["shu", "build", "--dry-run"], root);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("turbo");
  });
});

// ── the ref the generated workflow pins ─────────────────────────────────────

describe("the CI workflow's NEN_REF is a ref that can actually run it", () => {
  const MINIMUM = minimumNenRef().ref;

  const refIn = (body: string): string => {
    const match = /NEN_REF: (v\d+\.\d+\.\d+)/.exec(body);
    expect(match, "the workflow must pin a ref").not.toBeNull();
    return (match as RegExpExecArray)[1] as string;
  };

  it("init writes the GREATER of this build's version and the declared minimum", async () => {
    // THE BLOCKER THIS CLOSES. While this build was v0.2.0, `git ls-tree
    // v0.2.0` had no src/shu at all -- so every repository this verb scaffolded
    // received a workflow whose bootstrap refuses at exit 6 and whose verbs
    // would not exist even if it did not. The written ref is pinned to be at
    // least the minimum, whatever version this build carries. From v0.3.0 the
    // two are the same number (this build IS the release the minimum names), so
    // the greater of them is computed here rather than written down -- a version
    // bump moves `VERSION` past the minimum and must not have to edit this test.
    const root = tempCopy(NEXTJS_SINGLE);
    await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    const body = readFileSync(join(root, ".github", "workflows", "nen-shu.yml"), "utf8");
    const greater = compareNenRefs(MINIMUM, `v${VERSION}`) >= 0 ? MINIMUM : `v${VERSION}`;
    expect(compareNenRefs(refIn(body), MINIMUM)).toBeGreaterThanOrEqual(0);
    expect(refIn(body)).toBe(greater);
    // The minimum names a release that exists, so it can never be ahead of the
    // binary that ships it (../scaffold/templates.test.ts holds the same line).
    expect(compareNenRefs(MINIMUM, `v${VERSION}`)).toBeLessThanOrEqual(0);
  });

  it("new writes the same ref, by the same rule", async () => {
    const dir = join(tempEmpty(), "kro-site");
    await capture(["scaffold", "new", "--stack", "nextjs", "--name", "kro", "--dir", dir], null);
    const body = readFileSync(join(dir, ".github", "workflows", "nen-shu.yml"), "utf8");
    expect(compareNenRefs(refIn(body), MINIMUM)).toBeGreaterThanOrEqual(0);
  });

  it("states the offline caveat EXACTLY when the written ref is not this build's own", async () => {
    // THE RULE, AND WHY IT CHANGED IN v0.3.0. The note exists because nen cannot
    // check offline that a release was published for a tag it writes -- and the
    // only ref it can vouch for is `v${VERSION}`, the one it is. While the
    // minimum named an unreleased version this fired on every run, so the test
    // asserted it unconditionally. On a build at or above the minimum the two
    // refs agree and the note would be telling a caller nen cannot verify its
    // own version. The invariant is the biconditional, held in both eras.
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    const printed = result.out.join("\n");
    const written = refIn(readFileSync(join(root, ".github", "workflows", "nen-shu.yml"), "utf8"));
    expect(written).toBe(compareNenRefs(MINIMUM, `v${VERSION}`) >= 0 ? MINIMUM : `v${VERSION}`);
    expect(printed.includes("cannot verify offline")).toBe(written !== `v${VERSION}`);
  });

  it("says out loud that it cannot verify offline a release exists for a ref that is not its own", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(
      ["scaffold", "init", "--stack", "nextjs", "--nen-ref", "v9.9.9", ...TRAILERS],
      root,
    );
    const printed = result.out.join("\n");
    expect(printed).toContain("v9.9.9");
    expect(printed).toContain("cannot verify offline");
    // The README's own sentence about what happens when a tag has no release.
    expect(printed).toContain("exit 6");
    expect(printed).toContain("SHA256SUMS");
  });

  it("--nen-ref states one, and it is what lands in the file", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(
      ["scaffold", "init", "--stack", "nextjs", "--nen-ref", "v9.9.9", ...TRAILERS],
      root,
    );
    expect(result.code).toBe(0);
    expect(readFileSync(join(root, ".github", "workflows", "nen-shu.yml"), "utf8")).toContain(
      "NEN_REF: v9.9.9",
    );
  });

  it("refuses a --nen-ref BELOW the minimum, naming both refs, before any write", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const before = tree(root);
    const result = await capture(
      ["scaffold", "init", "--stack", "nextjs", "--nen-ref", "v0.1.0", ...TRAILERS],
      root,
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("--nen-ref 'v0.1.0'");
    expect(result.err.join("\n")).toContain(MINIMUM);
    expect(tree(root)).toEqual(before);
  });

  it("refuses a --nen-ref that is not a tag at all", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    for (const bad of ["main", "0.3.0", "v0.3", "v0.3.0-rc1", "../x"]) {
      const result = await capture(
        ["scaffold", "init", "--stack", "nextjs", "--nen-ref", bad, ...TRAILERS],
        root,
      );
      expect(result.code, bad).toBe(2);
      expect(result.err.join("\n")).toContain("vX.Y.Z");
    }
  });

  it("`scaffold new` takes --nen-ref too, and refuses one below the minimum", async () => {
    const dir = join(tempEmpty(), "kro-site");
    const refused = await capture(
      ["scaffold", "new", "--stack", "nextjs", "--name", "kro", "--dir", dir, "--nen-ref", "v0.0.1"],
      null,
    );
    expect(refused.code).toBe(2);
    expect(existsSync(dir)).toBe(false);
  });

  it("lifts a repository's OWN pin to the minimum, and says which pin it lifted", async () => {
    // A repository that pinned an older nen decided something, and nen does not
    // silently re-pin it -- but a workflow written at that ref cannot run, so
    // the write is at the minimum and the note names the declaration to fix.
    const root = tempCopy(NEXTJS_SINGLE);
    mkdirSync(join(root, "nen"), { recursive: true });
    const fixture = JSON.parse(
      readFileSync(
        join(process.cwd(), "src", "schema", "fixtures", "shu-tools-repo", "nen", "contract.json"),
        "utf8",
      ),
    ) as { dependency: Record<string, unknown> };
    writeFileSync(
      join(root, "nen", "contract.json"),
      `${JSON.stringify(
        {
          $schema: "nen.contract/v0.1",
          dependency: { ...fixture.dependency, minimum: "0.1", pinned_ref: "v0.1.0" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const result = await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    const body = readFileSync(join(root, ".github", "workflows", "nen-shu.yml"), "utf8");
    expect(refIn(body)).toBe(MINIMUM);
    expect(result.out.join("\n")).toContain("v0.1.0");
    expect(result.out.join("\n")).toContain("re-pin the declaration");
  });
});

// ── every write stays inside the repository ─────────────────────────────────

describe("containment: nen writes only inside the tree --repo pointed at", () => {
  for (const [flag, value] of [
    ["--hook-path", join("..", "outside", "evil-hook")],
    ["--canon-values-path", join("..", "outside", "values.yml")],
  ] as const) {
    it(`refuses ${flag} pointing out of the repository, at exit 2, before any write`, async () => {
      // BOTH FLAGS USED TO `join(root, value)` AND WRITE. `--hook-path` put an
      // EXECUTABLE one directory above --repo and reported exit 0.
      const parent = tempEmpty();
      const root = join(parent, "repo");
      cpSync(NEXTJS_SINGLE, root, { recursive: true });
      const before = tree(root);
      const result = await capture(
        ["scaffold", "init", "--stack", "nextjs", flag, value, ...TRAILERS],
        root,
      );
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toContain(flag);
      expect(result.err.join("\n")).toContain("outside the repository");
      // Nothing written, inside or out.
      expect(tree(root)).toEqual(before);
      expect(existsSync(join(parent, "outside"))).toBe(false);
    });

    it(`refuses ${flag} given an ABSOLUTE path outside the repository`, async () => {
      const parent = tempEmpty();
      const root = join(parent, "repo");
      cpSync(NEXTJS_SINGLE, root, { recursive: true });
      const outside = join(parent, "elsewhere", "x");
      const result = await capture(
        ["scaffold", "init", "--stack", "nextjs", flag, outside, ...TRAILERS],
        root,
      );
      expect(result.code).toBe(2);
      expect(existsSync(join(parent, "elsewhere"))).toBe(false);
    });
  }

  it("still accepts a path that merely LOOKS like an escape but stays inside", async () => {
    // `..something` is a legitimate entry name, and a `rel.startsWith("..")`
    // check would refuse it. The rule is ../repo/contain.ts's, shared with shu.
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(
      ["scaffold", "init", "--stack", "nextjs", "--canon-values-path", "..values/x.yml", ...TRAILERS],
      root,
    );
    expect(result.code).toBe(0);
    expect(existsSync(join(root, "..values", "x.yml"))).toBe(true);
  });

  it("accepts a nested path inside the repository, as it always did", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const result = await capture(
      ["scaffold", "init", "--stack", "nextjs", "--hook-path", "custom/hooks/commit-msg", ...TRAILERS],
      root,
    );
    expect(result.code).toBe(0);
    expect(existsSync(join(root, "custom", "hooks", "commit-msg"))).toBe(true);
  });

  for (const [directory, printed] of [
    ["nen", "nen/contract.json"],
    [join(".github", "workflows"), ".github/workflows/nen-shu.yml"],
  ] as const) {
    it(`refuses the ${printed} write when '${directory}' is a SYMLINK out of the tree`, async () => {
      // A LEXICAL CHECK PASSES HERE AND THE WRITE STILL LANDS OUTSIDE. Both of
      // these are directories this verb creates when they are absent; a symlink
      // in their place redirects the write while the report keeps printing the
      // repo-relative name.
      const parent = tempEmpty();
      const root = join(parent, "repo");
      cpSync(NEXTJS_SINGLE, root, { recursive: true });
      const target = join(parent, "outside");
      mkdirSync(target, { recursive: true });
      if (!linkable(join(root, "probe-link"), target)) return;
      mkdirSync(dirname(join(root, directory)), { recursive: true });
      symlinkSync(target, join(root, directory), "junction");

      const result = await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
      expect(result.code).toBe(1);
      const printedReport = result.out.join("\n");
      expect(printedReport).toContain("refused");
      // The refusal names the LINK and where it points -- the two facts a
      // caller needs to understand a report that otherwise looks right.
      expect(printedReport).toContain("is a symlink pointing at");
      expect(readdirSync(target)).toEqual([]);
    });
  }
});

// ── an fs failure is a row, not a crash ─────────────────────────────────────

describe("a filesystem refusal is reported, and the rest of the report survives", () => {
  it("records the errno, keeps every earlier write in the report, and exits 1", async () => {
    // A DIRECTORY WHERE A FILE GOES works on every platform, where a chmod
    // does not. Before this, the whole run threw: exit 1, EMPTY stdout under
    // --json, and four files already written that the caller never heard about.
    const root = tempCopy(NEXTJS_SINGLE);
    mkdirSync(join(root, ".gitignore"), { recursive: true });
    const result = await capture(["scaffold", "init", "--stack", "nextjs", "--json", ...TRAILERS], root);
    expect(result.code).toBe(1);
    const document = JSON.parse(result.out.join("\n")) as {
      writes: { path: string; action: string; why: string }[];
    };
    const row = document.writes.find((write): boolean => write.path === ".gitignore");
    expect(row?.action).toBe("refused");
    expect(row?.why).toMatch(/EISDIR|EPERM|EACCES|EBUSY/);
    // The steps that ran BEFORE it are still in the report, which is the whole
    // point: the caller can see what is on disk.
    expect(document.writes.some((write): boolean => write.path === "nen/contract.json")).toBe(true);
    expect(existsSync(join(root, "nen", "contract.json"))).toBe(true);
  });

  it("records the errno of a WRITE the filesystem rejected, and keeps going", async () => {
    // A FILE where a directory has to go: `mkdirSync` refuses it on every
    // platform, which is what makes this the portable way to fail a write
    // mid-run. Two steps fail here -- the declaration and the workflow -- and
    // both must be rows, with the steps after them still performed.
    const root = tempCopy(NEXTJS_SINGLE);
    writeFileSync(join(root, "nen"), "not a directory\n", "utf8");
    writeFileSync(join(root, ".github"), "not a directory\n", "utf8");
    const result = await capture(["scaffold", "init", "--stack", "nextjs", "--json", ...TRAILERS], root);
    expect(result.code).toBe(1);
    const document = JSON.parse(result.out.join("\n")) as {
      writes: { path: string; action: string; why: string }[];
    };
    for (const path of ["nen/contract.json", ".github/workflows/nen-shu.yml"]) {
      const row = document.writes.find((write): boolean => write.path === path);
      expect(row?.action, path).toBe("refused");
      expect(row?.why, path).toMatch(/EEXIST|ENOTDIR|EACCES|EPERM/);
    }
    // ...and the step AFTER them still ran, which is the whole point of the
    // report surviving: `.gitignore` is created and reported.
    expect(document.writes.find((write): boolean => write.path === ".gitignore")?.action).toBe("created");
    expect(existsSync(join(root, ".gitignore"))).toBe(true);
  });

  it("a refused row is published in --json's writes[], never filtered out", async () => {
    // The mutation this kills: filtering `refused` out of the document. A
    // report that only lists what succeeded is a report that says "done".
    const root = tempCopy(NEXTJS_SINGLE);
    await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    writeFileSync(join(root, ".github", "workflows", "nen-shu.yml"), "name: theirs\n", "utf8");
    const result = await capture(["scaffold", "init", "--stack", "nextjs", "--json", ...TRAILERS], root);
    expect(result.code).toBe(1);
    const document = JSON.parse(result.out.join("\n")) as {
      writes: { path: string; action: string }[];
      exitCode: number;
    };
    expect(
      document.writes.filter((write): boolean => write.action === "refused").map((w): string => w.path),
    ).toContain(".github/workflows/nen-shu.yml");
    expect(document.exitCode).toBe(1);
  });
});

// ── .gitignore is APPENDED to, byte for byte ────────────────────────────────

describe(".gitignore upkeep preserves the file it is appending to", () => {
  it("leaves a CRLF file's own bytes and line endings alone", async () => {
    // Reading through a CRLF-normalising reader and writing the result back
    // rewrote the whole file -- every line of it -- under a comment promising
    // the file is never rewritten.
    const root = tempCopy(NEXTJS_SINGLE);
    const theirs = "node_modules\r\n.env\r\n";
    writeFileSync(join(root, ".gitignore"), theirs, "utf8");
    await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    const after = readFileSync(join(root, ".gitignore"), "utf8");
    expect(after.startsWith(theirs), "the caller's own bytes must survive verbatim").toBe(true);
    // ...and the appended line matches the file's own ending, not the host's.
    expect(after).toContain("\r\n.nen/\r\n");
    expect(after).not.toContain("\n.nen/\n\n");
    expect(after.split("\n").every((line): boolean => line === "" || line.endsWith("\r"))).toBe(true);
  });

  it("recognises entries that are already there in a CRLF file, and adds nothing", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const theirs = "dist\r\n.nen/\r\nReports/\r\n";
    writeFileSync(join(root, ".gitignore"), theirs, "utf8");
    await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(theirs);
  });

  it("says 'would-append' on a dry run over an existing file, and 'would-create' over none", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const bare = await capture(["scaffold", "init", "--stack", "nextjs", "--dry-run", ...TRAILERS], root);
    expect(bare.out.join("\n")).toContain("would-create: .gitignore");
    writeFileSync(join(root, ".gitignore"), "dist\n", "utf8");
    const existing = await capture(
      ["scaffold", "init", "--stack", "nextjs", "--dry-run", ...TRAILERS],
      root,
    );
    expect(existing.out.join("\n")).toContain("would-append: .gitignore");
  });

  it("reports a real append as 'appended', not as 'created'", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    writeFileSync(join(root, ".gitignore"), "dist\n", "utf8");
    const result = await capture(["scaffold", "init", "--stack", "nextjs", "--json", ...TRAILERS], root);
    const document = JSON.parse(result.out.join("\n")) as { writes: { path: string; action: string }[] };
    expect(document.writes.find((write): boolean => write.path === ".gitignore")?.action).toBe("appended");
  });
});

// ── the migration never follows a link ──────────────────────────────────────

describe("the schemas/ -> nen/ migration refuses a SYMLINKED source", () => {
  it("names both paths, copies nothing, and never tells the caller to stage it", async () => {
    // `copyFileSync` follows the link: `schemas/labels.json ->
    // ../../outside/secret.json` was copied INTO the repository under a
    // taxonomy file's name, and the printed next step said `git add nen/`.
    const parent = tempEmpty();
    const root = join(parent, "repo");
    cpSync(EMPTY_TREE, root, { recursive: true });
    const secret = join(parent, "secret.json");
    writeFileSync(secret, `${JSON.stringify({ secret: true })}\n`, "utf8");
    mkdirSync(join(root, "schemas"), { recursive: true });
    if (!linkable(join(root, "probe-link"), secret)) return;
    // LABELS_FILE is the CANONICAL spelling (`nen/labels.json`); the legacy
    // location this migration reads is the same basename under `schemas/`.
    const basename = LABELS_FILE.split("/").at(-1) as string;
    symlinkSync(secret, join(root, "schemas", basename));

    const result = await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    expect(result.code).toBe(1);
    const printed = result.out.join("\n");
    expect(printed).toContain("is a SYMLINK");
    expect(printed).toContain(`schemas/${basename}`);
    expect(existsSync(join(root, "nen", basename))).toBe(false);
    // And the removal advice must not name a file whose copy never happened.
    expect(printed).not.toContain(`git rm schemas/${basename}`);
  });
});

// ── `scaffold new`'s own surface ────────────────────────────────────────────

describe("nen scaffold new, corrected", () => {
  it("writes an EXECUTABLE commit-msg hook, exactly as init does", async () => {
    // `git` silently skips a commit-msg hook that is not executable, so a hook
    // written 0644 reports `created` and enforces nothing. Both verbs now go
    // through one writer.
    const dir = join(tempEmpty(), "kro-site");
    const result = await capture(
      ["scaffold", "new", "--stack", "nextjs", "--name", "kro", "--dir", dir, ...TRAILERS],
      null,
    );
    expect(result.code).toBe(0);
    const hook = join(dir, ".git", "hooks", "commit-msg");
    expect(existsSync(hook)).toBe(true);
    expect(readFileSync(hook, "utf8")).toContain("X-Agent");
    if (process.platform === "win32") return; // no POSIX mode bits to assert
    expect(statSync(hook).mode & 0o111, "the hook must be executable").not.toBe(0);
  });

  it("init's hook is executable too, which is the property they now share", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    if (process.platform === "win32") return;
    expect(statSync(join(root, ".git", "hooks", "commit-msg")).mode & 0o111).not.toBe(0);
  });

  it("refuses a --name carrying a path separator or a traversal", async () => {
    // The name is spliced into two JSON manifests and would otherwise decide
    // where they land.
    for (const name of ["../x", "a/b", "..", "/abs", "a\\b", 'q"uote', "", "-lead"]) {
      const dir = join(tempEmpty(), "kro-site");
      const result = await capture(
        ["scaffold", "new", "--stack", "nextjs", "--name", name, "--dir", dir],
        null,
      );
      expect(result.code, `--name '${name}'`).toBe(2);
      expect(existsSync(dir), `--name '${name}' wrote a tree`).toBe(false);
    }
  });

  it("refuses a --dir that reads as an owner/name slug, naming the './' spelling", async () => {
    const result = await capture(
      ["scaffold", "new", "--stack", "nextjs", "--name", "kro", "--dir", "parity/nextjs"],
      null,
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("./parity/nextjs");
    expect(existsSync("parity")).toBe(false);
  });

  it("prints post-steps whose --repo value every verb accepts", async () => {
    // Seven of the eight post-steps pass --dir's value to --repo, and --repo
    // refuses a slug. A relative --dir is `./`-prefixed for exactly that.
    const parent = tempEmpty();
    const dir = join(parent, "a", "b", "c");
    const result = await capture(
      ["scaffold", "new", "--stack", "nextjs", "--name", "kro", "--dir", dir],
      null,
    );
    expect(result.code).toBe(0);
    for (const line of result.out) {
      const match = /--repo (\S+)/.exec(line);
      if (match?.[1] === undefined) continue;
      expect(looksLikeOwnerSlug(match[1]), `post-step names a slug: ${line}`).toBe(false);
    }
  });

  it("normalises a bare relative --dir to './...' in what it prints", () => {
    expect(postStepDir("a/b/c")).toBe("./a/b/c");
    expect(postStepDir("kro")).toBe("./kro");
    expect(postStepDir("./kro")).toBe("./kro");
    expect(postStepDir("../kro")).toBe("../kro");
    expect(postStepDir(join(tmpdir(), "kro"))).toBe(join(tmpdir(), "kro"));
    expect((): string => postStepDir("owner/name")).toThrow(/owner\/name slug/);
  });

  it("refuses an init-only flag rather than accepting and ignoring it", async () => {
    // The two verbs share one flag spec, so the argv reader accepts every init
    // flag here and hands it to a function that never reads it: --hook-path
    // used to write the hook to the default path and report success.
    for (const argv of [
      ["--hook-path", ".husky/commit-msg"],
      ["--force"],
      ["--install-tools"],
      ["--accept-detected"],
      ["--canon-values-path", "x.yml"],
      ["--scenario", "swiftui"],
      ["--directories", "src,tests"],
    ]) {
      const dir = join(tempEmpty(), "kro-site");
      const result = await capture(
        ["scaffold", "new", "--stack", "nextjs", "--name", "kro", "--dir", dir, ...argv],
        null,
      );
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.err.join("\n")).toContain(argv[0] as string);
      expect(existsSync(dir)).toBe(false);
    }
  });

  it("refuses --repo, which names a different directory than the one it writes", async () => {
    const dir = join(tempEmpty(), "kro-site");
    const result = await capture(
      ["scaffold", "new", "--stack", "nextjs", "--name", "kro", "--dir", dir],
      tempEmpty(),
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("--dir, not --repo");
    expect(existsSync(dir)).toBe(false);
  });
});

// ── the advice a caller is meant to paste ───────────────────────────────────

describe("the closing check names a verb this CLI actually has", () => {
  it("prints 'nen shu tools --repo <path>', with the family in it", async () => {
    // `argv.slice(1)` dropped the family and advised `nen tools --repo ...`.
    const root = tempCopy(EMPTY_TREE);
    const result = await capture(["scaffold", "init", "--stack", "nextjs", ...TRAILERS], root);
    const printed = [...result.out, ...result.err].join("\n");
    expect(printed).toContain("nen shu tools --repo");
    expect(printed).not.toMatch(/(?<!shu )nen tools --repo/);
  });
});

/** `nen shu <verb>` against a scaffolded tree, with a seam that must not run. */
async function runShu(argv: readonly string[], repo: string): Promise<Run> {
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
  const code = await runFamily(shuCommand, argv, repo, false, io, refusingSeams());
  return { code, out, err, spawned: [] };
}
