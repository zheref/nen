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
import { loadProfilesPack, PLACEHOLDERS } from "../profiles/pack.js";
import { detect, MARKER_STACKS, MAX_DEPTH, renderDetect } from "./detect.js";
import {
  EMPTY_TREE,
  markerTree,
  NEXTJS_MULTI,
  NEXTJS_PARTIAL,
  NEXTJS_SINGLE,
  NEXTJS_UNVERIFIED,
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

describe("nen shu detect -- the nextjs lane, end to end", () => {
  it("proposes one lane at the root, with the pack's five reference verbs", () => {
    const report = detect(NEXTJS_SINGLE);
    expect(report.exitCode).toBe(0);
    expect(report.lanes).toHaveLength(1);
    expect(report.lanes[0]?.stack).toBe("nextjs");
    expect(report.lanes[0]?.cwd).toBe(".");
    expect(report.lanes[0]?.markers).toEqual(["next.config.mjs"]);
    expect(Object.keys(report.lanes[0]?.verbs ?? {}).sort()).toEqual([
      "build",
      "dev",
      "lint",
      "run",
      "test",
    ]);
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

  it("proposes hosts for the stack, and every verb's row carries the pack's why", () => {
    const proposal = detect(NEXTJS_SINGLE).proposal as unknown as Proposal;
    expect(proposal.project.hosts).toEqual({ "*": ["darwin", "linux", "win32"] });
    for (const row of Object.values(proposal.project.verbs["nextjs"] ?? {})) {
      expect((row as { why?: string }).why).toBeTruthy();
    }
  });

  it("reports a Makefile as a finding and never as a proposed command", () => {
    const report = detect(NEXTJS_SINGLE);
    expect(report.notes.join("\n")).toMatch(/a Makefile sits beside a lane/);
    // The finding is in the notes; what must be free of it is the EXECUTABLE
    // side of every proposed row. (The pack's prose says why it never proposes
    // one, which is a `why` a human reads, not a command anything runs.)
    const proposal = detect(NEXTJS_SINGLE).proposal as unknown as Proposal;
    for (const row of Object.values(proposal.project.verbs["nextjs"] ?? {})) {
      const steps = (row as { exe?: string; steps?: { exe: string }[] }).steps ?? [
        { exe: (row as { exe: string }).exe },
      ];
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
    expect(report.lanes[0]?.verbs).toEqual({});
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
      expect(report.lanes[0]?.verbs).toEqual({});
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
      expect(report.lanes[0]?.verbs).toEqual({});
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
    expect(Object.keys(report.lanes[0]?.verbs ?? {}).sort()).toEqual(["build", "dev", "run"]);
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
      expect(Object.keys(report.lanes[0]?.verbs ?? {})).toEqual(["lint"]);
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
      expect(report.lanes[0]?.verbs).toEqual({});
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
      expect(report.lanes[0]?.verbs).toEqual({});
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
      expect(lane?.verbs).toEqual({});
      expect(lane?.notes.length, "a withheld map with no reason is the failure").toBeGreaterThan(0);
      for (const note of lane?.notes ?? []) {
        expect(note).toMatch(/withheld|proposes no command/);
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
