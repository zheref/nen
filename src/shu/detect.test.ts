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
import {
  detect as detectOn,
  listDirectory,
  MARKER_STACKS,
  MAX_DEPTH,
  renderDetect,
  REFINEMENT_DEPTH,
  stripScriptComments,
  type DetectedLane,
  type DetectReport,
  type Entry,
} from "./detect.js";
import {
  EMPTY_TREE,
  EXPO_BARE,
  GATSBY_SITE,
  KRO_SHAPED,
  markerTree,
  NEXTJS_MULTI,
  NEXTJS_PARTIAL,
  NEXTJS_SINGLE,
  NEXTJS_UNTOOLED,
  NEXTJS_UNVERIFIED,
  NEXTJS_WORKSPACES,
} from "./fixtures/paths.js";
import { shuCommand } from "./command.js";
import { ASSERTABLE_KINDS } from "./run.js";

/**
 * `detect` on a STATED host, defaulting to the one `capture` below scripts.
 *
 * The platform is a real parameter of the shipped function -- `{gw}` resolves
 * to a different word on Windows -- and every case in this file that is not
 * ABOUT the host says `linux` by taking this default, so that the whole suite
 * proves the same thing on all three CI lanes. A case that IS about the host
 * names the platform it means, exactly as `ScriptedSeams` makes a caller do.
 */
function detect(repo: string, platform: NodeJS.Platform = "linux"): ReturnType<typeof detectOn> {
  return detectOn(repo, platform);
}

interface Captured {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
}

async function capture(
  argv: readonly string[],
  repo: string,
  platform: NodeJS.Platform = "linux",
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
  };
  const seams = new ScriptedSeams([], { platform });
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

/**
 * The list `<pm> turbo run <task>` is actually checked against.
 *
 * A TURBO TASK IS NOT A PACKAGE.JSON SCRIPT, and a temp tree that wants the
 * pack's `nextjs` rows proposed has to carry both -- which is the whole point
 * of the check and the reason this constant is spelled out here rather than
 * folded into a helper: a tree that omits it gets the row withheld, by name.
 */
const TURBO_JSON = JSON.stringify({
  tasks: { build: {}, test: {}, lint: {}, dev: {} },
});

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

  it("proposes the pack's own reason, verbatim, inside a seat that says what it is", () => {
    // The reason is QUOTED rather than summarised, because the executor prints
    // this same string back at exit 4 -- ./render.ts's unsupported refusal reads
    // `invocation.reason` -- so a sentence rewritten here is a sentence a
    // developer is later told is their repository's own.
    //
    // AND THAT IS EXACTLY WHY THE QUOTE IS WRAPPED. render.ts prints it as "The
    // declaration's own reason: <text>", which is true of a row a human wrote
    // and false of this one: the quoted half is a CATALOGUE's observation about
    // other repositories. So the row names itself, names the program that wrote
    // it, and marks the quote as the pack's.
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
      expect(reasonOf(verbs, verb), verb).toBe(
        `PROPOSED SEAT -- replace it. nen shu detect wrote this row because the reference pack proposes no command for '${verb}' on nextjs; nen never invents one. The pack's own reason: ${packReason}`,
      );
      // The wrapper opens the string, so it is the first thing read in the
      // file, in `--json`, and in the exit-4 refusal alike.
      expect(reasonOf(verbs, verb).startsWith("PROPOSED SEAT -- replace it."), verb).toBe(true);
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
      writeFileSync(join(dir, "turbo.json"), TURBO_JSON);
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
      writeFileSync(join(dir, "turbo.json"), TURBO_JSON);
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

  it("withholds the verbs whose task the RUNNER's own config declares none of, naming each", () => {
    const report = detect(NEXTJS_PARTIAL);
    // `<pm> turbo run <task>` hands the task to TURBO, so the list nen checks
    // is turbo's own -- this tree's `turbo.json` declares `build` and `dev` and
    // neither `test` nor `lint`, so exactly those two rows are withheld. `run`
    // (`next start`) names no task at all and is proposed because its
    // executable IS a dependency here.
    expect(commandRows(report.lanes[0]?.verbs)).toEqual(["build", "dev", "run"]);
    const notes = report.lanes[0]?.notes.join("\n") ?? "";
    expect(notes).toMatch(
      /'test' withheld: 'pnpm turbo run test' hands the task 'test' to 'turbo', and this lane's turbo\.json declares no such task \(it declares: build, dev\)/,
    );
    expect(notes).toMatch(
      /'lint' withheld: 'pnpm turbo run lint' hands the task 'lint' to 'turbo'/,
    );
    expect(notes).toMatch(/a warning, never a proposal/);
    // AND NOT AGAINST THE WRONG LIST. `package.json` declares no `test` script
    // either, so a message naming package.json here would read as correct while
    // proving nothing: the row must be refused for turbo's list, by name.
    expect(notes).not.toMatch(/'test' withheld: its reference command runs the task/);
  });

  it("withholds a turbo row when the lane has no turbo.json for nen to read at all", () => {
    // THE MUTANT THIS KILLS: falling back to `package.json`'s scripts when the
    // runner's own list is unreadable. `turbo run build` does not run the npm
    // `build` script, so a manifest that declares one says nothing about this
    // row -- and turbo itself fails on a tree with no turbo.json.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-no-turbo-json-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@9.15.9",
          scripts: { build: "placeholder", test: "placeholder", lint: "placeholder" },
          devDependencies: { "@biomejs/biome": "1.9.4", next: "15.1.0", turbo: "2.3.3" },
        }),
      );
      const lane = detect(dir).lanes[0];
      expect(commandRows(lane?.verbs)).toEqual(["run"]);
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toMatch(
        /'build' withheld: 'pnpm turbo run build' hands the task 'build' to 'turbo', whose task list lives in turbo\.json -- and this lane has none for nen to read/,
      );
      expect(notes).toMatch(/withholds rather than confirming this row against the wrong list/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds a row whose manager hands the work to a tool the manifest never declares", () => {
    // THE FALSE POSITIVE THIS CLOSES. `pnpm turbo run build` passes the
    // executable check the moment package.json names pnpm -- and says nothing
    // whatever about turbo, which is the program that has to be there. Same for
    // `pnpm exec biome check .`.
    const lane = detect(NEXTJS_UNTOOLED).lanes[0];
    expect(commandRows(lane?.verbs)).toEqual(["run"]);
    const notes = lane?.notes.join("\n") ?? "";
    expect(notes).toMatch(
      /'build' withheld: 'pnpm turbo run build' asks the package manager to run 'turbo', and this lane's package\.json declares no such dependency/,
    );
    expect(notes).toMatch(
      /'lint' withheld: 'pnpm exec biome check \.' asks the package manager to run 'biome'/,
    );
    expect(notes).toMatch(/that is the program that has to be there/);
  });

  it("accepts a scoped dependency as the tool it publishes ('@biomejs/biome' answers for 'biome')", () => {
    // A WIDENING AND NEVER A NARROWING: the scope belongs to the publisher, and
    // an exact-string check would withhold every scoped tool in existence.
    // NEXTJS_SINGLE declares `@biomejs/biome` and no bare `biome`.
    const manifest = JSON.parse(
      readFileSync(join(NEXTJS_SINGLE, "package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };
    expect(Object.keys(manifest.devDependencies)).toContain("@biomejs/biome");
    expect(Object.keys(manifest.devDependencies)).not.toContain("biome");
    expect(commandRows(detect(NEXTJS_SINGLE).lanes[0]?.verbs)).toContain("lint");
  });

  it("proposes NOTHING for a manifest that declares a task runner and one task", () => {
    // The header's claim -- "never proposes a command the repository cannot
    // run" -- was false without this check: a manifest whose only script was
    // `lint` still got a proposed `build`. The list is turbo's own, which is
    // the list `turbo run build` would consult.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-scripts-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      writeFileSync(join(dir, "turbo.json"), JSON.stringify({ tasks: { lint: {} } }));
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@9.15.9",
          scripts: { lint: "placeholder" },
          devDependencies: { "@biomejs/biome": "1.9.4", turbo: "2.3.3" },
        }),
      );
      const report = detect(dir);
      expect(commandRows(report.lanes[0]?.verbs)).toEqual(["lint"]);
      expect(report.lanes[0]?.notes.join("\n")).toMatch(
        /'build' withheld: 'pnpm turbo run build' hands the task 'build' to 'turbo', and this lane's turbo\.json declares no such task \(it declares: lint\)/,
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
  // `proposed` is what a tree carrying THE MARKER AND NOTHING ELSE can still
  // stand behind, and it is empty for four of the six: their rows need a
  // manifest that is not there. The two Gradle trees are the exception, and the
  // exception is the point of this PR -- their tool is a file the repository
  // COMMITS, so a tree carrying the marker carries the evidence for the row
  // too, and only the rows needing something further (a settings file naming a
  // module) are withheld.
  const CASES: readonly {
    tree: string;
    stack: string;
    marker: string;
    proposed: readonly string[];
  }[] = [
    { tree: "gatsby", stack: "gatsby", marker: "gatsby-config.js", proposed: [] },
    { tree: "expo", stack: "expo", marker: "app.json", proposed: [] },
    { tree: "xcode", stack: "xcode-ios", marker: "Placeholder.xcworkspace", proposed: [] },
    {
      tree: "gradle-android",
      stack: "gradle-android",
      marker: "app/build.gradle.kts",
      proposed: ["build", "lint", "ui-test"],
    },
    {
      tree: "compose-desktop",
      stack: "compose-desktop",
      marker: "desktop/build.gradle.kts",
      proposed: ["run"],
    },
    { tree: "winui", stack: "dotnet-winui", marker: "Placeholder.csproj", proposed: [] },
  ];

  for (const { tree, stack, marker, proposed } of CASES) {
    it(`answers '${stack}' for ${marker}, with a reason for every row it withholds`, () => {
      const report = detect(markerTree(tree));
      expect(report.lanes.map((lane): string => lane.stack)).toContain(stack);
      const lane = report.lanes.find((entry): boolean => entry.stack === stack);
      expect(lane?.markers).toEqual([marker]);
      expect(commandRows(lane?.verbs)).toEqual([...proposed]);
      expect(lane?.notes.length, "a withheld map with no reason is the failure").toBeGreaterThan(0);
      for (const note of lane?.notes ?? []) {
        // Six shapes of note, and each is something a maintainer acts on: a row
        // withheld, the pack declining to choose, a toolchain requirement nen
        // will not turn into a precondition it would have to invent a value
        // for, the catalogue's own prose about this stack (the preconditions
        // and the recorded conflicts a verb row cannot carry), the host a
        // host-conditional token was resolved for, and the module the pack's
        // tasks were re-addressed to.
        expect(note).toMatch(
          /withheld|proposes no command|no precondition is proposed|the reference pack's own note|was resolved for |includes as the module /,
        );
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
      // BOTH BOUNDS ARE NAMED, not just the one. A lane whose application
      // module sits deeper than REFINEMENT_DEPTH inside it is missed for a
      // second, independent reason, and a reader told only about the first
      // spends the afternoon moving the lane up one directory.
      expect(REFINEMENT_DEPTH).toBe(2);
      expect(rendered).toMatch(/at most 2 directories down for the module/);
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
  it("orders lanes and markers by NAME, so one tree always proposes one document", () => {
    // REPRODUCED BEFORE IT WAS FIXED: this same fixture answered `nextjs, web,
    // admin` from the CLI and `nextjs, admin, web` from the suite minutes
    // apart, because `readdirSync` hands back the filesystem's own order and a
    // checkout had rewritten the directory in between. Lane order is not
    // cosmetic -- `laneName`'s collision suffixes are assigned in iteration
    // order, so two lanes competing for one name could swap between two runs.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-order-"));
    try {
      // Created in an order that is NOT the sorted one, so a fixture that
      // happened to be written alphabetically cannot make this pass by luck.
      for (const name of ["zeta", "alpha", "middle"]) {
        mkdirSync(join(dir, name), { recursive: true });
        writeFileSync(join(dir, name, "next.config.js"), "module.exports = {};\n");
      }
      const lanes = detect(dir).lanes.map((lane): string => lane.lane);
      expect(lanes).toEqual(["alpha", "middle", "zeta"]);
      expect(detect(dir).lanes.map((lane): string => lane.lane)).toEqual(lanes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // And the same rule over a lane's MARKERS, which come out of one
    // directory's listing rather than out of the walk.
    const twice = mkdtempSync(join(tmpdir(), "nen-detect-order-markers-"));
    try {
      writeFileSync(join(twice, "next.config.mjs"), "export default {};\n");
      writeFileSync(join(twice, "next.config.js"), "module.exports = {};\n");
      expect(detect(twice).lanes[0]?.markers).toEqual(["next.config.js", "next.config.mjs"]);
    } finally {
      rmSync(twice, { recursive: true, force: true });
    }
  });

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
      /'coverage' withheld: its reference command asks the package '@placeholder\/admin' for the task 'test:coverage', and this lane's package\.json declares no such script/,
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
      expect(notes).toMatch(
        /'archive' withheld: 2 of this lane's own scripts share the shape of its reference command 'node \{archiveScript\}' and corroborate it/,
      );
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
    const seat = (verb: string, packReason: string): string =>
      `PROPOSED SEAT -- replace it. nen shu detect wrote this row because the reference pack proposes no command for '${verb}' on gatsby; nen never invents one. The pack's own reason: ${packReason}`;
    expect(reasonOf(verbs, "test")).toBe(
      seat("test", "No test script and no test-runner dependency."),
    );
    expect(reasonOf(verbs, "lint")).toBe(
      seat("lint", "NO LINTER OF ANY KIND EXISTS IN THIS REPOSITORY."),
    );
    expect(reasonOf(verbs, "ui-test")).toBe(seat("ui-test", "No UI or E2E runner of any kind."));
    expect(reasonOf(verbs, "release")).toBe(seat("release", "No release lane of any kind."));
    expect(reasonOf(verbs, "coverage")).toMatch(/nothing to instrument/);
    // THE STACK IS NAMED, not just the verb: the same seat on two stacks has
    // two different reasons behind it, and a reader who cannot see which stack
    // this row came from cannot check the claim.
    expect(reasonOf(verbs, "test")).toMatch(/proposes no command for 'test' on gatsby/);
  });

  it("proposes hosts of any, from the pack, for every verb", () => {
    const proposal = detect(GATSBY_SITE).proposal as unknown as Proposal;
    expect(proposal.project.hosts).toEqual({ "*": ["darwin", "linux", "win32"] });
  });

  it("proposes NO precondition for the browser, and says why rather than inventing one", () => {
    // The design source cites a browser PROBED FOR BY PATH and names no
    // environment variable at all -- and #116's own acceptance line asked for a
    // `path` precondition here. Nen cannot write one: ../shu/run.ts resolves
    // every declared path against the repository root and REFUSES one that
    // escapes it (exit 2), so an installed browser's absolute location is not
    // expressible as a precondition at all. The note says that rather than
    // "unwise", because the two are different facts and only one is checkable.
    const lane = detect(GATSBY_SITE).lanes[0];
    const notes = lane?.notes.join("\n") ?? "";
    expect(notes).toMatch(/no precondition is proposed for the 'browser'/);
    expect(notes).toMatch(/\{browserPath\} is a value nen has nothing to read here/);
    expect(notes).toMatch(
      /'path' is not merely a bad choice here, it is one nen REFUSES: every path a declaration states is resolved against the repository root and one that escapes it exits 2 by name/,
    );
    expect(notes).toMatch(/The reference pack names no environment variable to assert instead/);
    expect(notes).toMatch(/project\.preconditions\.gatsby/);
    // THE KINDS COME FROM THE EXECUTOR, not from a sentence typed here: the
    // note names exactly what ../shu/run.ts can assert, in its order.
    expect(notes).toContain(
      `nen asserts a precondition of kind ${ASSERTABLE_KINDS.map((kind): string => `'${kind}'`).join(" or ")} and performs neither`,
    );
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

describe("nen shu detect -- the directory order one tree is proposed in", () => {
  // THE SORT IS PINNED AGAINST AN INJECTED ENTRY LIST rather than against a
  // real directory, and that is the whole point of the seam. A test that made
  // files and read them back can only assert what THAT host's `readdirSync`
  // happened to return -- and the two hosts disagree: this suite runs under
  // Node and the shipped binary is Bun. Three files created `zulu`, `Beta`,
  // `alpha`, one directory, the same second: node answered
  // ["Beta","alpha","zulu"] and bun answered ["Beta","zulu","alpha"]. So a
  // green suite over a real directory proves nothing about the binary a user
  // runs, and deleting the sort entirely left every such test passing.
  const scrambled: readonly { name: string; directory: boolean }[] = [
    { name: "zulu", directory: true },
    { name: "äpple", directory: true },
    { name: "alpha", directory: true },
    { name: "Beta", directory: true },
  ];

  it("sorts by BYTE order, not by locale -- 'Beta' before 'alpha', 'zulu' before 'apple'", () => {
    const sorted = listDirectory("/ignored", (): readonly Entry[] => scrambled);
    expect(sorted.map((entry): string => entry.name)).toEqual([
      "Beta",
      "alpha",
      "zulu",
      "äpple",
    ]);
    // THE TWO MUTANTS THIS KILLS, named. Deleting the sort leaves the injected
    // order (`zulu` first). Swapping byte order for `localeCompare` puts
    // `alpha` first and `apple` second, because a locale-aware collation folds
    // case and diacritics -- which makes the written document depend on the
    // machine's locale, the same class of bug as an unsorted read, one layer
    // up and harder to see.
    const byLocale = [...scrambled]
      .sort((a, b): number => a.name.localeCompare(b.name))
      .map((entry): string => entry.name);
    expect(byLocale).not.toEqual(sorted.map((entry): string => entry.name));
    expect(scrambled.map((entry): string => entry.name)).not.toEqual(
      sorted.map((entry): string => entry.name),
    );
  });

  it("answers an unreadable directory with nothing, rather than throwing", () => {
    expect(listDirectory(join(tmpdir(), "nen-detect-no-such-directory-ever"))).toEqual([]);
  });

  it("orders two sibling lanes by byte order, and the written document with them", () => {
    // The end-to-end consequence: `apps/Beta` before `apps/alpha`, in the lane
    // list, in `--lane`'s refusal and in the key order of the file.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-order-"));
    try {
      for (const name of ["alpha", "Beta"]) {
        mkdirSync(join(dir, "apps", name), { recursive: true });
        writeFileSync(join(dir, "apps", name, "next.config.js"), "module.exports = {};\n");
      }
      expect(detect(dir).lanes.map((lane): string => lane.lane)).toEqual(["Beta", "alpha"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nen shu detect -- a script answers a token only where something corroborates it", () => {
  const gatsbyTree = (scripts: Readonly<Record<string, string>>): string => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-corroborate-"));
    writeFileSync(join(dir, "gatsby-config.js"), "module.exports = {};\n");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "site", scripts, dependencies: { gatsby: "5.14.0" } }),
    );
    return dir;
  };

  it("WITHHOLDS on a single arity collision, and names the near miss", () => {
    // THE BLOCKER THIS CLOSES. `node {archiveScript}` spells out ONE word and
    // asks for one, so every one-argument `node` script in the manifest agrees
    // with it by arity. Before corroboration, this tree's `start` script
    // answered the PDF-archive row: `archive` came out as `node server.js`,
    // carrying the pack's own `why` about producing a PDF.
    const dir = gatsbyTree({ start: "node server.js" });
    try {
      const lane = detect(dir).lanes[0];
      expect(commandRows(lane?.verbs)).toEqual(["build", "dev", "run"]);
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toMatch(/'archive' withheld: its reference command still names \{archiveScript\}/);
      // THE NEAR MISS IS NAMED, because "no script answers this" and "one has
      // the same shape and nothing backs it up" are different facts.
      expect(notes).toMatch(/one script shares its shape \('start': node server\.js\)/);
      expect(notes).toMatch(/nothing corroborates the match/);
      expect(notes).toMatch(/only from a script whose own KEY names what the row is for/);
      // AND THE VALUE NEVER REACHES A ROW.
      expect(JSON.stringify(lane?.verbs)).not.toContain("server.js");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ANSWERS from a script whose key names the intent, beside a collision that does not", () => {
    // `resume:pdf` corroborates itself: the repository named the script after
    // the file it runs, so `pdf` appears in the key AND in the value. `start`
    // is the same collision as above and is not a competing answer -- it was
    // never a candidate, which is why this is not nen resolving an ambiguity.
    const dir = gatsbyTree({
      start: "node server.js",
      "resume:pdf": "node scripts/build-site-pdf.mjs",
    });
    try {
      const lane = detect(dir).lanes[0];
      expect(lane?.verbs["archive"]).toMatchObject({
        exe: "node",
        argv: ["scripts/build-site-pdf.mjs"],
      });
      expect(lane?.notes.join("\n")).not.toMatch(/'archive' withheld/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still WITHHOLDS when two corroborated scripts disagree -- corroboration is not a tiebreak", () => {
    // Both keys name the intent and they answer differently, so this is a real
    // ambiguity and the row is withheld with both candidates named. Rule 1 of
    // detect.ts's header is not suspended by the corroboration rule; the rule
    // decides what a CANDIDATE is, and runs before the ambiguity test.
    const dir = gatsbyTree({
      "archive:one": "node scripts/one.mjs",
      "archive:two": "node scripts/two.mjs",
    });
    try {
      const lane = detect(dir).lanes[0];
      expect(commandRows(lane?.verbs)).not.toContain("archive");
      expect(lane?.notes.join("\n")).toMatch(
        /'archive' withheld: 2 of this lane's own scripts share the shape of its reference command/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes ARITY as corroboration where the step spells more of itself out than it asks for", () => {
    // `{pm} turbo run build` states three words and asks for one, so a script
    // agreeing with it has agreed about `turbo`, `run` and `build`. No key is
    // needed, and this is the route that keeps the nextjs rows answerable from
    // a manifest that names its manager only in a script.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-shape-corroboration-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
      writeFileSync(join(dir, "turbo.json"), TURBO_JSON);
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "shaped", scripts: { ship: "pnpm turbo run build" } }),
      );
      const lane = detect(dir).lanes[0];
      // The KEY (`ship`) names nothing at all -- the shape is the whole
      // corroboration, and it is enough.
      expect(lane?.verbs["build"]).toMatchObject({ exe: "pnpm", argv: ["turbo", "run", "build"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never matches a LONGER script by its first words -- the word count is an equality", () => {
    // THE MUTANT THIS KILLS: loosening the arity test to a prefix match, which
    // would answer `node {archiveScript}` from `node scripts/pdf.mjs --watch`
    // and propose a one-shot archive that is really a watcher.
    const dir = gatsbyTree({ "resume:pdf": "node scripts/pdf.mjs --watch" });
    try {
      const lane = detect(dir).lanes[0];
      expect(commandRows(lane?.verbs)).toEqual(["build", "dev", "run"]);
      expect(lane?.notes.join("\n")).toMatch(
        /'archive' withheld: its reference command still names \{archiveScript\}/,
      );
      expect(JSON.stringify(lane?.verbs)).not.toContain("scripts/pdf.mjs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nen shu detect -- the workspace member list is a list of real, included packages", () => {
  const workspaceTree = (packages: readonly string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-members-"));
    writeFileSync(join(dir, "next.config.mjs"), "export default {};\n");
    writeFileSync(join(dir, "turbo.json"), TURBO_JSON);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "root",
        packageManager: "pnpm@9.15.9",
        scripts: { build: "x", test: "x", lint: "x", dev: "x" },
        devDependencies: { "@biomejs/biome": "1.9.4", next: "15.1.0", turbo: "2.3.3" },
      }),
    );
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      `packages:\n${packages.map((entry): string => `  - "${entry}"\n`).join("")}`,
    );
    for (const name of ["web", "legacy"]) {
      mkdirSync(join(dir, "apps", name), { recursive: true });
      writeFileSync(
        join(dir, "apps", name, "package.json"),
        JSON.stringify({ name: `@site/${name}` }),
      );
    }
    return dir;
  };

  const memberNote = (dir: string): string =>
    detect(dir)
      .lanes[0]?.notes.find((note): boolean => note.includes("WORKSPACE ROOT")) ?? "";

  it("applies a negation AFTER expansion, so the list never names an excluded package", () => {
    // `!apps/legacy` used to be skipped as a pattern nen could not read, while
    // `apps/*` expanded it anyway -- so the note named the one package the
    // repository had just said to leave out.
    const dir = workspaceTree(["apps/*", "!apps/legacy"]);
    try {
      const note = memberNote(dir);
      expect(note).toContain("@site/web");
      expect(note).not.toContain("@site/legacy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists only directories that are actually there", () => {
    // A literal pattern was taken verbatim, so `vendor/one` was reported as a
    // member of a tree with no `vendor/` at all -- nen reading a file back as
    // though it were a fact about the disk.
    const dir = workspaceTree(["apps/web", "vendor/one"]);
    try {
      const note = memberNote(dir);
      // The PATTERNS are quoted verbatim -- that is the repository's own file.
      // The MEMBERS are what nen resolved, and `vendor/one` is not one of them.
      expect(note).toContain("(apps/web, vendor/one)");
      expect(note).toContain("the members nen can see here are @site/web.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the patterns it could not read, and says a negation among them widens the list", () => {
    const dir = workspaceTree(["apps/*", "tools/**", "!packages/*/legacy"]);
    try {
      const note = memberNote(dir);
      expect(note).toContain("nen could not read tools/**, !packages/*/legacy");
      expect(note).toMatch(/a NEGATION among them means the list may still name a package/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nen shu detect -- the two kinds of proposed row are printed apart", () => {
  it("prints the unsupported seats on their own line, never folded into 'verbs'", () => {
    // THE MUTANT THIS KILLS: dropping the split. One combined list reads as
    // "eleven verbs are ready", which is the reading that gets a seat shipped
    // unedited -- and the seats are exactly the rows that need an edit.
    const rendered = renderDetect(detect(NEXTJS_SINGLE)).join("\n");
    expect(rendered).toMatch(/^ {8}verbs: {2}build, dev, lint, run, test$/m);
    expect(rendered).toMatch(
      /^ {8}unsupported \(the pack's reason, yours to replace\): {2}archive, deploy, release, ui-test$/m,
    );
    // And no seat appears on the `verbs:` line.
    const verbsLine =
      rendered.split("\n").find((line): boolean => line.trimStart().startsWith("verbs:")) ?? "";
    for (const seat of ["archive", "deploy", "release", "ui-test"]) {
      expect(verbsLine, seat).not.toContain(seat);
    }
  });
});

describe("nen shu detect -- the toolchain rows nen declines to propose a precondition for", () => {
  it("says so for the gradle stacks too, whose probe names the wrapper token", () => {
    // THE MUTANT THIS KILLS: gating the note on the pack's `kind` field, which
    // classifies `{gw}` as host-conditional and so skipped the note entirely
    // for the two stacks whose every command runs through that wrapper. The
    // executor REFUSES `{gw}` by name (../shu/render.ts's REFUSED_PLACEHOLDERS,
    // pinned against the pack in ./purity.test.ts), so a probe naming it is a
    // probe nen cannot perform either: behaviour over prose.
    for (const stack of ["gradle-android", "compose-desktop"]) {
      const lane = detect(markerTree(stack)).lanes.find(
        (entry): boolean => entry.stack === stack,
      );
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes, stack).toMatch(/no precondition is proposed for the 'gradle'/);
      expect(notes, stack).toMatch(/its probe is '\{gw\} --version'/);
      expect(notes, stack).toMatch(
        /\{gw\} is the token the pack says nen resolves for itself from the platform -- and nen's own executor refuses it by name all the same/,
      );
    }
  });

  it("says so for the WinUI workload probe, which names a declaration-supplied token", () => {
    const notes = detect(markerTree("winui")).lanes[0]?.notes.join("\n") ?? "";
    expect(notes).toMatch(/no precondition is proposed for the 'visual-studio'/);
    expect(notes).toMatch(/\{workload\} is a value nen has nothing to read here/);
    // No such note for a probe that carries no token at all.
    expect(notes).not.toMatch(/no precondition is proposed for the 'dotnet-sdk'/);
  });
});

// ── the two Gradle stacks ───────────────────────────────────────────────────
//
// THE PROPERTY THAT MAKES THESE TWO DIFFERENT FROM EVERY OTHER STACK IN THE
// PACK: their tool is a file the repository COMMITS, so `detect` can confirm
// the executable by looking rather than by reading a manifest -- and the word
// it writes for that tool differs by host. Both halves are proved here, on both
// hosts, because a proposal that is right on one platform and fiction on the
// other is the failure a single-platform suite cannot see.

describe("nen shu detect -- {gw} is resolved from the host, into the proposal", () => {
  const ROOT_ARGV: Readonly<Record<string, readonly string[]>> = {
    build: ["assembleDebug", "--stacktrace"],
    test: ["verifyPaparazziDebug", ":PlaceholderCore:test", "--stacktrace"],
    "ui-test": ["verifyPaparazziDebug"],
    lint: [":app:lintDebug", "--stacktrace"],
  };

  const HOSTS: readonly { platform: NodeJS.Platform; exe: string }[] = [
    { platform: "darwin", exe: "./gradlew" },
    { platform: "linux", exe: "./gradlew" },
    { platform: "win32", exe: "gradlew.bat" },
  ];

  for (const { platform, exe } of HOSTS) {
    it(`writes '${exe}' into every proposed row on ${platform}`, () => {
      const report = detect(KRO_SHAPED, platform);
      const root = report.lanes.find((lane): boolean => lane.stack === "gradle-android");
      const desktop = report.lanes.find((lane): boolean => lane.stack === "compose-desktop");
      expect(commandRows(root?.verbs)).toEqual(["build", "lint", "test", "ui-test"]);
      expect(commandRows(desktop?.verbs)).toEqual(["run"]);
      for (const [verb, argv] of Object.entries(ROOT_ARGV)) {
        expect(root?.verbs[verb], `${platform}/${verb}`).toMatchObject({ exe, argv });
      }
      expect(desktop?.verbs["run"], `${platform}/run`).toMatchObject({ exe, argv: ["run"] });
    });
  }

  it("leaves no pack token in any proposed argv, on either host", () => {
    for (const platform of ["darwin", "win32"] as const) {
      for (const lane of detect(KRO_SHAPED, platform).lanes) {
        for (const verb of commandRows(lane.verbs)) {
          const row = lane.verbs[verb] as { exe?: string; argv?: string[] };
          for (const word of [row.exe ?? "", ...(row.argv ?? [])]) {
            expect(word, `${platform}/${lane.lane}/${verb}`).not.toMatch(/\{[a-zA-Z]+\}/);
          }
        }
      }
    }
  });

  // THE MUTANT THIS KILLS: resolving `{gw}` to one spelling on both hosts --
  // the single-value substitution a reader would write first, and the one a
  // POSIX-only suite would never notice.
  it("does not write the same word on both hosts", () => {
    const posix = detect(KRO_SHAPED, "linux").lanes[0]?.verbs["build"] as { exe?: string };
    const windows = detect(KRO_SHAPED, "win32").lanes[0]?.verbs["build"] as { exe?: string };
    expect(posix?.exe).not.toBe(windows?.exe);
  });

  it("withholds every row when the lane carries only the OTHER host's spelling", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-wrapper-"));
    try {
      cpSync(KRO_SHAPED, dir, { recursive: true });
      rmSync(join(dir, "gradlew"));
      const lane = detect(dir, "linux").lanes.find(
        (entry): boolean => entry.stack === "gradle-android",
      );
      // The lane is STILL PROPOSED -- the marker is real and the shape is what
      // a human needs first -- and every command row is withheld by name.
      expect(lane).toBeDefined();
      expect(commandRows(lane?.verbs)).toEqual([]);
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toMatch(/'build' withheld: its reference command still names \{gw\}/);
      expect(notes).toMatch(/this host is linux, whose spelling is '\.\/gradlew'/);
      expect(notes).toMatch(/this lane has no 'gradlew'/);
      expect(notes).toMatch(/it does carry 'gradlew\.bat' -- the other host's spelling/);
      expect(notes).toMatch(/A lane without its own wrapper is a FINDING, never an install/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does the same the other way round, on win32", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-wrapper-win-"));
    try {
      cpSync(KRO_SHAPED, dir, { recursive: true });
      rmSync(join(dir, "gradlew.bat"));
      const lane = detect(dir, "win32").lanes.find(
        (entry): boolean => entry.stack === "gradle-android",
      );
      expect(commandRows(lane?.verbs)).toEqual([]);
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toMatch(/this host is win32, whose spelling is 'gradlew\.bat'/);
      expect(notes).toMatch(/it does carry 'gradlew' -- the other host's spelling/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE MUTANT THIS KILLS: reading a directory LISTING for the wrapper instead
  // of asking whether the entry is a FILE. A directory named `gradlew` used to
  // satisfy the marker and propose a whole lane -- every row withheld, so it
  // was safe, but the lane itself was fiction and the "proposes no lane it
  // cannot see the tool for" claim was not true as written.
  it("does not accept a DIRECTORY named like the wrapper as the wrapper", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-wrapper-dir-"));
    try {
      cpSync(markerTree("gradle-android"), dir, { recursive: true });
      rmSync(join(dir, "gradlew"));
      mkdirSync(join(dir, "gradlew"));
      const report = detect(dir, "linux");
      expect(report.lanes).toEqual([]);
      expect(report.exitCode).toBe(1);
      // And the same tree WITH the file is a lane, so the assertion above is
      // about the file type and not about the fixture being empty.
      rmSync(join(dir, "gradlew"), { recursive: true });
      writeFileSync(join(dir, "gradlew"), "#!/bin/sh\nexit 0\n");
      expect(detect(dir, "linux").lanes.map((lane): string => lane.stack)).toEqual([
        "gradle-android",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE SAME RULE FOR THE CONTEXT FILE, which is the other half of M2: a
  // directory named `settings.gradle.kts` is not a settings file either.
  it("does not accept a DIRECTORY named like the settings file as the settings file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-settings-dir-"));
    try {
      cpSync(markerTree("gradle-android"), dir, { recursive: true });
      rmSync(join(dir, "settings.gradle.kts"));
      mkdirSync(join(dir, "settings.gradle.kts"));
      expect(detect(dir, "linux").lanes).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nen shu detect -- {unitTestTask}, answered only from the lane's own settings file", () => {
  it("answers it from the single library module the settings file includes", () => {
    const row = detect(KRO_SHAPED).lanes[0]?.verbs["test"] as { argv?: string[] };
    expect(row?.argv).toEqual(["verifyPaparazziDebug", ":PlaceholderCore:test", "--stacktrace"]);
  });

  // THE MUTANT THIS KILLS: taking the first included module. `:app` is included
  // first, and `:app:test` is the row this stack's own `why` exists to forbid.
  it("never answers it from a module that applies the application plugin", () => {
    const row = detect(KRO_SHAPED).lanes[0]?.verbs["test"] as { argv?: string[] };
    expect(row?.argv?.join(" ")).not.toContain(":app:");
  });

  it("withholds it, naming the modules, when TWO library modules are included", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-two-modules-"));
    try {
      cpSync(KRO_SHAPED, dir, { recursive: true });
      mkdirSync(join(dir, "PlaceholderData"));
      writeFileSync(
        join(dir, "PlaceholderData", "build.gradle.kts"),
        'plugins {\n    id("org.jetbrains.kotlin.jvm")\n}\n',
      );
      writeFileSync(
        join(dir, "settings.gradle.kts"),
        'include(":app")\ninclude(":PlaceholderCore")\ninclude(":PlaceholderData")\n',
      );
      const lane = detect(dir).lanes.find((entry): boolean => entry.stack === "gradle-android");
      expect(commandRows(lane?.verbs)).toEqual(["build", "lint", "ui-test"]);
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toMatch(/'test' withheld: its reference command still names \{unitTestTask\}/);
      expect(notes).toMatch(/includes :app, :PlaceholderCore, :PlaceholderData/);
      expect(notes).toMatch(
        /2 are library modules \(:PlaceholderCore, :PlaceholderData\), and which of them carries this repository's JVM unit tests is a choice only it can make/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds it, saying so, when the settings file includes NO module", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-no-modules-"));
    try {
      cpSync(KRO_SHAPED, dir, { recursive: true });
      // `includeBuild` survives and must not be read as a module: it names a
      // whole separate build, not one of this build's own.
      writeFileSync(
        join(dir, "settings.gradle.kts"),
        'rootProject.name = "placeholder"\nincludeBuild("bankai/PlaceholderCore")\n',
      );
      const lane = detect(dir).lanes.find((entry): boolean => entry.stack === "gradle-android");
      expect(commandRows(lane?.verbs)).toEqual(["build", "lint", "ui-test"]);
      expect(lane?.notes.join("\n")).toMatch(
        /settings\.gradle\.kts declares no `include\(\.\.\.\)` nen could read/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds it, saying so, when the settings file names no module at all", () => {
    const lane = detect(markerTree("gradle-android")).lanes[0];
    expect(commandRows(lane?.verbs)).toEqual(["build", "lint", "ui-test"]);
    expect(lane?.notes.join("\n")).toMatch(
      /settings\.gradle\.kts declares no `include\(\.\.\.\)` nen could read/,
    );
  });

  // THE MUTANT THIS KILLS: dropping the context-file requirement from
  // `matchesIn`. The pack states the lane's own settings file as a marker with
  // no `contains`, and it was computed and never required -- so a directory
  // with a wrapper and no settings file was a Gradle lane, and (the case that
  // made it a defect) a nested build carrying only a settings file had its
  // build files read as evidence about the lane ABOVE it.
  it("proposes no lane at all when the lane's own settings file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-no-settings-"));
    try {
      cpSync(markerTree("gradle-android"), dir, { recursive: true });
      rmSync(join(dir, "settings.gradle.kts"));
      const report = detect(dir);
      expect(report.lanes).toEqual([]);
      expect(report.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds it when every included module is an application module", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-app-only-"));
    try {
      cpSync(KRO_SHAPED, dir, { recursive: true });
      writeFileSync(join(dir, "settings.gradle.kts"), 'include(":app")\n');
      const lane = detect(dir).lanes.find((entry): boolean => entry.stack === "gradle-android");
      expect(commandRows(lane?.verbs)).toEqual(["build", "lint", "ui-test"]);
      expect(lane?.notes.join("\n")).toMatch(
        /every one applies the plugin that identified this lane -- they are application modules/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the Groovy spelling of the same statement", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-groovy-"));
    try {
      cpSync(KRO_SHAPED, dir, { recursive: true });
      rmSync(join(dir, "settings.gradle.kts"));
      writeFileSync(join(dir, "settings.gradle"), "include ':app', ':PlaceholderCore'\n");
      const row = detect(dir).lanes[0]?.verbs["test"] as { argv?: string[] };
      expect(row?.argv).toContain(":PlaceholderCore:test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nen shu detect -- a module nen cannot classify is never named", () => {
  /**
   * A KRO_SHAPED copy whose `:app` module applies the plugin INDIRECTLY.
   *
   * The lane still matches, because `:legacy` applies the plugin the old way
   * and the marker is a file carrying the literal -- which is exactly the shape
   * of a repository mid-migration to convention plugins, and exactly the shape
   * the two-valued classification got wrong.
   */
  function withIndirectApp(dir: string, appBuild: string): void {
    cpSync(KRO_SHAPED, dir, { recursive: true });
    writeFileSync(join(dir, "app", "build.gradle.kts"), appBuild);
    mkdirSync(join(dir, "legacy"));
    writeFileSync(
      join(dir, "legacy", "build.gradle.kts"),
      'plugins {\n    id("com.android.application")\n}\n',
    );
    writeFileSync(
      join(dir, "settings.gradle.kts"),
      'include(":app")\ninclude(":legacy")\n',
    );
  }

  // THE BLOCKER THIS KILLS, and it is the whole of B1. `moduleCarriesRefinement`
  // returned false for BOTH "this module is a library" and "nen could not
  // tell", and `libraries` read both as library -- so an application module
  // applying AGP through a CONVENTION PLUGIN became the single library module
  // the settings file "named", and `{unitTestTask}` was answered `:app:test`.
  // That is the aggregate the pack's own `why` exists to forbid, written into a
  // declaration with that `why` sitting beside it.
  it("withholds rather than calling a CONVENTION-PLUGIN module a library", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-convention-"));
    try {
      withIndirectApp(dir, 'plugins {\n    id("myapp.android.application")\n}\n');
      const lane = detect(dir).lanes.find((entry): boolean => entry.stack === "gradle-android");
      expect(commandRows(lane?.verbs)).toEqual(["build", "lint", "ui-test"]);
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toMatch(/'test' withheld: its reference command still names \{unitTestTask\}/);
      expect(notes).toContain("nen could not classify :app");
      expect(notes).toContain("myapp.android.application");
      expect(notes).toContain("that is how a CONVENTION PLUGIN wrapping it is spelled");
      // And the forbidden row is nowhere in the proposal, in any spelling.
      expect(JSON.stringify(lane?.verbs)).not.toContain(":app:test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds rather than calling a VERSION-CATALOGUE ALIAS module a library", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-alias-"));
    try {
      withIndirectApp(dir, "plugins {\n    alias(libs.plugins.androidApplication)\n}\n");
      const lane = detect(dir).lanes.find((entry): boolean => entry.stack === "gradle-android");
      expect(commandRows(lane?.verbs)).toEqual(["build", "lint", "ui-test"]);
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toContain("nen could not classify :app");
      expect(notes).toContain("reads its id out of a version catalogue");
      expect(JSON.stringify(lane?.verbs)).not.toContain(":app:test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds a module whose build file applies no plugin nen can see", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-no-plugin-"));
    try {
      withIndirectApp(dir, 'android {\n    namespace = "placeholder"\n}\n');
      const notes =
        detect(dir)
          .lanes.find((entry): boolean => entry.stack === "gradle-android")
          ?.notes.join("\n") ?? "";
      expect(notes).toContain("applies no plugin nen can see");
      expect(notes).toContain("nen could not classify :app");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The other direction, so the rule above is a classification and not a
  // blanket refusal: a module that plainly applies something else IS a library,
  // and the answer still comes out.
  it("still answers from a module that plainly applies a different plugin", () => {
    const row = detect(KRO_SHAPED).lanes[0]?.verbs["test"] as { argv?: string[] };
    expect(row?.argv).toEqual(["verifyPaparazziDebug", ":PlaceholderCore:test", "--stacktrace"]);
  });
});

describe("nen shu detect -- a module the project does not contain is a warning", () => {
  // §2.6: "a scheme, target or task a marker implies but the project does not
  // contain is a WARNING, never a proposal". Each case below used to end in a
  // proposal naming a module that is not there.

  it("never reads a BLOCK-COMMENTED include as a module", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-block-comment-"));
    try {
      cpSync(KRO_SHAPED, dir, { recursive: true });
      writeFileSync(
        join(dir, "settings.gradle.kts"),
        'include(":app")\n/* include(":retired") */\ninclude(":PlaceholderCore")\n',
      );
      const lane = detect(dir).lanes.find((entry): boolean => entry.stack === "gradle-android");
      // Only `//` was stripped, so `:retired` was a module -- with no directory
      // and therefore no plugin, it counted as a SECOND library and the row was
      // withheld naming a module that has not existed since somebody commented
      // it out.
      expect((lane?.verbs["test"] as { argv?: string[] }).argv).toContain(":PlaceholderCore:test");
      expect(lane?.notes.join("\n")).not.toContain(":retired");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds, naming it, for an include with no directory at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-ghost-"));
    try {
      cpSync(KRO_SHAPED, dir, { recursive: true });
      writeFileSync(
        join(dir, "settings.gradle.kts"),
        'include(":app", ":PlaceholderCore", ":ghost")\n',
      );
      const lane = detect(dir).lanes.find((entry): boolean => entry.stack === "gradle-android");
      expect(commandRows(lane?.verbs)).toEqual(["build", "lint", "ui-test"]);
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toContain("nen could not classify :ghost");
      expect(notes).toContain("there is no build.gradle or build.gradle.kts at 'ghost'");
      expect(JSON.stringify(lane?.verbs)).not.toContain(":ghost:test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds a module whose projectDir is remapped OUT of the repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-remap-out-"));
    try {
      cpSync(KRO_SHAPED, dir, { recursive: true });
      writeFileSync(
        join(dir, "settings.gradle.kts"),
        'include(":app")\ninclude(":shared")\nproject(":shared").projectDir = file("../shared")\n',
      );
      const lane = detect(dir).lanes.find((entry): boolean => entry.stack === "gradle-android");
      expect(commandRows(lane?.verbs)).toEqual(["build", "lint", "ui-test"]);
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toContain("nen could not classify :shared");
      expect(notes).toContain("resolves outside this repository");
      expect(JSON.stringify(lane?.verbs)).not.toContain(":shared:test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A REMAP INSIDE THE TREE IS READ AND FOLLOWED, so the rule above is about
  // where the directory ends up and not about the statement existing.
  it("follows a projectDir remap that stays inside the repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-remap-in-"));
    try {
      cpSync(KRO_SHAPED, dir, { recursive: true });
      mkdirSync(join(dir, "libs", "shared"), { recursive: true });
      writeFileSync(
        join(dir, "libs", "shared", "build.gradle.kts"),
        'plugins {\n    id("org.jetbrains.kotlin.jvm")\n}\n',
      );
      writeFileSync(
        join(dir, "settings.gradle.kts"),
        'include(":app")\ninclude(":shared")\nproject(":shared").projectDir = file("libs/shared")\n',
      );
      const row = detect(dir).lanes.find((entry): boolean => entry.stack === "gradle-android")
        ?.verbs["test"] as { argv?: string[] };
      expect(row?.argv).toContain(":shared:test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A REMAP THAT IS ROOTED SOMEWHERE OF ITS OWN IS AN ESCAPE BY SHAPE, and it
  // is one on EVERY host: `path.isAbsolute` answers for the host nen runs on,
  // and the host that WROTE the settings file is a different one. Each `value`
  // below is spelled exactly as the settings file spells it, escapes and all.
  //
  // THE MUTANT THIS KILLS: `join(laneDirectory, ...remapped.split("/"))`. `join`
  // SWALLOWS a leading separator, so `/srv/shared` became `<lane>/srv/shared`,
  // which the escape check then certified as inside the repository -- and nen
  // read it. The first case plants a real build file at exactly that spot, so
  // under the naive join `:shared` classifies as a library and `:shared:test` is
  // PROPOSED off a directory the settings file never named. The drive-letter
  // case kills the narrower mutant of dropping `[A-Za-z]:` from the shape test:
  // `C:\\shared` then splits into `C:` and `shared` and lands in-repo, on a
  // POSIX host too.
  const ROOTED: readonly { name: string; value: string; plant?: readonly string[] }[] = [
    { name: "a POSIX absolute path", value: "/srv/shared", plant: ["srv", "shared"] },
    { name: "a Windows drive letter", value: String.raw`C:\\shared` },
    { name: "a UNC share", value: String.raw`\\\\server\\share` },
  ];
  for (const { name, value, plant } of ROOTED) {
    it(`withholds a module whose projectDir is ${name}`, () => {
      const dir = mkdtempSync(join(tmpdir(), "nen-detect-remap-rooted-"));
      try {
        cpSync(KRO_SHAPED, dir, { recursive: true });
        if (plant !== undefined) {
          mkdirSync(join(dir, ...plant), { recursive: true });
          writeFileSync(
            join(dir, ...plant, "build.gradle.kts"),
            'plugins {\n    id("org.jetbrains.kotlin.jvm")\n}\n',
          );
        }
        writeFileSync(
          join(dir, "settings.gradle.kts"),
          `include(":app")\ninclude(":shared")\nproject(":shared").projectDir = file("${value}")\n`,
        );
        const lane = detect(dir).lanes.find((entry): boolean => entry.stack === "gradle-android");
        expect(commandRows(lane?.verbs)).toEqual(["build", "lint", "ui-test"]);
        const notes = lane?.notes.join("\n") ?? "";
        expect(notes).toContain("nen could not classify :shared");
        // The remap is quoted VERBATIM, so the reader can see the statement nen
        // refused rather than nen's paraphrase of it.
        expect(notes).toContain(value);
        expect(notes).toContain("resolves outside this repository");
        expect(JSON.stringify(lane?.verbs)).not.toContain(":shared:test");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // A BACKSLASH IS A SEPARATOR, not a character in a directory name: a settings
  // file written on Windows spells an in-tree remap `file("libs\\shared")`, and
  // splitting on `/` alone made that one segment -- a directory that is not
  // there, so an in-tree module was withheld as missing. The same normalisation
  // is what lets the escape check SEE the `..` in `..\shared`.
  it("follows a remap written with BACKSLASH separators that stays in the tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-remap-backslash-"));
    try {
      cpSync(KRO_SHAPED, dir, { recursive: true });
      mkdirSync(join(dir, "libs", "shared"), { recursive: true });
      writeFileSync(
        join(dir, "libs", "shared", "build.gradle.kts"),
        'plugins {\n    id("org.jetbrains.kotlin.jvm")\n}\n',
      );
      writeFileSync(
        join(dir, "settings.gradle.kts"),
        `include(":app")\ninclude(":shared")\nproject(":shared").projectDir = file("${String.raw`libs\\shared`}")\n`,
      );
      const row = detect(dir).lanes.find((entry): boolean => entry.stack === "gradle-android")
        ?.verbs["test"] as { argv?: string[] };
      expect(row?.argv).toContain(":shared:test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A VALUE NEN CANNOT RESOLVE AT ALL is neither followed nor guessed at: a
  // `${rootDir}` or a `~` names something outside the text nen is reading, and
  // joining it produced a directory named after the reference itself.
  it("withholds a module whose projectDir is a property reference", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-remap-property-"));
    try {
      cpSync(KRO_SHAPED, dir, { recursive: true });
      writeFileSync(
        join(dir, "settings.gradle.kts"),
        // A plain quoted string, so the `${...}` reaches the fixture unexpanded.
        'include(":app")\ninclude(":shared")\nproject(":shared").projectDir = file("${rootDir}/shared")\n',
      );
      const lane = detect(dir).lanes.find((entry): boolean => entry.stack === "gradle-android");
      expect(commandRows(lane?.verbs)).toEqual(["build", "lint", "ui-test"]);
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toContain("nen could not classify :shared");
      expect(notes).toContain("${rootDir}/shared");
      expect(notes).toContain("names a property or a home directory");
      expect(JSON.stringify(lane?.verbs)).not.toContain(":shared:test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stripScriptComments -- the one reader every build-script match goes through", () => {
  it("removes both comment forms and keeps the code around them", () => {
    expect(stripScriptComments('a // b\nc\n')).toBe("a \nc\n");
    expect(stripScriptComments("a /* b */ c")).toBe("a  c");
  });

  it("keeps the LINE COUNT of a block comment, so a line-wise reader sees no shift", () => {
    expect(stripScriptComments("a\n/* x\ny\n*/\nb").split("\n")).toHaveLength(5);
  });

  it("steps over a quoted string, in both quote styles and through an escape", () => {
    expect(stripScriptComments('url = "https://x/y" // gone')).toBe('url = "https://x/y" ');
    expect(stripScriptComments("id = 'a/*b*/c'")).toBe("id = 'a/*b*/c'");
    expect(stripScriptComments('s = "a\\"// still a string" // gone')).toBe(
      's = "a\\"// still a string" ',
    );
  });
});

describe("nen shu detect -- a commented-out marker is not a marker", () => {
  // THE MUTANT THIS KILLS: matching `contains` against the raw file. A `// TODO`
  // and a `/* */` block are somebody's note to themselves, and a whole LANE was
  // being proposed out of one -- with every row cross-checked and proposed,
  // because the wrapper really is there.
  const CASES: readonly { name: string; text: string }[] = [
    { name: "a line comment", text: '// TODO: id("com.android.application")\n' },
    { name: "a block comment", text: '/*\n  id("com.android.application")\n*/\n' },
  ];
  for (const { name, text } of CASES) {
    it(`proposes no lane from a plugin id inside ${name}`, () => {
      const dir = mkdtempSync(join(tmpdir(), "nen-detect-commented-"));
      try {
        cpSync(markerTree("gradle-android"), dir, { recursive: true });
        writeFileSync(join(dir, "app", "build.gradle.kts"), text);
        expect(detect(dir).lanes).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("still reads a literal that shares a line with a URL in a string", () => {
    // The stripper steps over quoted strings, so a `//` inside one is not a
    // comment and does not eat the rest of the line with it.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-url-"));
    try {
      cpSync(markerTree("gradle-android"), dir, { recursive: true });
      writeFileSync(
        join(dir, "app", "build.gradle.kts"),
        'val docs = "https://example.invalid/agp"; id("com.android.application")\n',
      );
      expect(detect(dir).lanes.map((lane): string => lane.stack)).toEqual(["gradle-android"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nen shu detect -- a marker pattern's directory prefix is honoured", () => {
  // THE MUTANT THIS KILLS: dropping `*/` from `*/build.gradle{,.kts}`. The
  // pack's own `why` reads "a MODULE applying the Android application plugin",
  // and an Android ROOT build file names that plugin `apply false` as a matter
  // of convention -- a line that switches it OFF. A tree with such a root and
  // no module was proposed as a whole Android lane.
  it("never matches the LANE's own build file for a `*/`-prefixed marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-root-apply-false-"));
    try {
      writeFileSync(join(dir, "gradlew"), "#!/bin/sh\nexit 0\n");
      writeFileSync(join(dir, "settings.gradle.kts"), 'rootProject.name = "placeholder"\n');
      writeFileSync(
        join(dir, "build.gradle.kts"),
        'plugins {\n    id("com.android.application") apply false\n}\n',
      );
      expect(detect(dir).lanes).toEqual([]);
      // And a MODULE applying it IS the marker, so the assertion above is about
      // the prefix rather than about the literal.
      mkdirSync(join(dir, "app"));
      writeFileSync(
        join(dir, "app", "build.gradle.kts"),
        'plugins {\n    id("com.android.application")\n}\n',
      );
      const lane = detect(dir).lanes[0];
      expect(lane?.stack).toBe("gradle-android");
      expect(lane?.markers).toEqual(["app/build.gradle.kts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The compose marker carries NO prefix, which is the pack saying the carrier
  // is the lane's own build file -- so that one still matches at the root.
  it("matches the lane's own build file for a marker with no prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-compose-root-"));
    try {
      writeFileSync(join(dir, "gradlew"), "#!/bin/sh\nexit 0\n");
      writeFileSync(join(dir, "settings.gradle.kts"), 'rootProject.name = "desktop"\n');
      writeFileSync(
        join(dir, "build.gradle.kts"),
        "compose.desktop {\n    application {\n    }\n}\n",
      );
      const lane = detect(dir).lanes[0];
      expect(lane?.stack).toBe("compose-desktop");
      expect(lane?.markers).toEqual(["build.gradle.kts"]);
      expect(lane?.verbs["run"]).toMatchObject({ exe: "./gradlew", argv: ["run"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nen shu detect -- a nested build is attributed to itself, never to its parent", () => {
  /** Root wrapper, root settings, and a `program/` that is a build of its own. */
  function nestedBuild(dir: string, ownWrapper: boolean): void {
    writeFileSync(join(dir, "gradlew"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(dir, "settings.gradle.kts"), 'rootProject.name = "placeholder"\n');
    mkdirSync(join(dir, "program"));
    writeFileSync(
      join(dir, "program", "settings.gradle.kts"),
      'rootProject.name = "placeholder-desktop"\n',
    );
    writeFileSync(
      join(dir, "program", "build.gradle.kts"),
      "compose.desktop {\n    application {\n    }\n}\n",
    );
    if (ownWrapper) writeFileSync(join(dir, "program", "gradlew"), "#!/bin/sh\nexit 0\n");
  }

  // THE MUTANT THIS KILLS: stopping the refinement descent only at a directory
  // that ships its own WRAPPER. A nested build with its own settings file and
  // no wrapper had its build files read as evidence about the root, and the
  // root was proposed a `compose-desktop` lane at cwd `.` whose `./gradlew run`
  // pointed the ROOT wrapper at a build that wrapper never reads.
  it("proposes exactly one lane for a root wrapper plus a nested settings file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-nested-settings-"));
    try {
      nestedBuild(dir, false);
      mkdirSync(join(dir, "app"));
      writeFileSync(
        join(dir, "app", "build.gradle.kts"),
        'plugins {\n    id("com.android.application")\n}\n',
      );
      const report = detect(dir);
      expect(report.lanes).toHaveLength(1);
      expect(report.lanes[0]?.stack).toBe("gradle-android");
      expect(report.lanes[0]?.cwd).toBe(".");
      // And the build nen stopped at and could not address is a FINDING, said
      // out loud -- a silent drop reads exactly like an empty tree.
      expect(report.notes.join("\n")).toContain(
        "program carries its own build settings, so the scan stopped there",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("proposes it as its OWN lane once it ships its own wrapper, with no finding", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-nested-wrapper-"));
    try {
      nestedBuild(dir, true);
      const report = detect(dir);
      expect(report.lanes.map((lane): string => lane.cwd)).toEqual(["program"]);
      expect(report.lanes[0]?.stack).toBe("compose-desktop");
      expect(report.notes.join("\n")).not.toContain("carries its own build settings");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A build the LANE'S SETTINGS FILE INCLUDES is addressable, and the pack's
  // bare task names are that module's: `run` at the root would run the ROOT
  // project's `run`, which is a different command with the same spelling.
  it("qualifies every bare task with the module a nested carrier is included as", () => {
    const lane = detect(markerTree("compose-desktop")).lanes[0];
    expect(lane?.cwd).toBe(".");
    expect(lane?.verbs["run"]).toMatchObject({ exe: "./gradlew", argv: [":desktop:run"] });
    expect(lane?.notes.join("\n")).toContain("includes as the module ':desktop'");
  });

  // ...and where it is included under a DIFFERENT name, that name is the one
  // proposed, because the module path is the repository's word and not nen's.
  it("uses the module name the settings file states, not the directory name", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-remapped-module-"));
    try {
      cpSync(markerTree("compose-desktop"), dir, { recursive: true });
      writeFileSync(
        join(dir, "settings.gradle.kts"),
        'include(":ui")\nproject(":ui").projectDir = file("desktop")\n',
      );
      expect(detect(dir).lanes[0]?.verbs["run"]).toMatchObject({ argv: [":ui:run"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // AND WHERE IT IS INCLUDED NOWHERE, NOTHING IS PROPOSED. The build is neither
  // a module this lane's wrapper can address nor a build of its own, so every
  // row goes rather than one naming a project Gradle would not resolve.
  it("withholds every row when the carrier is in a directory no module names", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-unaddressable-"));
    try {
      cpSync(markerTree("compose-desktop"), dir, { recursive: true });
      writeFileSync(join(dir, "settings.gradle.kts"), 'rootProject.name = "placeholder"\n');
      const lane = detect(dir).lanes[0];
      expect(lane?.stack).toBe("compose-desktop");
      expect(commandRows(lane?.verbs)).toEqual([]);
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toContain("includes no module there");
      expect(notes).toContain("nen proposes no row it cannot address");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nen shu detect -- the host a {gw} was resolved for is written down", () => {
  // THE MUTANT THIS KILLS: resolving `{gw}` and saying nothing about it. The
  // declaration is committed and read by a whole team; the word inside it is
  // true for exactly the host that ran `detect`, and a teammate on the other
  // host gets exit 5 "the declared program could not be started" for a wrapper
  // that IS in the tree, under the other name.
  for (const { platform, exe } of [
    { platform: "linux", exe: "./gradlew" },
    { platform: "win32", exe: "gradlew.bat" },
  ] as const) {
    it(`names the platform and the spelling it wrote, on ${platform}`, () => {
      const report = detect(KRO_SHAPED, platform);
      for (const lane of report.lanes) {
        const notes = lane.notes.join("\n");
        expect(notes, lane.lane).toContain(`{gw} in this lane's proposed rows was resolved for ${platform}`);
        expect(notes, lane.lane).toContain(`nen wrote '${exe}'`);
        expect(notes, lane.lane).toContain("must re-run `nen shu detect` or hand-edit the spelling");
      }
      // AND `hosts` IS NOT NARROWED. Narrowing per spelling would turn a
      // one-word edit into exit 3 "unsupported host", which is false about a
      // stack the pack states runs everywhere.
      expect((report.proposal as unknown as Proposal).project.hosts).toEqual({
        "*": ["darwin", "linux", "win32"],
      });
    });
  }

  it("says nothing about a host token no proposed row carries", () => {
    // A lane whose every row was withheld has no resolved spelling to warn
    // about, and a note that fires anyway is noise on the one output where a
    // reader is already being asked to read several.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-no-host-note-"));
    try {
      cpSync(KRO_SHAPED, dir, { recursive: true });
      rmSync(join(dir, "gradlew"));
      const lane = detect(dir, "linux").lanes.find(
        (entry): boolean => entry.stack === "gradle-android",
      );
      expect(commandRows(lane?.verbs)).toEqual([]);
      expect(lane?.notes.join("\n")).not.toContain("was resolved for linux");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nen shu detect -- two Gradle builds in one tree", () => {
  it("proposes two lanes, names them from the tree, and picks neither", () => {
    const report = detect(KRO_SHAPED);
    expect(report.exitCode).toBe(0);
    expect(report.lanes.map((lane): string => lane.lane)).toEqual(["gradle-android", "program"]);
    expect(report.lanes.map((lane): string => lane.stack)).toEqual([
      "gradle-android",
      "compose-desktop",
    ]);
    expect(report.lanes.map((lane): string => lane.cwd)).toEqual([".", "program"]);
    expect(report.lanes.map((lane): readonly string[] => lane.markers)).toEqual([
      ["app/build.gradle.kts"],
      ["program/build.gradle.kts"],
    ]);
    expect((report.proposal as unknown as Proposal).project.defaultLane).toBeNull();
    expect(report.notes.join("\n")).toMatch(/2 lanes were found, so defaultLane is null/);
  });

  // THE MUTANT THIS KILLS: letting the root's refinement search descend into a
  // directory that ships its own wrapper. `program/` is a wholly separate
  // build, so a marker inside it is evidence about IT -- and without the stop
  // the root was ALSO proposed as a desktop lane: three lanes for two builds,
  // one of them pointing the root's own wrapper at a build file it never reads.
  it("never proposes the nested build's stack at the root as well", () => {
    const report = detect(KRO_SHAPED);
    expect(report.lanes).toHaveLength(2);
    expect(
      report.lanes.filter((lane): boolean => lane.cwd === ".").map((lane): string => lane.stack),
    ).toEqual(["gradle-android"]);
    expect(report.notes.join("\n")).not.toMatch(/carries markers for 2 stacks/);
  });

  it("merges the two lanes' agreed platforms into the one hosts block", () => {
    // The contract's `hosts` is keyed by VERB, not by lane, so a per-lane map
    // can only be proposed where the lanes AGREE. These two do, so the block is
    // the map either of them states -- not a widening of one by the other.
    const report = detect(KRO_SHAPED);
    expect((report.proposal as unknown as Proposal).project.hosts).toEqual({
      "*": ["darwin", "linux", "win32"],
    });
    expect(report.notes.join("\n")).not.toMatch(/keyed by VERB rather than by lane/);
  });
});

describe("nen shu detect -- the paparazzi rule survives into the declaration", () => {
  // THE MUTANT THIS KILLS, and the one zheref/nen#117 names by hand: dropping
  // or "simplifying" the `why`. Without it the row is an argv that looks
  // interchangeable with the obvious one -- and the obvious one reports PASSED
  // while a golden is being overwritten.
  it("carries the pack's `why` verbatim onto the proposed test row", () => {
    const why = String((detect(KRO_SHAPED).lanes[0]?.verbs["test"] as { why?: string }).why);
    expect(why).toContain("verifyPaparazziDebug");
    expect(why).toContain("testDebugUnitTest");
    expect(why).toContain(
      "replacing a golden with a completely different image still reports PASSED",
    );
    // And it is the PACK's sentence rather than a paraphrase of it.
    const cell = verbCell(profileById(loadProfilesPack(), "gradle-android"), "test");
    expect(cell.kind).toBe("command");
    if (cell.kind === "command" && cell.invocation.kind === "command") {
      expect(why).toBe(cell.invocation.why);
    }
  });

  it("reports the canon-vs-CI conflict as a NOTE, and encodes neither side", () => {
    // Two canonical sources disagree about which task this verb runs. That has
    // to reach the maintainer -- it is a bug in one of them -- and it must
    // never reach an argv, because an argv is the thing that gets pasted.
    const notes = detect(KRO_SHAPED).lanes[0]?.notes.join("\n") ?? "";
    expect(notes).toMatch(/A CONFLICT THIS PACK RECORDS AND REFUSES TO RESOLVE/);
    expect(notes).toMatch(/bankai-core's compose handbook/);
    expect(notes).toMatch(/Resolve it upstream in whichever source is wrong/);
    const project = (detect(KRO_SHAPED).proposal as unknown as Proposal).project;
    for (const [lane, verbs] of Object.entries(project.verbs)) {
      for (const [verb, row] of Object.entries(verbs)) {
        for (const word of (row as { argv?: string[] }).argv ?? []) {
          expect(word, `${lane}/${verb}`).not.toContain("testDebugUnitTest");
        }
      }
    }
    // It IS in the file, in the one place that explains it: the row's `why`.
    expect(JSON.stringify(project.verbs)).toContain("testDebugUnitTest");
  });

  it("prints the conflict where a maintainer reading the proposal will see it", () => {
    expect(renderDetect(detect(KRO_SHAPED)).join("\n")).toMatch(
      /\^ the reference pack's own note on gradle-android: A CONFLICT/,
    );
  });
});

describe("nen shu detect -- the two Gradle lanes, end to end through the executor", () => {
  // EVERY PROPOSED ROW, WRITTEN AND THEN RUN, on both hosts. `detect --write`
  // produces the declaration and `--dry-run` renders it back: the argv is
  // pinned as a literal line, because a golden that matches loosely is one that
  // survives the change it exists to catch.
  const LINES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    linux: {
      "build --lane gradle-android": "would run:     ./gradlew assembleDebug --stacktrace",
      "test --lane gradle-android":
        "would run:     ./gradlew verifyPaparazziDebug :PlaceholderCore:test --stacktrace",
      "ui-test --lane gradle-android": "would run:     ./gradlew verifyPaparazziDebug",
      "lint --lane gradle-android": "would run:     ./gradlew :app:lintDebug --stacktrace",
      "run --lane program": "would run:     ./gradlew run",
    },
    win32: {
      "build --lane gradle-android": "would run:     gradlew.bat assembleDebug --stacktrace",
      "test --lane gradle-android":
        "would run:     gradlew.bat verifyPaparazziDebug :PlaceholderCore:test --stacktrace",
      "ui-test --lane gradle-android": "would run:     gradlew.bat verifyPaparazziDebug",
      "lint --lane gradle-android": "would run:     gradlew.bat :app:lintDebug --stacktrace",
      "run --lane program": "would run:     gradlew.bat run",
    },
  };

  for (const platform of ["linux", "win32"] as const) {
    it(`writes a declaration whose every row runs, on ${platform}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `nen-golden-gradle-${platform}-`));
      try {
        cpSync(KRO_SHAPED, dir, { recursive: true });
        expect((await capture(["detect", "--write"], dir, platform)).code).toBe(0);
        for (const [invocation, line] of Object.entries(LINES[platform] ?? {})) {
          const result = await capture([...invocation.split(" "), "--dry-run"], dir, platform);
          expect(result.code, invocation).toBe(0);
          expect(
            result.out.filter((out): boolean => out.startsWith("would run:")),
            invocation,
          ).toEqual([line]);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("refuses every proposed unsupported row at exit 4, quoting the pack's sentence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-golden-gradle-unsup-"));
    try {
      cpSync(KRO_SHAPED, dir, { recursive: true });
      expect((await capture(["detect", "--write"], dir)).code).toBe(0);
      const verbs = detect(dir).lanes[0]?.verbs;
      expect(unsupportedRows(verbs)).toEqual([
        "archive",
        "coverage",
        "deploy",
        "dev",
        "release",
        "run",
      ]);
      for (const verb of ["archive", "coverage", "dev", "release", "run"]) {
        const result = await capture([verb, "--dry-run", "--lane", "gradle-android"], dir);
        expect(result.code, verb).toBe(4);
        expect(result.err.join("\n"), verb).toContain(reasonOf(verbs, verb));
      }
      // `deploy` never reaches the verb: --target is checked FIRST by design,
      // and this proposal declares no target -- the same order the nextjs
      // golden pins, for the same reason.
      const deploy = await capture(
        ["deploy", "--dry-run", "--lane", "gradle-android", "--target", "x"],
        dir,
      );
      expect(deploy.code).toBe(2);
      expect(deploy.err.join("\n")).toMatch(/declares no targets at all/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE OTHER HALF OF `{gw}`: nen substitutes it at PROPOSAL time, and the
  // executor refuses it at SPAWN time. Both must be true -- the first so a
  // declaration carries a runnable word, the second so a hand-written one that
  // does not is a refusal naming the token rather than a child process called
  // `{gw}`.
  it("still refuses an unsubstituted {gw} in a hand-written declaration, at exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-gw-unsubstituted-"));
    try {
      mkdirSync(join(dir, "nen"), { recursive: true });
      writeFileSync(
        join(dir, "nen", "contract.json"),
        JSON.stringify({
          $schema: "nen.contract/v0.1",
          project: {
            lanes: { app: { stack: "gradle-android", cwd: "." } },
            defaultLane: "app",
            verbs: { app: { build: { exe: "{gw}", argv: ["assembleDebug"] } } },
            hosts: {},
          },
        }),
      );
      const result = await capture(["build", "--dry-run"], dir);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(
        /'build' on lane 'app' names a placeholder nen cannot substitute: \{gw\}/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── the expo stack, and the native lanes a bare workflow proposes ───────────
//
// THE TREE UNDER TEST is ./fixtures/expo-bare/, a three-lane repository shaped
// like the one the catalogue read (zheref/food-diary) with every name replaced:
// a Metro lane at the root, and `ios/` and `android/` prebuild output committed
// beside it. Its iOS half reproduces the finding that made this stack worth a
// cross-check of its own -- a shared scheme whose test action names a target
// the project does not contain, which fails a test run on a CLEAN CHECKOUT and
// which no amount of filling placeholders in would fix.
//
// THE MUTANTS THESE KILL, each stated where it is killed:
//
//   1. `build` PROPOSED FOR expo. The reference `run` row builds AND launches,
//      so a `build` row on this stack is a row that starts an application on
//      somebody's simulator the first time a script asks for a compile. Two
//      assertions hold it: the pack's cell must be `unsupported`, and no expo
//      lane in any fixture may carry a `build` COMMAND row.
//   2. `{platform}` PROPOSED UNSUBSTITUTED. The row must stay withheld even
//      though this lane's own scripts spell both values -- SEEING a value and
//      CHOOSING one are different acts, and only the second is forbidden.
//   3. THE SCHEME CROSS-CHECK DISABLED. With the check gone, `test` is withheld
//      naming three placeholders and says nothing about the scheme, which reads
//      as "state these three and the row runs". It does not run.

describe("nen shu detect -- the expo stack, three lanes in one tree", () => {
  const bare = (): DetectReport => detect(EXPO_BARE);
  const laneNamed = (name: string): DetectedLane | undefined =>
    bare().lanes.find((lane): boolean => lane.lane === name);

  it("proposes the Metro lane and both native siblings, and chooses none of them", () => {
    const report = bare();
    expect(report.exitCode).toBe(0);
    expect(report.lanes.map((lane): string => `${lane.lane}:${lane.stack}:${lane.cwd}`)).toEqual([
      "expo:expo:.",
      "android:gradle-android:android",
      "ios:xcode-ios:ios",
    ]);
    const proposal = report.proposal as unknown as Proposal;
    expect(proposal.project.defaultLane).toBeNull();
    // THREE LANES, TWO HOST SIGNATURES: the Apple lane runs on darwin alone and
    // the other two run anywhere, so no `hosts` block is proposed and the note
    // says why. A UNION here would let `nen shu test --lane ios` start on linux.
    expect(proposal.project.hosts).toEqual({});
    expect(report.notes.join("\n")).toMatch(/the lanes need different platforms/);
  });

  // WHAT THE GRADLE READER ANSWERS ABOUT THE `android/` HALF, on every host.
  // Prebuild output is a `gradle-android` lane like any other -- it ships its
  // own wrapper (both spellings, because `expo prebuild` writes both) and its
  // own `settings.gradle` -- so three rows are proposed with `{gw}` resolved
  // for the host, and `test` alone stays withheld: that settings file includes
  // `:app`, `:app` applies the plugin that identified the lane, and an
  // application module is not the library `{unitTestTask}` needs. Nothing about
  // the Metro lane above it changes any of that; the two are related in a note
  // and merged nowhere.
  for (const { platform, exe } of [
    { platform: "darwin", exe: "./gradlew" },
    { platform: "linux", exe: "./gradlew" },
    { platform: "win32", exe: "gradlew.bat" },
  ] as const) {
    it(`proposes the native android lane's own rows on ${platform}, and withholds only {unitTestTask}`, () => {
      const android = detect(EXPO_BARE, platform).lanes.find(
        (lane): boolean => lane.lane === "android",
      );
      expect(commandRows(android?.verbs)).toEqual(["build", "lint", "ui-test"]);
      expect(android?.verbs["build"], platform).toMatchObject({
        exe,
        argv: ["assembleDebug", "--stacktrace"],
      });
      const notes = android?.notes.join("\n") ?? "";
      expect(notes, platform).toMatch(/'test' withheld: .*\{unitTestTask\}/);
      // The reason is the SETTINGS FILE's, read from this lane's own tree --
      // not a Node-shaped one about a manifest that is not there.
      expect(notes, platform).toMatch(/settings\.gradle includes :app/);
      expect(notes, platform).not.toMatch(/no readable package\.json/);
      // And the host the word was resolved for is recorded beside the rows.
      expect(notes, platform).toContain(
        `{gw} in this lane's proposed rows was resolved for ${platform}: nen wrote '${exe}'`,
      );
    });
  }

  it("relates the native lanes to the manifest that generates them, and merges nothing", () => {
    // The phrase is matched in its SINGULAR form on purpose: the note says
    // "SIBLING LANE" for one child and "SIBLING LANES" for several, and an
    // assertion that only knew the plural let a mutant that fires the note on
    // a one-child tree through unnoticed.
    const note = bare().notes.find((entry): boolean => entry.includes("SIBLING LANE"));
    expect(note).toBeDefined();
    // BOTH markers are named, because the pack's rule is a conjunction and the
    // note is only allowed to speak when the conjunction is met.
    expect(note).toMatch(/the lane 'expo' names 'ios' AND 'android' among its OWN markers/);
    expect(note).toMatch(/'android' \(gradle-android, cwd android\)/);
    expect(note).toMatch(/'ios' \(xcode-ios, cwd ios\)/);
    // The relationship is stated and the decision is not taken.
    expect(note).toMatch(/is a decision this repository makes/);
    // And the pack's own sentence for the marker is what carries the claim.
    expect(note).toMatch(/prebuild output is committed, and the native lanes are real/);
    // Nothing here is described as unrelated, because nothing here is.
    expect(note).not.toMatch(/nen also found/);
  });

  // M1. THE PAYLOAD IS THE DECLARED CHILDREN, NOT EVERY NESTED LANE. A `site/`
  // Next.js build beside a bare Expo tree is hand-written, and the first draft
  // of this note swept it into "SIBLING LANES ... generated native output
  // committed beside the manifest" on the strength of `ios/` firing the gate.
  // Building the payload from `children` again turns this red.
  it("never calls an UNRELATED nested lane generated native output", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-expo-unrelated-child-"));
    try {
      cpSync(EXPO_BARE, dir, { recursive: true });
      cpSync(NEXTJS_SINGLE, join(dir, "site"), { recursive: true });
      const note = detect(dir).notes.find((entry): boolean => entry.includes("SIBLING LANE"));
      expect(note).toBeDefined();
      // The sibling list is exactly the two the profile names.
      expect(note).toContain(
        "nen found a lane in each of them: 'android' (gradle-android, cwd android), 'ios' (xcode-ios, cwd ios).",
      );
      // And the unrelated lane is named in a clause that claims NOTHING.
      expect(note).toMatch(/nen also found 'site' \(nextjs, cwd site\) directly inside 'expo'/);
      expect(note).toMatch(/this profile's markers do not name that directory/);
      expect(note).toMatch(/so nen relates it to nothing/);
      // The decisive assertion: the sibling sentence must not reach the site.
      expect(
        note?.slice(0, note.indexOf("nen also found")),
        "a hand-written Next.js build is not prebuild output",
      ).not.toContain("site");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // M2. THE GATE IS THE CONJUNCTION THE `why` DESCRIBES. The pack says "`ios/`
  // AND `android/` both present means the BARE workflow"; a note that fires on
  // `ios/` alone quotes a sentence that is not true of the tree it is printed
  // against. Loosening the gate back to "one declared child" turns this red.
  it("claims no bare workflow from ios/ alone, whose marker why requires both", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-expo-ios-only-"));
    try {
      cpSync(EXPO_BARE, dir, { recursive: true });
      rmSync(join(dir, "android"), { recursive: true, force: true });
      const report = detect(dir);
      // The Apple lane is still FOUND -- this is about the claim, not the scan.
      expect(report.lanes.map((lane): string => lane.cwd)).toEqual([".", "ios"]);
      expect(
        report.notes.join("\n"),
        "half a conjunction is a different tree, not a weaker claim",
      ).not.toMatch(/SIBLING LANE/);
      expect(report.notes.join("\n")).not.toMatch(/BARE workflow/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A NESTED LANE IS NOT A SIBLING LANE, and the gate that says so is the
  // parent profile's OWN marker table rather than the nesting. This tree has a
  // lane DIRECTLY inside another -- the same shape the note fires on -- and
  // `nextjs` names no directory among its markers, so nothing is claimed about
  // the relationship. Widening the gate to any nesting turns this red.
  it("says nothing of the kind about a lane merely nested inside another", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-nested-not-sibling-"));
    try {
      writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n", "utf8");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "root", devDependencies: { next: "15.1.0" } }),
        "utf8",
      );
      cpSync(GATSBY_SITE, join(dir, "site"), { recursive: true });
      const report = detect(dir);
      expect(report.lanes.map((lane): string => lane.cwd)).toEqual([".", "site"]);
      expect(
        report.notes.join("\n"),
        "the gate is the pack's marker table, not the nesting",
      ).not.toMatch(/SIBLING LANE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // And the same for a workspace root's members, which are one level deeper.
    expect(detect(NEXTJS_WORKSPACES).notes.join("\n")).not.toMatch(/SIBLING LANE/);
  });

  it("proposes exactly the two rows this lane's own manifest confirms", () => {
    const lane = laneNamed("expo");
    expect(commandRows(lane?.verbs)).toEqual(["dev", "lint"]);
    // THE ARGV IS THE PACK'S, verbatim -- `detect` names no tool of its own.
    const profile = profileById(loadProfilesPack(), "expo");
    for (const verb of ["dev", "lint"]) {
      const cell = verbCell(profile, verb);
      expect(cell.kind, verb).toBe("command");
      if (cell.kind !== "command" || cell.invocation.kind !== "command") continue;
      const invocation = cell.invocation;
      expect(lane?.verbs[verb], verb).toEqual({
        exe: invocation.exe,
        argv: invocation.argv,
        why: invocation.why,
      });
    }
  });

  // MUTANT 1.
  it("NEVER proposes a build row for this stack, and seats the pack's reason instead", () => {
    const cell = verbCell(profileById(loadProfilesPack(), "expo"), "build");
    expect(cell.kind, "the catalogue's own cell is what makes this true").toBe("unsupported");
    for (const tree of [EXPO_BARE, markerTree("expo")]) {
      for (const lane of detect(tree).lanes.filter((entry): boolean => entry.stack === "expo")) {
        expect(commandRows(lane.verbs), tree).not.toContain("build");
        expect(unsupportedRows(lane.verbs), tree).toContain("build");
        expect(reasonOf(lane.verbs, "build")).toMatch(
          /build AND launch, there is no build-only invocation/,
        );
        expect(reasonOf(lane.verbs, "build")).toMatch(
          /Conflating the two would make `nen shu build` launch an app/,
        );
      }
    }
  });

  // MUTANT 2.
  it("withholds run, names both values its own scripts spell, and says where to state one", () => {
    const lane = laneNamed("expo");
    expect(commandRows(lane?.verbs)).not.toContain("run");
    expect(unsupportedRows(lane?.verbs)).not.toContain("run");
    const note = lane?.notes.find((entry): boolean => entry.startsWith("'run' withheld"));
    expect(note).toBeDefined();
    expect(note).toMatch(/still names \{platform\}/);
    expect(note).toMatch(/spell \{platform\}'s position 2 ways/);
    expect(note).toMatch(/android, in 'android': expo run:android/);
    expect(note).toMatch(/ios, in 'ios': expo run:ios/);
    expect(note).toMatch(/still will not pick one/);
    expect(note).toMatch(
      /State it under project\.verbs\.expo\.run, or give each value a lane of its own/,
    );
  });

  // The near-miss reader is the one that must NOT fire here: `expo start` and
  // `expo lint` have the same word count as the reference `run` row and answer
  // nothing, because the position they differ at is not a whole token.
  it("does not report an unrelated script of the same length as a near miss", () => {
    const note = laneNamed("expo")?.notes.find((entry): boolean =>
      entry.startsWith("'run' withheld"),
    );
    expect(note).not.toMatch(/nothing corroborates the match/);
    expect(note).not.toMatch(/'lint': expo lint/);
  });
});

describe("nen shu detect -- the Apple lane's scheme, read against the project's targets", () => {
  const iosNote = (repo: string, verb: string): string =>
    detect(repo)
      .lanes.find((lane): boolean => lane.stack === "xcode-ios")
      ?.notes.find((entry): boolean => entry.startsWith(`'${verb}' withheld`)) ?? "";

  // MUTANT 3.
  it("withholds test naming the target the scheme asks for and the project has not got", () => {
    const note = iosNote(EXPO_BARE, "test");
    expect(note).toMatch(/still names \{project\}, \{scheme\}, \{simUdid\}/);
    expect(note).toMatch(/TEST ACTION IS BROKEN ON A CLEAN CHECKOUT/);
    // THE FILE IS PART OF THE SUBJECT, not just the name -- see the duplicate
    // -name case below.
    expect(note).toContain(
      "'Placeholder' (Placeholder.xcodeproj/xcshareddata/xcschemes/Placeholder.xcscheme) names 'PlaceholderTests' (PlaceholderTests.xctest)",
    );
    expect(note).toMatch(/this lane's project declares no such target -- it declares Placeholder/);
    expect(note).toMatch(/a test on that scheme fails before .* matters/);
  });

  // n1. TWO SCHEMES OF THE SAME NAME ARE TWO FILES. A repository that keeps a
  // shared scheme in its `.xcworkspace` AND its `.xcodeproj` earned two
  // byte-identical paragraphs, which read as one printed twice rather than as
  // two files a maintainer must edit apart. Dropping the file back out of the
  // clause turns this red.
  it("tells two same-named schemes apart by the file each one lives in", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-expo-scheme-twice-"));
    try {
      cpSync(EXPO_BARE, dir, { recursive: true });
      const shared = join(dir, "ios", "Placeholder.xcworkspace", "xcshareddata", "xcschemes");
      mkdirSync(shared, { recursive: true });
      cpSync(
        join(dir, "ios", "Placeholder.xcodeproj", "xcshareddata", "xcschemes", "Placeholder.xcscheme"),
        join(shared, "Placeholder.xcscheme"),
      );
      const note = iosNote(dir, "test");
      const paragraphs = note
        .split(" -- ")
        .filter((clause): boolean => clause.includes("BROKEN ON A CLEAN CHECKOUT"));
      expect(paragraphs, "one finding per FILE").toHaveLength(2);
      expect(new Set(paragraphs).size, "and the two must not be byte-identical").toBe(2);
      expect(note).toContain("Placeholder.xcworkspace/xcshareddata/xcschemes/Placeholder.xcscheme");
      expect(note).toContain("Placeholder.xcodeproj/xcshareddata/xcschemes/Placeholder.xcscheme");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the shared scheme it found, by name and by file, and substitutes none of it", () => {
    const note = iosNote(EXPO_BARE, "build");
    expect(note).toMatch(
      /the shared scheme nen can see here is 'Placeholder' \(Placeholder\.xcodeproj\/xcshareddata\/xcschemes\/Placeholder\.xcscheme\)/,
    );
    expect(note).toMatch(/which scheme a verb means is this repository's decision, not a count/);
    // The row is still WITHHELD. Reading a scheme name off the disk is not the
    // same act as deciding which scheme a verb means.
    const lane = detect(EXPO_BARE).lanes.find((entry): boolean => entry.stack === "xcode-ios");
    expect(commandRows(lane?.verbs)).toEqual([]);
  });

  it("says the container is a workspace, which the reference row's own flag does not address", () => {
    expect(iosNote(EXPO_BARE, "build")).toMatch(
      /this lane's container is a WORKSPACE \(Placeholder\.xcworkspace\)/,
    );
  });

  // THE OTHER HALF OF THE CROSS-CHECK, and the one a checked-in fixture cannot
  // carry because the point is the ABSENCE of a finding: a project that
  // declares the target its scheme names earns the token reason and no more.
  it("makes no such claim when the project DOES declare the target the scheme names", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-expo-scheme-ok-"));
    try {
      cpSync(EXPO_BARE, dir, { recursive: true });
      const pbxproj = join(dir, "ios", "Placeholder.xcodeproj", "project.pbxproj");
      writeFileSync(
        pbxproj,
        readFileSync(pbxproj, "utf8").replace(
          "/* End PBXNativeTarget section */",
          [
            "\t\t00E356ED1AD99517003FC87E /* PlaceholderTests */ = {",
            "\t\t\tisa = PBXNativeTarget;",
            "\t\t\tname = PlaceholderTests;",
            "\t\t};",
            "/* End PBXNativeTarget section */",
          ].join("\n"),
        ),
        "utf8",
      );
      const note = iosNote(dir, "test");
      expect(note).toMatch(/still names \{project\}, \{scheme\}, \{simUdid\}/);
      expect(note, "the finding must be GONE, not merely reworded").not.toMatch(
        /BROKEN ON A CLEAN CHECKOUT/,
      );
      // The scheme is still NAMED -- that half is about what is on disk, not
      // about whether the scheme works.
      expect(note).toMatch(/the shared scheme nen can see here is 'Placeholder'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // FAIL CLOSED. A project file nen cannot parse is one nen knows nothing
  // about, and reporting every scheme in the lane as broken on the strength of
  // an unfamiliar format is the worst answer available.
  it("makes NO claim at all when it cannot read a target list", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-expo-scheme-unreadable-"));
    try {
      cpSync(EXPO_BARE, dir, { recursive: true });
      writeFileSync(
        join(dir, "ios", "Placeholder.xcodeproj", "project.pbxproj"),
        "// a format this reader does not know\n",
        "utf8",
      );
      const note = iosNote(dir, "test");
      expect(note).toMatch(/could not read a native-target list out of Placeholder\.xcodeproj/);
      // THE FILE IS NAMED, not just the bundle: `project.pbxproj` is what nen
      // opened and what a maintainer has to go and look at.
      expect(note).toContain("Placeholder.xcodeproj/project.pbxproj");
      expect(note).toMatch(/a cross-check nen could not perform is not one that passed/);
      expect(note).not.toMatch(/BROKEN ON A CLEAN CHECKOUT/);
      // Nothing parsed, so there is no second half to this clause.
      expect(note).not.toMatch(/did parse/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── the PARTIAL read, which is the hole the all-or-nothing union closes ────
  //
  // A lane may hold more than one `.xcodeproj`, and the first draft merged the
  // ones that parsed and skipped the ones that did not (`if (declared === null)
  // continue;`). That left `targets` non-null and INCOMPLETE, and an incomplete
  // list is read downstream as licence to call a scheme broken: a scheme whose
  // test target lives in the project nen could not read was reported as BROKEN
  // ON A CLEAN CHECKOUT on the strength of a cross-check never performed.

  /** A second `.xcodeproj` in the lane, declaring exactly `targets`. */
  const addProject = (dir: string, name: string, targets: readonly string[] | null): void => {
    const bundle = join(dir, "ios", `${name}.xcodeproj`);
    mkdirSync(bundle, { recursive: true });
    writeFileSync(
      join(bundle, "project.pbxproj"),
      targets === null
        ? "// a format this reader does not know\n"
        : [
            "// !$*UTF8*$!",
            "{",
            "\tobjects = {",
            "/* Begin PBXNativeTarget section */",
            ...targets.flatMap((target, index): readonly string[] => [
              `\t\tFEED000${index} /* ${target} */ = {`,
              "\t\t\tisa = PBXNativeTarget;",
              `\t\t\tname = ${target};`,
              "\t\t};",
            ]),
            "/* End PBXNativeTarget section */",
            "\t};",
            "}",
          ].join("\n"),
      "utf8",
    );
  };

  // MUTANT: restore `if (declared === null) continue;` in `readAppleLane` and
  // this goes red -- `Placeholder.xcodeproj` parses, its lone target is
  // `Placeholder`, and the scheme's `PlaceholderTests` gets called missing on a
  // target list that never asked `Extra.xcodeproj` a thing.
  it("withholds the whole cross-check when only SOME of the lane's projects parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-expo-scheme-partial-"));
    try {
      cpSync(EXPO_BARE, dir, { recursive: true });
      addProject(dir, "Extra", null);
      const note = iosNote(dir, "test");
      // The finding is GONE, because it was never nen's to make.
      expect(note, "a partial target list is not a cross-check").not.toMatch(
        /BROKEN ON A CLEAN CHECKOUT/,
      );
      // And the note names the file that stopped it -- that one, not the lane.
      expect(note).toContain("Extra.xcodeproj/project.pbxproj");
      expect(note, "the readable project is not the unreadable one").not.toContain(
        "Placeholder.xcodeproj/project.pbxproj",
      );
      expect(note).toMatch(/a cross-check nen could not perform is not one that passed/);
      // The dropped half is stated out loud rather than left as silence a
      // reader would take for "and Placeholder.xcodeproj checked out fine".
      expect(note).toContain("Placeholder.xcodeproj did parse");
      expect(note).toMatch(/WITHHELD ALL THE SAME/);
      // The scheme is still NAMED. Withholding the target claim is not
      // withholding what is plainly on disk.
      expect(note).toMatch(/the shared scheme nen can see here is 'Placeholder'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE UNION STILL WORKS. Withholding on ONE unreadable project must not
  // become withholding whenever a lane has two projects: a target declared by
  // the SECOND one answers the scheme just as well as the first.
  it("answers the scheme from the second project when every project parses", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-expo-scheme-union-"));
    try {
      cpSync(EXPO_BARE, dir, { recursive: true });
      addProject(dir, "Extra", ["PlaceholderTests"]);
      const note = iosNote(dir, "test");
      expect(note, "the target exists, in the other project").not.toMatch(
        /BROKEN ON A CLEAN CHECKOUT/,
      );
      expect(note, "every project parsed, so nothing is withheld").not.toMatch(
        /could not read a native-target list/,
      );
      // The row is still withheld for its tokens, which is a different reason.
      expect(note).toMatch(/still names \{project\}, \{scheme\}, \{simUdid\}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A scheme kept in `xcuserdata/` belongs to one developer's checkout. Nen
  // reads the SHARED directory only, and says so rather than reporting a name a
  // colleague's clone has not got.
  it("reports no shared scheme when the lane has none, and names where it looked", () => {
    const note =
      detect(markerTree("xcode")).lanes[0]?.notes.find((entry): boolean =>
        entry.startsWith("'build' withheld"),
      ) ?? "";
    expect(note).toMatch(/nen found no SHARED scheme in this lane/);
    expect(note).toMatch(/<container>\/xcshareddata\/xcschemes\//);
    expect(note).toMatch(/a scheme under xcuserdata\/ is one developer's checkout/);
  });

  // ── one testable is one unit ───────────────────────────────────────────────
  //
  // The reader these four cases pin replaced one that swept the whole test
  // action for `BlueprintName`s and `BuildableName`s, de-duplicated each list
  // apart, and paired them BY INDEX. That holds for the fixture's single
  // testable and for nothing else a real repository ships: a shared product, a
  // `<MacroExpansion>`, or a `skipped` reference each knock the two lists out
  // of step, and the clause then names a pair the scheme never wrote.

  /** The lane's shared scheme, rewritten with a `<TestAction>` body of your own. */
  const withTestAction = (dir: string, body: string): void => {
    writeFileSync(
      join(dir, "ios", "Placeholder.xcodeproj", "xcshareddata", "xcschemes", "Placeholder.xcscheme"),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Scheme LastUpgradeVersion = "1430" version = "1.3">',
        '   <BuildAction parallelizeBuildables = "YES">',
        "   </BuildAction>",
        '   <TestAction buildConfiguration = "Debug">',
        "      <Testables>",
        body,
        "      </Testables>",
        "   </TestAction>",
        "</Scheme>",
      ].join("\n"),
      "utf8",
    );
  };

  /** One `<TestableReference>`, written as Xcode writes one. */
  const testable = (
    blueprint: string,
    buildable: string,
    options: { readonly skipped?: boolean; readonly reversed?: boolean } = {},
  ): string =>
    [
      `         <TestableReference skipped = "${options.skipped === true ? "YES" : "NO"}">`,
      "            <BuildableReference",
      '               BuildableIdentifier = "primary"',
      // THE ORDER IS THE POINT of one case below: Xcode writes the buildable
      // first today, and nothing about the format promises it always will.
      ...(options.reversed === true
        ? [
            `               BlueprintName = "${blueprint}"`,
            `               BuildableName = "${buildable}"`,
          ]
        : [
            `               BuildableName = "${buildable}"`,
            `               BlueprintName = "${blueprint}"`,
          ]),
      '               ReferencedContainer = "container:Placeholder.xcodeproj">',
      "            </BuildableReference>",
      "         </TestableReference>",
    ].join("\n");

  /** Extra native targets in the lane's own project, beside the fixture's `Placeholder`. */
  const declare = (dir: string, targets: readonly string[]): void => {
    const pbxproj = join(dir, "ios", "Placeholder.xcodeproj", "project.pbxproj");
    writeFileSync(
      pbxproj,
      readFileSync(pbxproj, "utf8").replace(
        "/* End PBXNativeTarget section */",
        [
          ...targets.flatMap((target, index): readonly string[] => [
            `\t\tFACE000${index} /* ${target} */ = {`,
            "\t\t\tisa = PBXNativeTarget;",
            `\t\t\tname = ${target};`,
            "\t\t};",
          ]),
          "/* End PBXNativeTarget section */",
        ].join("\n"),
      ),
      "utf8",
    );
  };

  /** A temp checkout of the bare lane, with a scheme and a target list of your own. */
  const laneWhere = (
    slug: string,
    body: string,
    targets: readonly string[],
    read: (note: string) => void,
  ): void => {
    const dir = mkdtempSync(join(tmpdir(), `nen-expo-scheme-${slug}-`));
    try {
      cpSync(EXPO_BARE, dir, { recursive: true });
      withTestAction(dir, body);
      if (targets.length > 0) declare(dir, targets);
      read(iosNote(dir, "test"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // MUTANT: restore the independent sweeps and the index pairing --
  // `blueprints.map((blueprint, index) => ({ blueprint, buildable:
  // buildables[index] ?? "" }))` -- and this goes red. `PlaceholderTests.xctest`
  // is written twice and survives de-duplication once, so the third reference's
  // product slides onto the second's blueprint and the note sends a maintainer
  // to a bundle that a target the project DOES declare builds.
  it("pairs a blueprint with the buildable from its OWN reference, not by index", () => {
    laneWhere(
      "shared-product",
      [
        testable("PlaceholderTests", "PlaceholderTests.xctest"),
        // Two bundles built from one product: legal, shipped, and the shape
        // that de-duplication silently collapsed.
        testable("PlaceholderUITests", "PlaceholderTests.xctest"),
        testable("PlaceholderSnapshotTests", "PlaceholderSnapshotTests.xctest"),
      ].join("\n"),
      ["PlaceholderTests", "PlaceholderSnapshotTests"],
      (note): void => {
        expect(note).toMatch(/TEST ACTION IS BROKEN ON A CLEAN CHECKOUT/);
        expect(note, "the missing blueprint, with the product ITS reference names").toContain(
          "names 'PlaceholderUITests' (PlaceholderTests.xctest) in its test action",
        );
        // The product of a target the project HAS must not be dragged into a
        // finding about a target it has not.
        expect(note, "a bundle no missing reference named").not.toContain(
          "PlaceholderSnapshotTests.xctest",
        );
      },
    );
  });

  // The two names are read off ONE element, so neither may depend on the order
  // the element spells them in.
  it("reads both names whichever order the reference writes them in", () => {
    laneWhere(
      "reversed",
      testable("PlaceholderUITests", "PlaceholderUITests.xctest", { reversed: true }),
      [],
      (note): void => {
        expect(note).toContain(
          "names 'PlaceholderUITests' (PlaceholderUITests.xctest) in its test action",
        );
      },
    );
  });

  // MUTANT: sweep every `<BuildableReference>` in the test action rather than
  // only those inside a `<TestableReference>`, and this goes red -- the macro
  // expansion's `Ghost` becomes a test target nobody declared, and a scheme
  // whose test action is sound is reported BROKEN ON A CLEAN CHECKOUT.
  it("does not read a MacroExpansion's reference as a test target", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-expo-scheme-macro-"));
    try {
      cpSync(EXPO_BARE, dir, { recursive: true });
      withTestAction(dir, testable("PlaceholderTests", "PlaceholderTests.xctest"));
      // The macro expansion sits in the test action and OUTSIDE `<Testables>`,
      // which is where Xcode puts it, and it names the app target rather than
      // a test one.
      const scheme = join(
        dir,
        "ios",
        "Placeholder.xcodeproj",
        "xcshareddata",
        "xcschemes",
        "Placeholder.xcscheme",
      );
      writeFileSync(
        scheme,
        readFileSync(scheme, "utf8").replace(
          "      </Testables>",
          [
            "      </Testables>",
            "      <MacroExpansion>",
            "         <BuildableReference",
            '            BuildableIdentifier = "primary"',
            '            BuildableName = "Ghost.app"',
            '            BlueprintName = "Ghost"',
            '            ReferencedContainer = "container:Placeholder.xcodeproj">',
            "         </BuildableReference>",
            "      </MacroExpansion>",
          ].join("\n"),
        ),
        "utf8",
      );
      declare(dir, ["PlaceholderTests"]);
      const note = iosNote(dir, "test");
      expect(note, "the one real testable resolves").not.toMatch(/BROKEN ON A CLEAN CHECKOUT/);
      expect(note, "a macro expansion is not a target the scheme tests").not.toContain("Ghost");
      // The rest of the reason is untouched -- this withholds nothing.
      expect(note).toMatch(/still names \{project\}, \{scheme\}, \{simUdid\}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A skipped testable is excluded from the RUN and still names a target that
  // has to exist, so the cross-check applies -- and the note says the scheme
  // skips it, because that changes which repair a maintainer reaches for.
  it("cross-checks a skipped testable all the same, and says that it is skipped", () => {
    laneWhere(
      "skipped",
      testable("PlaceholderTests", "PlaceholderTests.xctest", { skipped: true }),
      [],
      (note): void => {
        expect(note).toMatch(/TEST ACTION IS BROKEN ON A CLEAN CHECKOUT/);
        expect(note).toContain(
          "names 'PlaceholderTests' (PlaceholderTests.xctest, skipped by the scheme)",
        );
      },
    );
  });
});

describe("nen shu detect -- the expo markers themselves", () => {
  it("reads the manifest KEY, never the filename alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-expo-marker-"));
    try {
      writeFileSync(join(dir, "app.json"), JSON.stringify({ name: "not-expo" }), "utf8");
      expect(detect(dir).lanes, "app.json is a filename a dozen tools use").toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The dynamic manifest cannot be read without EXECUTING it, and `detect`
  // executes nothing -- so the confirmation is the dependency the repository
  // declares beside it.
  it("accepts the app.config.ts form, confirmed against the declared dependency", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-expo-config-ts-"));
    try {
      writeFileSync(join(dir, "app.config.ts"), "export default { expo: {} };\n", "utf8");
      expect(detect(dir).lanes, "a config file with no dependency behind it").toEqual([]);
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "p", dependencies: { expo: "53.0.0" } }),
        "utf8",
      );
      const lanes = detect(dir).lanes;
      expect(lanes.map((lane): string => lane.stack)).toEqual(["expo"]);
      expect(lanes[0]?.markers).toEqual(["app.config.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // EVIDENCE, NEVER AN IDENTIFICATION. The pack says this file identifies an
  // Expo project on its own; `detect` declines that half, and records the file
  // against the seats whose quoted reason turns on its absence.
  it("records eas.json beside a manifest, and never proposes a lane from it alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-expo-eas-"));
    try {
      writeFileSync(join(dir, "eas.json"), JSON.stringify({ build: {} }), "utf8");
      expect(detect(dir).lanes, "a build profile is not a project").toEqual([]);

      writeFileSync(join(dir, "app.json"), JSON.stringify({ expo: { name: "p" } }), "utf8");
      const lane = detect(dir).lanes[0];
      // n3. THE TWO KINDS ARE KEPT APART, on the ONE surface `--json` and the
      // text share: `markers` is what made the lane and `evidence` is what the
      // lane merely carries. "Delete it and the lane goes away" is true of
      // every path in the first list and false of every path in the second, and
      // one list could not say both.
      expect(lane?.markers).toEqual(["app.json"]);
      expect(lane?.evidence).toEqual(["eas.json"]);
      const note = lane?.notes.find((entry): boolean => entry.includes("this lane also carries"));
      expect(note).toMatch(/this lane also carries eas\.json/);
      expect(note).toMatch(/nen did NOT identify the lane from/);
      expect(note).toMatch(
        /a seat whose quoted reason turns on its absence is the first row to distrust/,
      );
      // The pack's own sentence for the marker carries the claim, and it is the
      // sentence that explains the `archive` seat a few rows down.
      expect(note).toMatch(
        /no repository in the inventory has one, which is why `archive` is unsupported/,
      );
      expect(reasonOf(lane?.verbs, "archive")).toMatch(/NO `eas\.json` AND NO EAS PROJECT ID/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says nothing of the kind when the file is absent", () => {
    for (const lane of detect(EXPO_BARE).lanes) {
      expect(lane.markers, lane.lane).not.toContain("eas.json");
      expect(lane.evidence, lane.lane).toEqual([]);
      expect(lane.notes.join("\n"), lane.lane).not.toMatch(/this lane also carries/);
    }
  });

  // n3, the other surface. The human rendering and `--json` say the same thing
  // in the same words, which is the rule this file exists under: a field that
  // only `--json` carries is a field a reader of the terminal cannot act on.
  it("prints the carried file under its own word, apart from the markers", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-expo-eas-render-"));
    try {
      writeFileSync(join(dir, "app.json"), JSON.stringify({ expo: { name: "p" } }), "utf8");
      writeFileSync(join(dir, "eas.json"), JSON.stringify({ build: {} }), "utf8");
      const lines = renderDetect(detect(dir));
      expect(lines).toContain("        marker: app.json");
      expect(lines).toContain("        evidence: eas.json");
      expect(lines, "the carried file is never listed as a marker").not.toContain(
        "        marker: eas.json",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE METRO LANE ALONE RUNS ANYWHERE. The single-lane tree is the one case
  // where a `hosts` block IS proposed for this stack, and it is every platform:
  // the dev server and the linter need no Apple toolchain and no Android SDK.
  // The three-lane tree gets none, which is the assertion two describes up.
  it("proposes every platform for a managed tree, where the lanes cannot disagree", () => {
    const proposal = detect(markerTree("expo")).proposal as unknown as Proposal;
    expect(proposal.project.hosts).toEqual({ "*": ["darwin", "linux", "win32"] });
    expect(proposal.project.defaultLane).toBe("expo");
  });

  // n2. THE PACK'S OWN QUALIFICATION OF THE BLOCK NEN JUST WROTE. `hosts` is
  // keyed by verb and lists platforms, and this stack's whole difficulty is
  // that the row cannot say what the pack says in prose: the same `*` row
  // covers `expo start`, which runs anywhere, and `expo run:ios`, which needs
  // macOS. Nen writes the pack's row and prints the pack's sentence beside it.
  // Dropping the note leaves a maintainer a three-platform allowlist and no
  // hint that a third of the verbs behind it are darwin-only.
  it("prints the pack's own host note beside the hosts block it wrote", () => {
    const report = detect(markerTree("expo"));
    const note = report.notes.find((entry): boolean =>
      entry.includes("the proposed 'hosts' block"),
    );
    expect(note).toBeDefined();
    expect(note).toMatch(/the proposed 'hosts' block is the reference pack's own for the expo stack/);
    // It is an ALLOWLIST, which is the thing the block's shape does not say.
    expect(note).toMatch(/ALLOWLIST nen refuses to start outside/);
    // And the pack's sentence is quoted, not paraphrased.
    expect(note).toContain(profileById(loadProfilesPack(), "expo").hostNote);
    expect(note).toMatch(/`expo run:ios` needs macOS with Xcode and CocoaPods/);
  });

  // The three-lane tree gets NO hosts block, so there is no block to qualify --
  // and the note that fires instead is the one about the disagreement.
  it("says nothing about a hosts block where it proposed none", () => {
    const notes = detect(EXPO_BARE).notes.join("\n");
    expect(notes).toMatch(/the lanes need different platforms/);
    expect(notes).not.toMatch(/the proposed 'hosts' block/);
  });
});

describe("nen shu detect -- the expo proposal, executed", () => {
  // EVERY PROPOSED ROW, RUN, with the argv pinned as a literal: a golden that
  // matches loosely is a golden that survives the change it exists to catch.
  const ARGV: Readonly<Record<string, readonly string[]>> = {
    dev: ["would run:     expo start"],
    lint: ["would run:     expo lint"],
  };

  it("renders the Metro lane's rows back to the argv the pack states", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-golden-expo-"));
    try {
      cpSync(EXPO_BARE, dir, { recursive: true });
      expect((await capture(["detect", "--write"], dir)).code).toBe(0);
      const verbs = detect(dir).lanes.find((lane): boolean => lane.lane === "expo")?.verbs;
      expect(commandRows(verbs)).toEqual(Object.keys(ARGV).sort());
      for (const [verb, lines] of Object.entries(ARGV)) {
        const result = await capture([verb, "--dry-run", "--lane", "expo"], dir);
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

  it("refuses the build seat at exit 4, quoting the pack's own sentence back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-expo-seat-"));
    try {
      cpSync(EXPO_BARE, dir, { recursive: true });
      expect((await capture(["detect", "--write"], dir)).code).toBe(0);
      const result = await capture(["build", "--dry-run", "--lane", "expo"], dir);
      expect(result.code).toBe(4);
      expect(result.err.join("\n")).toMatch(/PROPOSED SEAT -- replace it/);
      expect(result.err.join("\n")).toMatch(
        /Conflating the two would make `nen shu build` launch an app/,
      );
      // And nothing was spawned to find that out.
      expect(result.out).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE OTHER END OF THE WITHHOLDING. `detect` refuses to propose the row; the
  // executor refuses to run it when a maintainer pastes the pack's own line in
  // unedited. Neither guess is available anywhere in the family.
  it("refuses a pasted run:{platform} at exit 2, and runs the value once stated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-expo-platform-"));
    try {
      cpSync(EXPO_BARE, dir, { recursive: true });
      expect((await capture(["detect", "--write"], dir)).code).toBe(0);
      const path = join(dir, "nen", "contract.json");
      const declaration = JSON.parse(readFileSync(path, "utf8")) as {
        project: { verbs: Record<string, Record<string, unknown>> };
      };
      const expo = declaration.project.verbs["expo"] ?? {};
      declaration.project.verbs["expo"] = expo;
      expo["run"] = { exe: "expo", argv: ["run:{platform}"], why: "the pack's row, unedited" };
      writeFileSync(path, JSON.stringify(declaration, null, 2), "utf8");
      const pasted = await capture(["run", "--dry-run", "--lane", "expo"], dir);
      expect(pasted.code).toBe(2);
      expect(pasted.err.join("\n")).toMatch(
        /'run' on lane 'expo' names a placeholder nen cannot substitute: \{platform\}/,
      );

      // And the same row with the value STATED runs, which is the whole shape
      // of the answer: the repository decides, and then nen executes it.
      expo["run"] = { exe: "expo", argv: ["run:ios"], why: "this repository's own choice" };
      writeFileSync(path, JSON.stringify(declaration, null, 2), "utf8");
      const stated = await capture(["run", "--dry-run", "--lane", "expo"], dir);
      expect(stated.code).toBe(0);
      expect(stated.out.filter((line): boolean => line.startsWith("would run:"))).toEqual([
        "would run:     expo run:ios",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
