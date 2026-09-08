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
  type Entry,
} from "./detect.js";
import {
  EMPTY_TREE,
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
        // Four shapes of note, and each is something a maintainer acts on: a
        // row withheld, the pack declining to choose, a toolchain requirement
        // nen will not turn into a precondition it would have to invent a value
        // for, and the catalogue's own prose about this stack -- the
        // preconditions and the recorded conflicts a verb row cannot carry.
        expect(note).toMatch(
          /withheld|proposes no command|no precondition is proposed|the reference pack's own note/,
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

  it("does not accept a DIRECTORY named like the wrapper as the wrapper", () => {
    // The marker scan reads a directory LISTING, so a directory named like the
    // tool satisfies it; the row does not, because a row needs something to
    // run. The lane is proposed, every command row is withheld, and the note
    // names no other spelling because there is none to name.
    const dir = mkdtempSync(join(tmpdir(), "nen-detect-wrapper-dir-"));
    try {
      cpSync(markerTree("gradle-android"), dir, { recursive: true });
      rmSync(join(dir, "gradlew"));
      mkdirSync(join(dir, "gradlew"));
      const lane = detect(dir, "linux").lanes[0];
      expect(lane?.stack).toBe("gradle-android");
      expect(commandRows(lane?.verbs)).toEqual([]);
      const notes = lane?.notes.join("\n") ?? "";
      expect(notes).toMatch(/this lane has no 'gradlew'\. A lane without its own wrapper/);
      expect(notes).not.toMatch(/the other host's spelling/);
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

  it("withholds it, naming the files it looked for, when there is no settings file", () => {
    const lane = detect(markerTree("gradle-android")).lanes[0];
    expect(commandRows(lane?.verbs)).toEqual(["build", "lint", "ui-test"]);
    expect(lane?.notes.join("\n")).toMatch(
      /there is none here to read \(nen looks for settings\.gradle, settings\.gradle\.kts\)/,
    );
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
