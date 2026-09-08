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
import { scaffoldCommand } from "./command.js";
import { MIGRATED_FILES, scaffoldInit, type ToolsOutcome } from "./init.js";

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
    expect(result.out[2]).toBe(`canon-values: ${join(root, ".claude", "canon-values.yml")}`);
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
      const expected = detect(root).proposal;
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
    const all = detect(root);
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

  it("adds nothing when the entry is already there", async () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const theirs = "dist\n.nen/\n";
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
    scaffoldInit({ root, directories: [], hook: HOOK, stack: "nextjs", tools });
    expect(calls).toEqual([false]);
    scaffoldInit({ root, directories: [], hook: HOOK, stack: "nextjs", installTools: true, tools });
    expect(calls).toEqual([false, true]);
  });

  it("is not called at all on a dry run", () => {
    const root = tempCopy(NEXTJS_SINGLE);
    const result = scaffoldInit({
      root,
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
      ".github/",
      ".github/workflows/",
      ".github/workflows/nen-shu.yml",
      ".gitignore",
      "nen/",
      "nen/contract.json",
      "next.config.ts",
      "package.json",
    ]);
    // The declaration is detect's own proposal off the marker this verb wrote.
    const report = detect(dir);
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
    expect(existsSync(join(without, ".git"))).toBe(false);
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
