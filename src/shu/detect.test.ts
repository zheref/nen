// src/shu/detect.test.ts -- the marker scan, against real fixture trees rather
// than a mocked filesystem: `detect` reads directories, and a test that stubbed
// `readdirSync` would prove only that the stub matches the assumptions of the
// code that calls it.
//
// EVERY ASSERTION HERE IS ABOUT A PROPOSAL. Nothing under ./fixtures/ carries a
// `nen/` directory, and the `--write` cases build their tree in a temp
// directory, so a run of this suite can never write into the checkout.

import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { loadProfilesPack, PLACEHOLDERS, profileById, verbCell } from "../profiles/pack.js";
import { detect, MARKER_STACKS, MAX_DEPTH, renderDetect } from "./detect.js";
import {
  EMPTY_TREE,
  GATSBY_SITE,
  markerTree,
  NEXTJS_MULTI,
  NEXTJS_PARTIAL,
  NEXTJS_SINGLE,
  NEXTJS_UNVERIFIED,
  NEXTJS_WORKSPACES,
} from "./fixtures/paths.js";
import { shuCommand } from "./command.js";

interface Captured {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
}

async function capture(argv: readonly string[], repo: string): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
  };
  const seams = new ScriptedSeams([], { platform: "linux" });
  const code = await runFamily(shuCommand, ["shu", ...argv], repo, false, io, seams);
  return { code, out, err };
}

interface Proposal {
  readonly $schema: string;
  readonly project: {
    readonly lanes: Readonly<Record<string, { stack: string; cwd: string }>>;
    readonly defaultLane: string | null;
    readonly verbs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly hosts: Readonly<Record<string, readonly string[]>>;
  };
}

/**
 * The two kinds of proposed row, split the way the reader has to read them.
 *
 * EVERY `commandVerbs` ROW IS NOW PROPOSED -- a cell the pack carries no command
 * for arrives as an explicit `{"unsupported": "<the pack's reason>"}` seat, so
 * that `--write` cannot produce the empty verb map ../schema/contract.ts
 * refuses. These two helpers exist so that an assertion about "what nen stands
 * behind as a command" stays an assertion about commands, rather than silently
 * becoming an assertion about the pack's row count.
 */
function commandRows(verbs: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  return Object.entries(verbs ?? {})
    .filter(([, row]): boolean => !(typeof row === "object" && row !== null && "unsupported" in row))
    .map(([verb]): string => verb)
    .sort();
}

function unsupportedRows(verbs: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  return Object.entries(verbs ?? {})
    .filter((entry): boolean => typeof entry[1] === "object" && entry[1] !== null && "unsupported" in entry[1])
    .map(([verb]): string => verb)
    .sort();
}

function reasonOf(verbs: Readonly<Record<string, unknown>> | undefined, verb: string): string {
  return String((verbs?.[verb] as { unsupported?: unknown } | undefined)?.unsupported ?? "");
}

describe("nen shu detect -- the nextjs lane, end to end", () => {
  it("proposes one lane at the root, with the pack's five reference verbs", () => {
    const report = detect(NEXTJS_SINGLE);
    expect(report.exitCode).toBe(0);
    expect(report.lanes).toHaveLength(1);
    expect(report.lanes[0]?.stack).toBe("nextjs");
    expect(report.lanes[0]?.cwd).toBe(".");
    expect(report.lanes[0]?.markers).toEqual(["next.config.mjs"]);
    expect(commandRows(report.lanes[0]?.verbs)).toEqual(["build", "dev", "lint", "run", "test"]);
    // And the four cells the pack carries no command for arrive as SEATS rather
    // than as absences: `coverage` is missing from both lists because this
    // fixture declares no `test:coverage` script, which is a withholding.
    expect(unsupportedRows(report.lanes[0]?.verbs)).toEqual([
      "archive",
      "deploy",
      "release",
      "ui-test",
    ]);
  });

  it("proposes the pack's own reason, verbatim, in every unsupported seat", () => {
    // The reason is QUOTED rather than summarised, because the executor prints
    // this same string back at exit 4 -- ./render.ts's unsupported refusal reads
    // `invocation.reason` -- so a sentence rewritten here is a sentence a
    // developer is later told is their repository's own.
    const pack = loadProfilesPack();
    const profile = profileById(pack, "nextjs");
    const verbs = detect(NEXTJS_SINGLE).lanes[0]?.verbs;
    for (const verb of unsupportedRows(verbs)) {
      const cell = verbCell(profile, verb);
      const packReason =
        cell.kind === "declared-only"
          ? cell.reason
          : cell.kind === "unsupported"
            ? cell.invocation.kind === "unsupported"
              ? cell.invocation.reason
              : ""
            : "";
      expect(packReason, verb).not.toBe("");
      expect(reasonOf(verbs, verb), verb).toBe(packReason);
    }
    // The two kinds, named: `release` is the pack saying a repository states
    // the answer out loud, and `deploy` is the pack declining to pick between
    // three observed shapes.
    expect(reasonOf(verbs, "release")).toMatch(/there is no package or store pipeline/);
    expect(reasonOf(verbs, "deploy")).toMatch(/THREE OBSERVED SHAPES, NONE A DEFAULT/);
  });

  it("writes a declaration whose every lane has at least one verb, which is the reader's rule", () => {
    // THE DEFECT THIS CLOSES, from the other side: a lane whose every command
    // row was withheld used to be written as `"verbs": { "<lane>": {} }`, and
    // ../schema/contract.ts refuses that file by name on the very next `nen shu
    // build`. A proposal that cannot be loaded is the failure ./detect.ts exists
    // to prevent, arrived at backwards.
    for (const tree of [NEXTJS_SINGLE, NEXTJS_UNVERIFIED, markerTree("gatsby"), markerTree("xcode")]) {
      const proposal = detect(tree).proposal as unknown as Proposal;
      for (const [lane, verbs] of Object.entries(proposal.project.verbs)) {
        expect(Object.keys(verbs).length, `${tree} / ${lane}`).toBeGreaterThan(0);
      }
    }
  });

  it("proposes the pack's argv with {pm} substituted from package.json, and nowhere else from", () => {
    const proposal = detect(NEXTJS_SINGLE).proposal as unknown as Proposal;
    const verbs = proposal.project.verbs["nextjs"] as Record<string, { exe?: string; argv?: string[]; steps?: { exe: string; argv: string[] }[] }>;
    // `{pm}` became `pnpm` because THIS FIXTURE's package.json says so. The
    // pack states the token; the repository states the value.
    expect(verbs["build"]).toMatchObject({ exe: "pnpm", argv: ["turbo", "run", "build"] });
    expect(verbs["test"]).toMatchObject({ exe: "pnpm", argv: ["turbo", "run", "test"] });
    expect(verbs["dev"]).toMatchObject({ exe: "pnpm", argv: ["turbo", "run", "dev"] });
    // A row the pack states with no token at all is proposed as it stands.
    expect(verbs["run"]).toMatchObject({ exe: "next", argv: ["start"] });
    // The two-step lint: the second command alone misses the repo-wide format
    // check, which is why the row is steps rather than one longer argv.
    expect(verbs["lint"]?.steps).toEqual([
      { exe: "pnpm", argv: ["exec", "biome", "check", "."] },
      { exe: "pnpm", argv: ["turbo", "run", "lint"] },
    ]);
    // AND NOT ONE PROPOSED ARGV CARRIES A PLACEHOLDER. This is the whole rule
    // stated over the output rather than over one row: a token nen could not
    // substitute is withheld, never shipped into somebody's declaration. It is
    // scoped to the COMMAND, not to the row: the pack's `why` is prose about
    // the token and quotes it on purpose.
    const commands = Object.values(verbs).flatMap((row): readonly string[] =>
      (row.steps ?? [{ exe: row.exe ?? "", argv: row.argv ?? [] }]).flatMap(
        (step): readonly string[] => [step.exe, ...step.argv],
      ),
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const token of commands) expect(token).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("substitutes only {pm} and {packageManager}, and they are the pack's own tokens", () => {
    // The two this verb answers are answered from the REPOSITORY's manifest,
    // never from the pack -- and they are members of the pack's closed set, so
    // a rename there fails here rather than silently stopping substitution.
    const tokens = PLACEHOLDERS.map((placeholder): string => placeholder.token);
    expect(tokens).toContain("{pm}");
    expect(tokens).toContain("{packageManager}");
  });

  it("answers only stacks the pack carries, and can reach every one of them", () => {
    const pack = loadProfilesPack();
    expect([...MARKER_STACKS].sort()).toEqual([...pack.ids].sort());
  });

  it("proposes a defaultLane only because there is exactly one lane", () => {
    const single = detect(NEXTJS_SINGLE).proposal as unknown as Proposal;
    expect(single.project.defaultLane).toBe("nextjs");
    const multi = detect(NEXTJS_MULTI).proposal as unknown as Proposal;
    expect(multi.project.defaultLane).toBeNull();
  });

  it("proposes hosts for the stack, and every COMMAND row carries the pack's why", () => {
    const proposal = detect(NEXTJS_SINGLE).proposal as unknown as Proposal;
    expect(proposal.project.hosts).toEqual({ "*": ["darwin", "linux", "win32"] });
    const verbs = proposal.project.verbs["nextjs"];
    for (const verb of commandRows(verbs)) {
      expect((verbs?.[verb] as { why?: string }).why, verb).toBeTruthy();
    }
    // An `unsupported` seat carries no `why`, and must not: the declaration's
    // reader takes the reason from the `unsupported` string itself, and a second
    // sentence beside it would be two answers to one question.
    for (const verb of unsupportedRows(verbs)) {
      expect(Object.keys(verbs?.[verb] as object), verb).toEqual(["unsupported"]);
    }
  });

  it("reports a Makefile as a finding and never as a proposed command", () => {
    const report = detect(NEXTJS_SINGLE);
    expect(report.notes.join("\n")).toMatch(/a Makefile sits beside a lane/);
    // The finding is in the notes; what must be free of it is the EXECUTABLE
    // side of every proposed row. (The pack's prose says why it never proposes
    // one, which is a `why` a human reads, not a command anything runs.)
    const proposal = detect(NEXTJS_SINGLE).proposal as unknown as Proposal;
    const verbs = proposal.project.verbs["nextjs"];
    for (const verb of commandRows(verbs)) {
      const row = verbs?.[verb] as { exe?: string; steps?: { exe: string }[] };
      const steps = row.steps ?? [{ exe: row.exe }];
      for (const step of steps) expect(step.exe).not.toMatch(/^make$/i);
    }
  });

  it("finds two lanes in one tree, names them after their directories, and chooses neither", () => {
    const report = detect(NEXTJS_MULTI);
    expect(report.lanes.map((lane): string => lane.lane).sort()).toEqual(["admin", "web"]);
    expect(report.lanes.map((lane): string => lane.cwd).sort()).toEqual(["admin", "web"]);
    expect(report.notes.join("\n")).toMatch(/--lane is required/);
  });
});

describe("nen shu detect -- the cross-checks that keep a proposal honest", () => {
  it("withholds every templated row when package.json states no packageManager", () => {
    const report = detect(NEXTJS_UNVERIFIED);
    expect(report.lanes).toHaveLength(1);
    expect(commandRows(report.lanes[0]?.verbs)).toEqual([]);
    const notes = report.lanes[0]?.notes.join("\n") ?? "";
    // Named, not merely counted: a reader has to be able to see WHICH token
    // stayed and where its value would have come from.
    expect(notes).toMatch(/'build' withheld: its reference command still names \{pm\}/);
    expect(notes).toMatch(/declares no 'packageManager' field/);
    // And the one untemplated row is withheld for its own, different reason.
    expect(notes).toMatch(/'run' withheld: it runs 'next'/);
  });

  it("derives the executable from a SCOPED packageManager pin using the LAST '@', not the first", () => {
    // A scoped manager's own name opens with '@' ('@scope/pm@1.2.3'), so
    // splitting on the FIRST '@' would hand back an empty executable. This
    // fixture pins '@scope/pm' the way a repo running a private, scoped
    // package manager would.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-scoped-pm-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          packageManager: "@scope/pm@1.2.3",
          scripts: {
            build: "placeholder",
            test: "placeholder",
            lint: "placeholder",
            dev: "placeholder",
          },
          devDependencies: {
            "@biomejs/biome": "1.9.4",
            next: "15.1.0",
            turbo: "2.3.3",
            vitest: "2.1.8",
          },
        }),
      );
      const report = detect(dir);
      const verbs = report.lanes[0]?.verbs as Record<
        string,
        { exe?: string; steps?: { exe: string }[] }
      >;
      expect(verbs["build"]?.exe).toBe("@scope/pm");
      expect(verbs["dev"]?.exe).toBe("@scope/pm");
      expect(verbs["lint"]?.steps?.every((step): boolean => step.exe === "@scope/pm")).toBe(
        true,
      );
      // Nothing named {pm} or {packageManager} is left withheld: the scoped
      // pin substituted cleanly.
      const notes = report.lanes[0]?.notes.join("\n") ?? "";
      expect(notes).not.toMatch(/withheld: its reference command still names \{pm\}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives the executable from an UNSCOPED packageManager pin ('pnpm@9.15.9' -> 'pnpm')", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-plain-pm-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@9.15.9",
          scripts: {
            build: "placeholder",
            test: "placeholder",
            lint: "placeholder",
            dev: "placeholder",
          },
          devDependencies: {
            "@biomejs/biome": "1.9.4",
            next: "15.1.0",
            turbo: "2.3.3",
            vitest: "2.1.8",
          },
        }),
      );
      const report = detect(dir);
      const verbs = report.lanes[0]?.verbs as Record<string, { exe?: string }>;
      expect(verbs["build"]?.exe).toBe("pnpm");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds every templated row, and names the reason, when the pin carries no '@version' (bare name)", () => {
    // 'pnpm' with no version at all -- the field IS declared, unlike the
    // "declares no 'packageManager' field" case above, but it is malformed:
    // nen refuses to guess an executable from a string it cannot split a
    // version off of, rather than silently treating the whole string as the
    // executable.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-bad-pm-noversion-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm" }));
      const report = detect(dir);
      expect(commandRows(report.lanes[0]?.verbs)).toEqual([]);
      const notes = report.lanes[0]?.notes.join("\n") ?? "";
      expect(notes).toMatch(/'build' withheld: its reference command still names \{pm\}/);
      expect(notes).toMatch(/carries no '@version' nen can split an executable from/);
      expect(notes).toMatch(/packageManager: "pnpm"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("also withholds, with the same reason, when the pin is a bare scope with no version ('@scope/pm')", () => {
    // Only one '@' in the whole pin, and it sits at index 0 -- there is no
    // version to its right either, so this is the same malformed case as a
    // bare name, not the scoped-and-versioned case above.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-bad-pm-scope-only-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "@scope/pm" }));
      const report = detect(dir);
      expect(commandRows(report.lanes[0]?.verbs)).toEqual([]);
      const notes = report.lanes[0]?.notes.join("\n") ?? "";
      expect(notes).toMatch(/carries no '@version' nen can split an executable from/);
      expect(notes).toMatch(/packageManager: "@scope\/pm"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds the verbs whose task package.json declares no script for, naming each", () => {
    const report = detect(NEXTJS_PARTIAL);
    // The tree declares `build` and `dev` as scripts and neither `test` nor
    // `lint`, so exactly those two rows are withheld -- and `run`, which names
    // no task at all, is proposed because its executable IS a dependency here.
    expect(commandRows(report.lanes[0]?.verbs)).toEqual(["build", "dev", "run"]);
    const notes = report.lanes[0]?.notes.join("\n") ?? "";
    expect(notes).toMatch(/'test' withheld: its reference command runs the task 'test'/);
    expect(notes).toMatch(/'lint' withheld: its reference command runs the task 'lint'/);
    expect(notes).toMatch(/a warning, never a proposal/);
  });

  it("proposes NOTHING for a manifest that declares a task runner and no scripts", () => {
    // The header's claim -- "never proposes a command the repository cannot
    // run" -- was false without this check: a manifest whose only script was
    // `lint` still got a proposed `build`.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-scripts-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@9.15.9",
          scripts: { lint: "placeholder" },
          devDependencies: { turbo: "2.3.3" },
        }),
      );
      const report = detect(dir);
      expect(commandRows(report.lanes[0]?.verbs)).toEqual(["lint"]);
      expect(report.lanes[0]?.notes.join("\n")).toMatch(
        /'build' withheld: its reference command runs the task 'build'/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds a row whose executable no manifest confirms, and says there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-nopkg-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      const report = detect(dir);
      expect(commandRows(report.lanes[0]?.verbs)).toEqual([]);
      expect(report.lanes[0]?.notes.join("\n")).toMatch(
        /'run' withheld: it runs 'next', and this lane has no readable package\.json/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the cells the pack itself proposes no command for, with the pack's own summary", () => {
    // Not a gap in the proposal: the pack declining to choose. A reader who
    // cannot tell those two apart writes the row nen was avoiding.
    const notes = detect(NEXTJS_SINGLE).lanes[0]?.notes.join("\n") ?? "";
    expect(notes).toMatch(/the reference pack proposes no command for/);
    expect(notes).toMatch(/ui-test \(two meanings\)/);
    expect(notes).toMatch(/release \(declared n\/a in the repo\)/);
    expect(notes).toMatch(/STACK-MATRIX\.md/);
  });

  it("proposes no row for a verb that is not one of the pack's commandVerbs", () => {
    // `detect`, `tools` and `warmup` are the three the index excludes: none is
    // an argv a lane declares, so a row for one would put a command where
    // nothing reads it.
    const pack = loadProfilesPack();
    const proposed = Object.keys(detect(NEXTJS_SINGLE).lanes[0]?.verbs ?? {});
    for (const verb of pack.verbs.filter((name): boolean => !pack.commandVerbs.includes(name))) {
      expect(proposed, verb).not.toContain(verb);
    }
  });

  it("treats a malformed package.json as unverifiable, not as a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-bad-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      writeFileSync(join(dir, "package.json"), "{ this is not json");
      const report = detect(dir);
      expect(report.lanes).toHaveLength(1);
      expect(commandRows(report.lanes[0]?.verbs)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nen shu detect -- one marker per stack", () => {
  const CASES: readonly { tree: string; stack: string; marker: string }[] = [
    { tree: "gatsby", stack: "gatsby", marker: "gatsby-config.js" },
    { tree: "expo", stack: "expo", marker: "app.json" },
    { tree: "xcode", stack: "xcode-ios", marker: "Placeholder.xcworkspace" },
    { tree: "gradle-android", stack: "gradle-android", marker: "app/build.gradle.kts" },
    { tree: "compose-desktop", stack: "compose-desktop", marker: "desktop/build.gradle.kts" },
    { tree: "winui", stack: "dotnet-winui", marker: "Placeholder.csproj" },
  ];

  for (const { tree, stack, marker } of CASES) {
    it(`answers '${stack}' for ${marker}, with an empty verb map and a reason per row`, () => {
      const report = detect(markerTree(tree));
      expect(report.lanes.map((lane): string => lane.stack)).toContain(stack);
      const lane = report.lanes.find((entry): boolean => entry.stack === stack);
      expect(lane?.markers).toEqual([marker]);
      // These six trees carry a marker and nothing else, so every command cell
      // the pack has for them is withheld -- and the lane is still proposed,
      // because the SHAPE of the declaration is what a human needs first.
      expect(commandRows(lane?.verbs)).toEqual([]);
      expect(lane?.notes.length, "a withheld map with no reason is the failure").toBeGreaterThan(0);
      for (const note of lane?.notes ?? []) {
        // Three shapes of note, and each is a REASON: a row withheld, the
        // pack declining to choose, and a toolchain requirement nen will not
        // turn into a precondition it would have to invent a value for.
        expect(note).toMatch(/withheld|proposes no command|no precondition is proposed/);
      }
    });
  }

  it("proposes the platforms each stack's toolchain can actually run on", () => {
    const apple = detect(markerTree("xcode")).proposal as unknown as Proposal;
    expect(apple.project.hosts).toEqual({ "*": ["darwin"] });
    const windows = detect(markerTree("winui")).proposal as unknown as Proposal;
    expect(windows.project.hosts).toEqual({ "*": ["win32"] });
  });

  // A .NET project is not a WinUI one. Proposing the narrower stack from the
  // broader marker would be nen deciding what kind of application this is.
  it("proposes nothing for a .csproj with no WinUI element", () => {
    expect(detect(markerTree("dotnet-plain")).lanes).toEqual([]);
  });

  it("never descends into an .xcworkspace bundle and finds itself again", () => {
    expect(detect(markerTree("xcode")).lanes).toHaveLength(1);
  });
});

describe("nen shu detect -- what the scan deliberately does not see", () => {
  // EACH OF THESE IS A BOUND, NOT A BUG -- and each was a surviving mutant
  // before it was a test: deleting the skip set, or widening the depth, left
  // the whole suite green. A bound nothing pins is a bound somebody removes.

  it("never proposes a lane from a marker inside a skipped directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-skip-"));
    try {
      mkdirSync(join(dir, "node_modules", "some-package"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "some-package", "next.config.js"), "module.exports = {};\n");
      expect(detect(dir).lanes).toEqual([]);
      // And the same marker one directory over IS found, so the assertion
      // above is about the skip and not about the fixture being empty.
      mkdirSync(join(dir, "app"));
      writeFileSync(join(dir, "app", "next.config.js"), "module.exports = {};\n");
      expect(detect(dir).lanes.map((lane): string => lane.cwd)).toEqual(["app"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("descends exactly three directories -- found at three, missed at four", () => {
    // THE NUMBERS ARE LITERAL, and the constant is asserted against a literal
    // too. Building the fixture out of `MAX_DEPTH` would make this test move
    // with the bound it is supposed to pin: lowering the constant to 1 lowered
    // the fixture with it and the test stayed green, which is the whole shape
    // of a self-referential assertion.
    expect(MAX_DEPTH).toBe(3);
    const marker = (dir: string, ...segments: readonly string[]): void => {
      const at = join(dir, ...segments);
      mkdirSync(at, { recursive: true });
      writeFileSync(join(at, "next.config.js"), "module.exports = {};\n");
    };

    const found = mkdtempSync(join(tmpdir(), "nen-detect-depth3-"));
    const missed = mkdtempSync(join(tmpdir(), "nen-detect-depth4-"));
    try {
      marker(found, "one", "two", "three");
      expect(detect(found).lanes.map((lane): string => lane.cwd)).toEqual(["one/two/three"]);

      marker(missed, "one", "two", "three", "four");
      const report = detect(missed);
      expect(report.lanes).toEqual([]);
      // The blind spot is NAMED in the output, because a silent miss and an
      // empty tree look identical to the person reading it.
      const rendered = renderDetect(report).join("\n");
      expect(rendered).toMatch(/descends at most 3 directories/);
      expect(rendered).toMatch(/node_modules/);
    } finally {
      rmSync(found, { recursive: true, force: true });
      rmSync(missed, { recursive: true, force: true });
    }
  });

  it("makes ONE lane out of a directory whose stack matched twice", () => {
    // Two spellings of one framework's config is one lane with two markers --
    // not two lanes, the second of which would take a name nobody could have
    // predicted from the tree.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-twice-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      writeFileSync(join(dir, "next.config.mjs"), "export default {};\n");
      const report = detect(dir);
      expect(report.lanes).toHaveLength(1);
      expect(report.lanes[0]?.markers).toEqual(["next.config.js", "next.config.mjs"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nen shu detect -- ambiguity is reported, never resolved", () => {
  it("proposes BOTH lanes for one directory carrying two stacks' markers", () => {
    const report = detect(markerTree("ambiguous"));
    expect(report.lanes.map((lane): string => lane.stack).sort()).toEqual(["gatsby", "nextjs"]);
    expect(report.notes.join("\n")).toMatch(/carries markers for 2 stacks/);
    expect(report.notes.join("\n")).toMatch(/neither is chosen/);
  });

  it("gives the two lanes distinct names, deterministically", () => {
    const first = detect(markerTree("ambiguous")).lanes.map((lane): string => lane.lane);
    const second = detect(markerTree("ambiguous")).lanes.map((lane): string => lane.lane);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });

  it("qualifies BOTH names in a subdirectory, never one bare and one qualified", () => {
    // `web` and `web-nextjs` was the old answer, and it is the wrong shape: one
    // of the two got the unqualified name for no reason a reader could see, and
    // which one got it depended on the stacks' sort order.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-names-"));
    try {
      cpSync(markerTree("ambiguous"), join(dir, "web"), { recursive: true });
      const report = detect(dir);
      expect(report.lanes.map((lane): string => lane.lane)).toEqual(["web-gatsby", "web-nextjs"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("proposes NO hosts block when the lanes need different platforms", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-hosts-"));
    try {
      cpSync(markerTree("gatsby"), join(dir, "site"), { recursive: true });
      cpSync(markerTree("xcode"), join(dir, "app"), { recursive: true });
      const report = detect(dir);
      expect((report.proposal as unknown as Proposal).project.hosts).toEqual({});
      expect(report.notes.join("\n")).toMatch(/keyed by VERB rather than by lane/);
      expect(report.notes.join("\n")).toMatch(/which would let a verb start on a host that cannot run it/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nen shu detect -- an empty tree", () => {
  it("proposes nothing and exits 1 with the reason", async () => {
    const report = detect(EMPTY_TREE);
    expect(report.lanes).toEqual([]);
    expect(report.proposal).toBeNull();
    expect(report.exitCode).toBe(1);

    const result = await capture(["detect"], EMPTY_TREE);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/no lane was detected/);
    expect(result.out.join("\n")).toMatch(/no lane detected/);
  });
});

describe("nen shu detect --write", () => {
  it("writes nen/contract.json when there is none, and the file parses back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-write-"));
    try {
      cpSync(NEXTJS_SINGLE, dir, { recursive: true });
      const result = await capture(["detect", "--write"], dir);
      expect(result.code).toBe(0);
      const written = join(dir, "nen", "contract.json");
      const parsed = JSON.parse(readFileSync(written, "utf8")) as Proposal;
      expect(parsed.$schema).toBe("nen.contract/v0.1");
      expect(parsed.project.defaultLane).toBe("nextjs");
      expect(result.out.join("\n")).toContain(`wrote ${written}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses rather than overwriting, and there is no --force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-over-"));
    try {
      cpSync(NEXTJS_SINGLE, dir, { recursive: true });
      mkdirSync(join(dir, "nen"));
      writeFileSync(join(dir, "nen", "contract.json"), '{"project": {"$comment": "a human wrote this"}}');
      const result = await capture(["detect", "--write"], dir);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/never overwrites a declaration/);
      expect(result.err.join("\n")).toMatch(/no --force/);
      // The file is untouched, and the block a human would merge is on stdout.
      expect(readFileSync(join(dir, "nen", "contract.json"), "utf8")).toContain("a human wrote this");
      expect(result.out.join("\n")).toContain('"$schema": "nen.contract/v0.1"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write a dependency-only file's neighbour too -- print and merge, not merge silently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-dep-"));
    try {
      cpSync(NEXTJS_SINGLE, dir, { recursive: true });
      mkdirSync(join(dir, "nen"));
      writeFileSync(join(dir, "nen", "contract.json"), '{"dependency": {"minimum": "0.3"}}');
      const result = await capture(["detect", "--write"], dir);
      expect(result.code).toBe(2);
      expect(readFileSync(join(dir, "nen", "contract.json"), "utf8")).toContain("dependency");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes NOTHING without --write, even where it could have", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-dry-"));
    try {
      cpSync(NEXTJS_SINGLE, dir, { recursive: true });
      const result = await capture(["detect"], dir);
      expect(result.code).toBe(0);
      expect(() => readFileSync(join(dir, "nen", "contract.json"), "utf8")).toThrow();
      expect(result.out.join("\n")).toMatch(/nothing was written -- pass --write/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses --write when nothing was detected, rather than writing an empty block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-empty-"));
    try {
      const result = await capture(["detect", "--write"], dir);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/nothing to write/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nen shu detect -- what it proposes can be run", () => {
  // The round trip that makes the two halves of this PR one feature: what
  // `detect` writes is a declaration the executor accepts, argv for argv.
  it("produces a declaration nen shu build renders back to the same argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-roundtrip-"));
    try {
      cpSync(NEXTJS_SINGLE, dir, { recursive: true });
      expect((await capture(["detect", "--write"], dir)).code).toBe(0);
      const built = await capture(["build", "--dry-run"], dir);
      expect(built.code).toBe(0);
      expect(built.out.join("\n")).toMatch(/would run: +pnpm turbo run build/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── the nextjs row set, completed ───────────────────────────────────────────
//
// The rows PR 2 taught the executor to honour by declaration but `detect` did
// not yet propose: the four cells the pack carries no command for, and
// `coverage`, whose whole difficulty is that the pack states it as a SHAPE run
// once per package rather than as one invocation.

describe("nen shu detect -- the nextjs workspace shape", () => {
  it("proposes one lane per workspace member that carries a marker, plus the root's own", () => {
    // A member WITHOUT a marker (packages/core) is a package, not a lane: it is
    // named in the root's coverage note and gets no lane of its own, because a
    // lane is a thing that can be built and that member declares no framework.
    const report = detect(NEXTJS_WORKSPACES);
    expect(report.lanes.map((lane): string => lane.lane)).toEqual(["nextjs", "admin", "web"]);
    expect(report.lanes.map((lane): string => lane.cwd)).toEqual([".", "apps/admin", "apps/web"]);
    expect(report.lanes.every((lane): boolean => lane.stack === "nextjs")).toBe(true);
    const proposal = report.proposal as unknown as Proposal;
    expect(proposal.project.defaultLane).toBeNull();
    expect(report.notes.join("\n")).toMatch(/3 lanes were found/);
  });

  it("proposes coverage for the member that declares the task, with {package} from its own name", () => {
    const verbs = detect(NEXTJS_WORKSPACES).lanes.find((lane): boolean => lane.lane === "web")?.verbs;
    expect(verbs?.["coverage"]).toMatchObject({
      exe: "pnpm",
      argv: ["--filter", "@placeholder/web", "test:coverage"],
    });
    // `{package}` is answered from THIS manifest's `name` and from nowhere
    // else -- not from the directory, not from the lane name, not from the pack.
    expect(commandRows(verbs)).toContain("coverage");
  });

  it("withholds coverage from a member that declares no such task, naming the task", () => {
    // THE MUTANT THIS KILLS: proposing the row on the strength of the package
    // name alone. `admin` answers `{package}` perfectly well and still cannot
    // run the command, because the task after the package name is one it does
    // not declare.
    const lane = detect(NEXTJS_WORKSPACES).lanes.find((entry): boolean => entry.lane === "admin");
    expect(commandRows(lane?.verbs)).not.toContain("coverage");
    expect(lane?.notes.join("\n")).toMatch(
      /'coverage' withheld: its reference command runs the task 'test:coverage', and this lane's package\.json declares no such script/,
    );
  });

  it("withholds coverage from the workspace ROOT and names the members it found", () => {
    // A workspace root is the LIST of packages, never one of them. Answering
    // `{package}` with the root's own name would propose a command that runs
    // the root against itself -- a different command from the N this repository
    // actually runs.
    const lane = detect(NEXTJS_WORKSPACES).lanes.find((entry): boolean => entry.lane === "nextjs");
    expect(commandRows(lane?.verbs)).not.toContain("coverage");
    const notes = lane?.notes.join("\n") ?? "";
    expect(notes).toMatch(/'coverage' withheld: its reference command still names \{package\}/);
    expect(notes).toMatch(/declares this lane a WORKSPACE ROOT \(apps\/\*, packages\/\*\)/);
    expect(notes).toMatch(/pnpm-workspace\.yaml beside it/);
    // NAMED, not counted: the question the maintainer is being asked is "which
    // of these, and in what order", and a count cannot be answered.
    expect(notes).toMatch(/@placeholder\/admin, @placeholder\/web, @placeholder\/core/);
    expect(notes).toMatch(/ONCE PER PACKAGE/);
  });

  it("reads the other spelling of the same statement -- package.json's own 'workspaces'", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-ws-array-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "@placeholder/root",
          packageManager: "pnpm@9.15.9",
          workspaces: ["packages/*"],
          scripts: { "test:coverage": "placeholder" },
          devDependencies: { turbo: "2.3.3" },
        }),
      );
      mkdirSync(join(dir, "packages", "one"), { recursive: true });
      writeFileSync(
        join(dir, "packages", "one", "package.json"),
        JSON.stringify({ name: "@placeholder/one" }),
      );
      const lane = detect(dir).lanes[0];
      // The root DOES declare `test:coverage`, so the task check would have
      // passed: the row is withheld purely because this manifest is a list of
      // packages rather than one of them.
      expect(commandRows(lane?.verbs)).not.toContain("coverage");
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toMatch(/package\.json's own 'workspaces'/);
      expect(notes).toMatch(/@placeholder\/one/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the object spelling too, and falls back to a member's PATH when it states no name", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-ws-object-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "@placeholder/root",
          packageManager: "pnpm@9.15.9",
          workspaces: { packages: ["packages/*", "tools/solo"] },
          scripts: { "test:coverage": "placeholder" },
          devDependencies: { turbo: "2.3.3" },
        }),
      );
      mkdirSync(join(dir, "packages", "nameless"), { recursive: true });
      mkdirSync(join(dir, "tools", "solo"), { recursive: true });
      const notes = detect(dir).lanes[0]?.notes.join("\n") ?? "";
      // A member nen cannot read a name out of is still a member, and is named
      // by the only thing that IS true about it: where it sits.
      expect(notes).toMatch(/packages\/nameless/);
      // A literal path in the pattern list is a member too, with no glob to
      // expand -- the two forms are not a special case of each other.
      expect(notes).toMatch(/tools\/solo/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an unparseable workspace file as a workspace, not as its absence", () => {
    // FAILING OPEN HERE WOULD ANSWER {package} WITH THE ROOT'S OWN NAME on the
    // strength of a syntax error, which is the one direction this check must
    // not fail in.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-ws-broken-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "@placeholder/root",
          packageManager: "pnpm@9.15.9",
          scripts: { "test:coverage": "placeholder" },
          devDependencies: { turbo: "2.3.3" },
        }),
      );
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n\t- bad tab indent\n");
      const lane = detect(dir).lanes[0];
      expect(commandRows(lane?.verbs)).not.toContain("coverage");
      expect(lane?.notes.join("\n")).toMatch(/which nen could not parse/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--lane selects each of the three lanes, and refuses one this tree does not declare", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-lane-"));
    try {
      cpSync(NEXTJS_WORKSPACES, dir, { recursive: true });
      expect((await capture(["detect", "--write"], dir)).code).toBe(0);

      // No --lane at all: three lanes and no default, so nen refuses rather
      // than picking the root because it happens to be first.
      const bare = await capture(["build", "--dry-run"], dir);
      expect(bare.code).toBe(2);
      expect(bare.err.join("\n")).toMatch(/--lane is required/);

      for (const lane of ["nextjs", "web", "admin"]) {
        const built = await capture(["build", "--dry-run", "--lane", lane], dir);
        expect(built.code, lane).toBe(0);
        expect(built.out.join("\n"), lane).toContain("would run:     pnpm turbo run build");
      }
      // The cwd differs per lane, which is the half of `--lane` that is not the
      // argv: the same command, run somewhere else.
      const web = await capture(["build", "--dry-run", "--lane", "web"], dir);
      expect(web.out.join("\n")).toContain(join(dir, "apps", "web"));

      const bogus = await capture(["build", "--dry-run", "--lane", "packages"], dir);
      expect(bogus.code).toBe(2);
      expect(bogus.err.join("\n")).toMatch(/Declared: nextjs, admin, web/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nen shu detect -- the nextjs golden suite, byte for byte", () => {
  // EVERY PROPOSED ROW, RUN. `detect --write` then `--dry-run` on each verb the
  // proposal carries, with the argv pinned as a literal string rather than as a
  // pattern: a golden that matches loosely is a golden that survives the change
  // it exists to catch.
  const ARGV: Readonly<Record<string, readonly string[]>> = {
    build: ["would run:     pnpm turbo run build"],
    test: ["would run:     pnpm turbo run test"],
    lint: ["would run:     pnpm exec biome check .", "would run:     pnpm turbo run lint"],
    dev: ["would run:     pnpm turbo run dev"],
    run: ["would run:     next start"],
    coverage: ["would run:     pnpm --filter @placeholder/web test:coverage"],
  };

  it("renders every proposed command row back to the argv the pack states", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-golden-nextjs-"));
    try {
      cpSync(NEXTJS_WORKSPACES, dir, { recursive: true });
      expect((await capture(["detect", "--write"], dir)).code).toBe(0);
      const verbs = detect(dir).lanes.find((lane): boolean => lane.lane === "web")?.verbs;
      // The golden's own key set is asserted against what was proposed, so a
      // row that stopped being proposed fails here rather than silently going
      // untested.
      expect(commandRows(verbs)).toEqual(Object.keys(ARGV).sort());
      for (const [verb, lines] of Object.entries(ARGV)) {
        const result = await capture([verb, "--dry-run", "--lane", "web"], dir);
        expect(result.code, verb).toBe(0);
        expect(
          result.out.filter((line): boolean => line.startsWith("would run:")),
          verb,
        ).toEqual(lines);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses every proposed unsupported row at exit 4, quoting the pack's own sentence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-golden-nextjs-unsup-"));
    try {
      cpSync(NEXTJS_WORKSPACES, dir, { recursive: true });
      expect((await capture(["detect", "--write"], dir)).code).toBe(0);
      const verbs = detect(dir).lanes.find((lane): boolean => lane.lane === "web")?.verbs;
      expect(unsupportedRows(verbs)).toEqual(["archive", "deploy", "release", "ui-test"]);
      for (const verb of ["archive", "release", "ui-test"]) {
        const result = await capture([verb, "--dry-run", "--lane", "web"], dir);
        expect(result.code, verb).toBe(4);
        // THE WHOLE POINT OF THE STUB: the executor's refusal is the pack's
        // sentence, arriving as the repository's own reason because it now sits
        // in the repository's own file.
        expect(result.err.join("\n"), verb).toContain(reasonOf(verbs, verb));
      }
      // `deploy` never reaches the verb: --target is checked FIRST by design
      // (./run.ts states the order), and this proposal declares no target.
      const withoutTarget = await capture(["deploy", "--dry-run", "--lane", "web"], dir);
      expect(withoutTarget.code).toBe(2);
      expect(withoutTarget.err.join("\n")).toMatch(/--target is required/);
      const withTarget = await capture(
        ["deploy", "--dry-run", "--lane", "web", "--target", "x"],
        dir,
      );
      expect(withTarget.code).toBe(2);
      expect(withTarget.err.join("\n")).toMatch(/declares no targets at all/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── the gatsby stack ────────────────────────────────────────────────────────

describe("nen shu detect -- the gatsby lane, end to end", () => {
  it("proposes one lane from the config marker, with the pack's five command rows", () => {
    const report = detect(GATSBY_SITE);
    expect(report.exitCode).toBe(0);
    expect(report.lanes).toHaveLength(1);
    expect(report.lanes[0]?.stack).toBe("gatsby");
    expect(report.lanes[0]?.markers).toEqual(["gatsby-config.js"]);
    expect(commandRows(report.lanes[0]?.verbs)).toEqual([
      "archive",
      "build",
      "deploy",
      "dev",
      "run",
    ]);
    expect(unsupportedRows(report.lanes[0]?.verbs)).toEqual([
      "coverage",
      "lint",
      "release",
      "test",
      "ui-test",
    ]);
  });

  it("proposes the pack's argv, verbatim, for the three rows that carry no token", () => {
    const verbs = detect(GATSBY_SITE).lanes[0]?.verbs as Record<
      string,
      { exe?: string; argv?: string[]; steps?: { exe: string; argv: string[] }[] }
    >;
    expect(verbs["build"]).toMatchObject({ exe: "gatsby", argv: ["build"] });
    expect(verbs["dev"]).toMatchObject({ exe: "gatsby", argv: ["develop"] });
    expect(verbs["run"]).toMatchObject({ exe: "gatsby", argv: ["serve"] });
  });

  it("answers {archiveScript} from the manifest's own script, and only from there", () => {
    const verbs = detect(GATSBY_SITE).lanes[0]?.verbs as Record<
      string,
      { exe?: string; argv?: string[]; steps?: { exe: string; argv: string[] }[] }
    >;
    // The token is a PATH, and the one place `detect` can see a path this
    // repository actually runs is a script whose command is this step, word
    // for word, with the token in one position.
    expect(verbs["archive"]).toMatchObject({
      exe: "node",
      argv: ["scripts/build-placeholder-pdf.mjs"],
    });
    expect(verbs["deploy"]?.steps).toEqual([
      { exe: "node", argv: ["scripts/build-placeholder-pdf.mjs"] },
      { exe: "gh-pages", argv: ["-d", "public", "-b", "gh-pages", "--dotfiles"] },
    ]);
    // AND NOT ONE PROPOSED ARGV CARRIES A PLACEHOLDER.
    for (const verb of commandRows(verbs)) {
      const row = verbs[verb] as {
        exe?: string;
        argv?: string[];
        steps?: { exe: string; argv: string[] }[];
      };
      const steps = row.steps ?? [{ exe: row.exe ?? "", argv: row.argv ?? [] }];
      for (const token of steps.flatMap((step): readonly string[] => [step.exe, ...step.argv])) {
        expect(token, verb).not.toMatch(/\{[a-zA-Z]+\}/);
      }
    }
  });

  it("withholds the two rows that need {archiveScript} when no script names one", () => {
    // THE MUTANT THIS KILLS: proposing `node {archiveScript}` unsubstituted,
    // which the executor would then refuse at exit 2 -- a proposal a human
    // pastes and then discovers is fiction.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-gatsby-noscript-"));
    try {
      writeFileSync(join(dir, "gatsby-config.js"), "module.exports = {};\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "@placeholder/site",
          scripts: { build: "gatsby build" },
          dependencies: { gatsby: "5.14.0" },
        }),
      );
      const lane = detect(dir).lanes[0];
      // The three rows that need no token are still proposed -- `gatsby` is a
      // declared dependency here. Only the two that need the PATH are withheld.
      expect(commandRows(lane?.verbs)).toEqual(["build", "dev", "run"]);
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toMatch(
        /'archive' withheld: its reference command still names \{archiveScript\}/,
      );
      expect(notes).toMatch(/'deploy' withheld: its reference command still names \{archiveScript\}/);
      expect(notes).toMatch(/a guessed argument is a different command/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds rather than choosing when two scripts answer the same token differently", () => {
    // Rule 1 of ./detect.ts's header is not suspended because the two
    // candidates arrived from one file.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-gatsby-ambiguous-"));
    try {
      writeFileSync(join(dir, "gatsby-config.js"), "module.exports = {};\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "@placeholder/site",
          scripts: {
            "pdf:one": "node scripts/one.mjs",
            "pdf:two": "node scripts/two.mjs",
          },
          dependencies: { gatsby: "5.14.0" },
        }),
      );
      const lane = detect(dir).lanes[0];
      expect(commandRows(lane?.verbs)).not.toContain("archive");
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toMatch(/'archive' withheld: 2 of this lane's own scripts match/);
      expect(notes).toMatch(
        /\{archiveScript\} = scripts\/one\.mjs; \{archiveScript\} = scripts\/two\.mjs/,
      );
      expect(notes).toMatch(/nen resolves no ambiguity/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers a token from a script whatever the token is, and never from the pack", () => {
    // The scripts route is over TOKENS, not over one token. A manifest that
    // spells the whole command out has said something stronger about itself
    // than any single field does -- so a manager named only in a script answers
    // `{pm}` too, and the row is proposed because the repository states it runs
    // exactly this line. The value still comes from the repository and never
    // from the catalogue, which is the property that matters.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-pm-from-script-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      writeFileSync(
        join(dir, "package.json"),
        // No `packageManager` field at all, and no dependency naming the
        // manager either: the script is the whole evidence.
        JSON.stringify({ name: "@placeholder/scripted", scripts: { build: "pnpm turbo run build" } }),
      );
      const lane = detect(dir).lanes[0];
      expect(lane?.verbs["build"]).toMatchObject({ exe: "pnpm", argv: ["turbo", "run", "build"] });
      // And the rows no script spells out stay withheld -- the route confirms
      // the line it matched and nothing else.
      expect(commandRows(lane?.verbs)).toEqual(["build"]);
      expect(lane?.notes.join("\n")).toMatch(
        /'test' withheld: its reference command still names \{pm\}/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds the executable cross-check for gatsby: the tool must be a declared dependency", () => {
    // THE SHARED RULE, PROVED ON THE NEW STACK. A marker match is not evidence
    // that the tool is installed; a dependency the manifest declares is.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-gatsby-nodep-"));
    try {
      writeFileSync(join(dir, "gatsby-config.js"), "module.exports = {};\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "@placeholder/site", dependencies: { react: "18.3.1" } }),
      );
      const lane = detect(dir).lanes[0];
      expect(commandRows(lane?.verbs)).toEqual([]);
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toMatch(/'build' withheld: it runs 'gatsby'/);
      expect(notes).toMatch(
        /neither declares as a dependency, nor names as its packageManager, nor spells out verbatim as one of its own scripts/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries the pack's reason into each unsupported row, including the two the draft names", () => {
    const verbs = detect(GATSBY_SITE).lanes[0]?.verbs;
    expect(reasonOf(verbs, "test")).toBe("No test script and no test-runner dependency.");
    expect(reasonOf(verbs, "lint")).toBe("NO LINTER OF ANY KIND EXISTS IN THIS REPOSITORY.");
    expect(reasonOf(verbs, "ui-test")).toBe("No UI or E2E runner of any kind.");
    expect(reasonOf(verbs, "release")).toBe("No release lane of any kind.");
    expect(reasonOf(verbs, "coverage")).toMatch(/nothing to instrument/);
  });

  it("proposes hosts of any, from the pack, for every verb", () => {
    const proposal = detect(GATSBY_SITE).proposal as unknown as Proposal;
    expect(proposal.project.hosts).toEqual({ "*": ["darwin", "linux", "win32"] });
  });

  it("proposes NO precondition for the browser, and says why rather than inventing one", () => {
    // The design source cites a browser PROBED FOR BY PATH and names no
    // environment variable at all. A `path` precondition would pin one machine's
    // install location into a file every machine reads, and nen has no honest
    // second choice -- so it proposes nothing and puts the constraint in a note.
    const lane = detect(GATSBY_SITE).lanes[0];
    const notes = lane?.notes.join("\n") ?? "";
    expect(notes).toMatch(/no precondition is proposed for the 'browser'/);
    expect(notes).toMatch(
      /\{browserPath\} is a value only the machine running the verb can answer/,
    );
    expect(notes).toMatch(/the reference pack names no environment variable to assert instead/);
    expect(notes).toMatch(/project\.preconditions\.gatsby/);
    // The pack's own reason travels with it, so the note is the catalogue's
    // sentence rather than this file's paraphrase of it.
    expect(notes).toMatch(/never installs a browser/);
    // AND NOTHING IS PROPOSED. The proposal carries no preconditions block at
    // all, which is the assertion the note would otherwise merely describe.
    const proposal = detect(GATSBY_SITE).proposal as unknown as Record<string, unknown>;
    expect(Object.keys((proposal["project"] ?? {}) as object)).not.toContain("preconditions");
  });

  it("names no environment variable anywhere in the proposal, because the source cites none", () => {
    // THE MUTANT THIS KILLS: inventing a plausible variable name. A precondition
    // nen made up reads exactly like one the repository stated.
    const rendered = renderDetect(detect(GATSBY_SITE)).join("\n");
    // Case-SENSITIVE, and specifically the shapes an environment variable takes:
    // the pack's own prose says the builder "avoids puppeteer", and forbidding
    // the word would forbid the catalogue from explaining itself.
    expect(rendered).not.toMatch(/PUPPETEER_EXECUTABLE_PATH|CHROME_PATH|CHROMIUM_PATH|EDGE_PATH|CHROME_BIN/);
  });
});

describe("nen shu detect -- the gatsby golden suite, byte for byte", () => {
  const ARGV: Readonly<Record<string, readonly string[]>> = {
    build: ["would run:     gatsby build"],
    dev: ["would run:     gatsby develop"],
    run: ["would run:     gatsby serve"],
    archive: ["would run:     node scripts/build-placeholder-pdf.mjs"],
  };

  it("renders every proposed command row back to the argv the pack cites", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-golden-gatsby-"));
    try {
      cpSync(GATSBY_SITE, dir, { recursive: true });
      expect((await capture(["detect", "--write"], dir)).code).toBe(0);
      for (const [verb, lines] of Object.entries(ARGV)) {
        const result = await capture([verb, "--dry-run"], dir);
        expect(result.code, verb).toBe(0);
        expect(
          result.out.filter((line): boolean => line.startsWith("would run:")),
          verb,
        ).toEqual(lines);
      }
      // `deploy` is the two-step row and it never reaches the steps: --target is
      // checked FIRST by design, and a proposal declares no targets.
      const deploy = await capture(["deploy", "--dry-run", "--target", "x"], dir);
      expect(deploy.code).toBe(2);
      expect(deploy.err.join("\n")).toMatch(/declares no targets at all/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses each unsupported row at exit 4, quoting the pack's reason back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-golden-gatsby-unsup-"));
    try {
      cpSync(GATSBY_SITE, dir, { recursive: true });
      expect((await capture(["detect", "--write"], dir)).code).toBe(0);
      const verbs = detect(dir).lanes[0]?.verbs;
      for (const verb of ["test", "ui-test", "lint", "release", "coverage"]) {
        const result = await capture([verb, "--dry-run"], dir);
        expect(result.code, verb).toBe(4);
        expect(result.err.join("\n"), verb).toBe(
          `nen shu ${verb}: '${verb}' is unsupported on lane 'gatsby' (gatsby). The declaration's own reason: ${reasonOf(verbs, verb)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a declaration the executor loads without a single hand edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-golden-gatsby-load-"));
    try {
      cpSync(GATSBY_SITE, dir, { recursive: true });
      expect((await capture(["detect", "--write"], dir)).code).toBe(0);
      const built = await capture(["build", "--dry-run", "--json"], dir);
      expect(built.code).toBe(0);
      const report = JSON.parse(built.out.join("\n")) as {
        stack: string;
        steps: readonly unknown[];
      };
      expect(report.stack).toBe("gatsby");
      expect(report.steps).toEqual([
        { exe: "gatsby", argv: ["build"], cwd: dir, exitCode: null, durationMs: null },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
