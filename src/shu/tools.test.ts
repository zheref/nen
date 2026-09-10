// src/shu/tools.test.ts -- `nen shu tools`, driven through the REAL dispatch
// (../index.ts's runFamily) so the two-stage flag re-parse, the --repo/--json
// merge and the error-to-exit-code mapping are the ones a caller gets.
//
// NO LIVE TOOLCHAIN ANYWHERE IN HERE, and that is unusually easy to guarantee
// for a host-mutating verb: every probe and every install goes through the same
// `Seams.run` the rest of this CLI uses, so a ScriptedSeams answers all of them
// -- and it THROWS on a call nobody scripted, which makes "the verb spawned
// something unexpected" a failure rather than a silent pass. Nothing here
// installs anything, on any machine, ever.
//
// THE FIXTURE IS ../schema/fixtures/shu-tools-repo, chosen so the four
// `versionFrom` members and four of the installers each have a real declaration
// to be proved against rather than a synthetic one this file writes. The cases
// that need a DIFFERENT declaration -- a disagreeing manifest pin, a range pin
// under --install, an unevaluable pin -- write one into a temporary repository,
// because a declaration that exists to be refused would make every reader of
// the shared fixture wonder which entry was the real one.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { INSTALLERS } from "../schema/contract.js";
import { SHU_REPO, SHU_TOOLS_REPO } from "../schema/fixtures/paths.js";
import { shuCommand } from "./command.js";
import { ENABLED_INSTALLERS, readManifestPin, resolveInstall } from "./install.js";
import {
  compareVersions,
  extractVersion,
  MAX_FOUND,
  minimumBelowFloor,
  parseVersion,
  parsePin,
  renderMinimum,
  satisfiesMinimum,
  parseMinimum,
  satisfiesPin,
  thisBuild,
  truncate,
  type Build,
} from "./toolchain.js";
import { COMPATIBLE_MINOR_FLOOR, VERSION } from "../version.js";

/**
 * A `ScriptedSeams` whose repeated entries answer IN ORDER.
 *
 * WHY THIS EXISTS, AND WHY IT IS LOCAL. ../seam/scripted.ts matches on
 * `[command, ...args].join(" ")` and returns the FIRST entry with that key, for
 * every call -- which is right for every other verb in this repository, where a
 * given argv has one answer. This verb has exactly one place where it does not:
 * `--install` probes, installs, and PROBES THE SAME ARGV AGAIN, because an
 * installer that exited 0 has not said the tool is now on this PATH. Proving
 * that re-probe changes the row needs the same command to answer differently
 * the second time.
 *
 * It is a subclass here rather than a change to the shared seam because the
 * shared seam's rule -- one argv, one answer -- is a good rule that ~2400 other
 * tests rely on, and widening it for one caller would let a sequencing bug in
 * any of them pass silently. The strict discipline is preserved: an unscripted
 * call still throws, and the last entry for a key repeats, so a call nobody
 * thought about is still a failure rather than an empty answer.
 */
class StagedSeams extends ScriptedSeams {
  private readonly staged: ScriptedCall[];
  private readonly taken = new Map<string, number>();

  constructor(script: readonly ScriptedCall[], options: { platform?: NodeJS.Platform; now?: () => Date }) {
    super(script, options);
    this.staged = [...script];
    this.run = (command, args, runOptions = {}): ReturnType<ScriptedSeams["run"]> => {
      const key = [command, ...args].join(" ");
      this.calls.push({
        command,
        args,
        interactive: false,
        cwd: runOptions.cwd ?? null,
        env: runOptions.env ?? null,
      });
      const matches = this.staged.filter((entry): boolean => entry.match === key);
      if (matches.length === 0) {
        throw new Error(
          `unscripted subprocess: '${key}'. Add it to the script, or fix the caller that made it -- an unexpected call is the finding, not the fixture's gap.`,
        );
      }
      const seen = this.taken.get(key) ?? 0;
      this.taken.set(key, seen + 1);
      const found = matches[Math.min(seen, matches.length - 1)]?.result ?? {};
      return {
        code: found.code ?? 0,
        stdout: found.stdout ?? "",
        stderr: found.stderr ?? "",
        spawnFailed: found.spawnFailed ?? false,
      };
    };
  }
}

interface Options {
  readonly script?: readonly ScriptedCall[];
  readonly repo?: string;
  readonly platform?: NodeJS.Platform;
  /** Answer repeated entries in order -- see StagedSeams. */
  readonly staged?: boolean;
}

interface Captured {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly seams: ScriptedSeams;
}

async function capture(argv: readonly string[], options: Options = {}): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
  };
  let tick = 0;
  const seamOptions = {
    platform: options.platform ?? "linux",
    now: (): Date => new Date(Date.UTC(2026, 0, 1) + (tick += 1) * 1000),
  };
  const seams =
    options.staged === true
      ? new StagedSeams(options.script ?? [], seamOptions)
      : new ScriptedSeams(options.script ?? [], seamOptions);
  const code = await runFamily(
    shuCommand,
    ["shu", "tools", ...argv],
    options.repo ?? SHU_TOOLS_REPO,
    false,
    io,
    seams,
  );
  return { code, out, err, seams };
}

/** Every argv the seam actually took, in order. */
function spawned(seams: ScriptedSeams): readonly string[] {
  return seams.calls.map((call): string => [call.command, ...call.args].join(" "));
}

interface Row {
  readonly name: string;
  readonly required: boolean;
  readonly packMinimum: string | null;
  readonly pinned: string;
  readonly versionFrom: string;
  readonly probe: string;
  readonly found: string | null;
  readonly probeOutput: string | null;
  readonly satisfied: boolean | null;
  readonly state: string;
  readonly installer: string;
  readonly installCommand: readonly string[] | null;
  readonly remedy: string | null;
  readonly install: {
    readonly steps: readonly {
      readonly exe: string;
      readonly argv: readonly string[];
      readonly exitCode: number | null;
      readonly durationMs: number | null;
    }[];
    readonly outcome: string;
    readonly failure: string | null;
  } | null;
  readonly why: string | null;
}

interface Summary {
  readonly checked: number;
  readonly satisfied: number;
  readonly missing: number;
  readonly wrong: number;
  readonly notProbed: number;
  readonly installed: number;
  readonly refused: number;
  readonly notInstallable: number;
}

interface Report {
  readonly contract: string;
  readonly lane: string | null;
  readonly stack: string | null;
  readonly mode: string;
  readonly compatibleMinorFloor: string;
  readonly summary: Summary;
  readonly tools: readonly Row[];
  readonly exitCode: number;
}

function report(captured: Captured): Report {
  return JSON.parse(captured.out.join("\n")) as Report;
}

function row(captured: Captured, name: string): Row {
  const found = report(captured).tools.find((entry): boolean => entry.name === name);
  if (found === undefined) throw new Error(`no row for '${name}'`);
  return found;
}

// ── the probe script the shared fixture needs, per row state ────────────────
//
// The five declared tools plus the `nen` row, each answered the way a host that
// has everything would answer. Individual tests override ONE entry, which keeps
// each case's subject visible instead of buried in a wall of fixture data.

const NEN_OK: ScriptedCall = { match: "nen --version", result: { stdout: "0.3.1\n" } };
const NODE_OK: ScriptedCall = { match: "node --version", result: { stdout: "v22.11.0\n" } };
const PM_OK: ScriptedCall = { match: "pnpm --version", result: { stdout: "9.15.9\n" } };
const JDK_OK: ScriptedCall = {
  match: "placeholder-jdk -version",
  // On STDERR, which is the whole reason that member exists.
  result: { stderr: 'openjdk version "17.0.9" 2023-10-17\n' },
};
const SDK_OK: ScriptedCall = {
  match: "placeholder-sdk-select -p",
  // A path that IS there, relative to the lane's cwd (the fixture root).
  result: { stdout: "sdk-root\n" },
};
const WRAPPER_OK: ScriptedCall = {
  match: "placeholder-wrapper --version",
  result: { stdout: "Placeholder 8.11\n" },
};

const ALL_PRESENT: readonly ScriptedCall[] = [NEN_OK, NODE_OK, PM_OK, JDK_OK, SDK_OK, WRAPPER_OK];

/** The same script with one entry replaced, so a case states only its subject. */
function withProbe(match: string, result: ScriptedCall["result"]): readonly ScriptedCall[] {
  return ALL_PRESENT.map((entry): ScriptedCall => (entry.match === match ? { match, result } : entry));
}

/** A declaration written into a temporary repository, for the refusal cases. */
async function withDeclaration(
  contract: unknown,
  argv: readonly string[],
  options: Options & { readonly manifest?: unknown } = {},
): Promise<Captured> {
  const dir = mkdtempSync(join(tmpdir(), "nen-shu-tools-"));
  try {
    mkdirSync(join(dir, "nen"));
    writeFileSync(join(dir, "nen", "contract.json"), JSON.stringify(contract));
    if (options.manifest !== undefined) {
      writeFileSync(join(dir, "package.json"), JSON.stringify(options.manifest));
    }
    return await capture(argv, { ...options, repo: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A one-tool contract, for the cases that need exactly one row. */
function oneTool(entry: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    $schema: "nen.contract/v0.1",
    project: {
      lanes: { only: { stack: "nextjs", cwd: "." } },
      defaultLane: "only",
      toolchain: { [String(entry["$name"] ?? "placeholder-tool")]: entry },
      verbs: { only: { build: { exe: "placeholder-tool", argv: ["go"] } } },
    },
  };
}

// ── (a) the row states ──────────────────────────────────────────────────────

describe("nen shu tools -- one row state per host answer", () => {
  it("exits 0 with every row present and matching", async () => {
    const result = await capture(["--json"], { script: ALL_PRESENT });
    expect(result.code).toBe(0);
    const parsed = report(result);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.tools.map((entry): string => entry.state)).toEqual(
      Array.from({ length: 6 }, (): string => "present-and-matching"),
    );
    expect(parsed.tools.every((entry): boolean => entry.satisfied === true)).toBe(true);
  });

  it("reports a probe that could not be started as missing, and exits 5", async () => {
    const result = await capture(["--json"], {
      script: withProbe("pnpm --version", { spawnFailed: true, code: -1 }),
    });
    expect(result.code).toBe(5);
    expect(row(result, "pnpm")).toMatchObject({ state: "missing", found: null, satisfied: false });
    // Exit 5 rather than 1: a missing tool is not a failed build.
    expect(report(result).exitCode).toBe(5);
  });

  it("reports a version below an at-least pin as present-but-wrong-version", async () => {
    const result = await capture(["--json"], {
      script: withProbe("node --version", { stdout: "v18.20.0\n" }),
    });
    expect(result.code).toBe(5);
    expect(row(result, "node")).toMatchObject({
      state: "present-but-wrong-version",
      found: "18.20.0",
      satisfied: false,
    });
  });

  it("reports a version that is not the EXACT pin as wrong, even when it is newer", async () => {
    // The pin is exact, so "newer" is not "satisfies": a repository that pinned
    // one version did not ask for the newest one that looks compatible.
    const result = await capture(["--json"], {
      script: withProbe("pnpm --version", { stdout: "9.20.0\n" }),
    });
    expect(result.code).toBe(5);
    expect(row(result, "pnpm")).toMatchObject({ state: "present-but-wrong-version", found: "9.20.0" });
  });

  it("reports output no member can read a version out of as present, version unknown", async () => {
    // NOT missing -- the program is there and answered -- and NOT satisfied: an
    // unperformed comparison must never render as one that came back clean.
    const result = await capture(["--json"], {
      script: withProbe("node --version", { stdout: "a build with no version in it\n" }),
    });
    expect(result.code).toBe(5);
    expect(row(result, "node")).toMatchObject({
      state: "present-but-wrong-version",
      found: null,
      satisfied: false,
    });
    const text = await capture([], {
      script: withProbe("node --version", { stdout: "a build with no version in it\n" }),
    });
    expect(text.out.join("\n")).toMatch(/node\s+unknown/);
  });
});

// ── (b) every versionFrom member ───────────────────────────────────────────

describe("versionFrom -- all four members, each read the way the enum says", () => {
  it("first-semver-on-stdout takes the first version-shaped token, prefix and all", () => {
    expect(extractVersion("first-semver-on-stdout", "v22.11.0\n", "")).toBe("22.11.0");
    expect(extractVersion("first-semver-on-stdout", "Tool 15.0 (build 15A240d)\n", "")).toBe("15.0");
    expect(extractVersion("first-semver-on-stdout", "built 2026-01-01\n", "")).toBeNull();
    // It reads STDOUT and not stderr, which is the whole distinction.
    expect(extractVersion("first-semver-on-stdout", "", "1.2.3")).toBeNull();
  });

  it("first-semver-on-stderr reads the other stream", () => {
    expect(extractVersion("first-semver-on-stderr", "", 'openjdk version "17.0.9" 2023-10-17')).toBe(
      "17.0.9",
    );
    expect(extractVersion("first-semver-on-stderr", "9.9.9", "")).toBeNull();
  });

  it("prefers a three-component token over an earlier two-component one", () => {
    // A BANNER OFTEN LEADS WITH SOMETHING THAT IS NOT THE VERSION. Two
    // components are also what a build date, a schema stamp or a marketing
    // number look like; three are unambiguously a version, so a line carrying
    // both means the specific one.
    expect(extractVersion("first-semver-on-stdout", "Build 2024.01 -- Tool 1.2.3\n", "")).toBe(
      "1.2.3",
    );
    expect(extractVersion("first-semver-on-stderr", "", "rev 2026.09, version 4.5.6")).toBe("4.5.6");
    // AND NO FURTHER. Two three-component tokens still yield the first:
    // choosing between them would be nen guessing which version a probe meant.
    expect(extractVersion("first-semver-on-stdout", "pnpm 9.15.9 (node 22.11.0)\n", "")).toBe(
      "9.15.9",
    );
    // A line with only two-component tokens is unchanged -- MAJOR.MINOR is what
    // several real probes answer, and reading none would be worse.
    expect(extractVersion("first-semver-on-stdout", "Tool 15.0 (build 15A240d)\n", "")).toBe("15.0");
  });

  it("whole-line-stdout takes the first non-empty line verbatim", () => {
    expect(extractVersion("whole-line-stdout", "\n  9.15.9  \n", "")).toBe("9.15.9");
    // Verbatim means verbatim: a line that is not a version comes back as one,
    // and the comparison below is what refuses it.
    expect(extractVersion("whole-line-stdout", "not a version\n", "")).toBe("not a version");
    expect(extractVersion("whole-line-stdout", "", "")).toBeNull();
  });

  it("path-exists reads no version at all -- presence is the whole answer", () => {
    expect(extractVersion("path-exists", "/somewhere\n", "")).toBeNull();
  });

  it("drives all four end to end against the fixture, in one report", async () => {
    const result = await capture(["--json"], { script: ALL_PRESENT });
    expect(row(result, "node").found).toBe("22.11.0");
    expect(row(result, "placeholder-jdk").found).toBe("17.0.9");
    expect(row(result, "pnpm").found).toBe("9.15.9");
    // The `path-exists` row is satisfied with NO version, because that is what
    // the member says: the probe named a path and the path is there.
    expect(row(result, "placeholder-sdk")).toMatchObject({
      state: "present-and-matching",
      found: null,
      satisfied: true,
    });
  });

  it("fails a path-exists row when the path the probe named is not there", async () => {
    const result = await capture(["--json"], {
      script: withProbe("placeholder-sdk-select -p", { stdout: "no-such-directory\n" }),
    });
    expect(result.code).toBe(5);
    expect(row(result, "placeholder-sdk")).toMatchObject({ state: "missing", satisfied: false });
  });

  it("fails a path-exists row when the probe exits non-zero, having named nothing", async () => {
    // For this member the exit code IS part of the answer: there is no version
    // to stand as evidence that the tool answered at all.
    const result = await capture(["--json"], {
      script: withProbe("placeholder-sdk-select -p", { code: 1, stderr: "not configured\n" }),
    });
    expect(result.code).toBe(5);
    expect(row(result, "placeholder-sdk").state).toBe("missing");
  });
});

// ── (c) the pin forms, and the ones nen refuses ────────────────────────────

describe("version pins -- the exact form, the >= form, and nothing else", () => {
  it("compares an exact pin for equality, padding missing components with zero", () => {
    expect(satisfiesPin(parsePin("9.15.9", "p"), "9.15.9")).toBe(true);
    expect(satisfiesPin(parsePin("9.15", "p"), "9.15.0")).toBe(true);
    expect(satisfiesPin(parsePin("9.15", "p"), "9.15.3")).toBe(false);
    expect(satisfiesPin(parsePin("9.15.9", "p"), "9.15.10")).toBe(false);
  });

  it("compares an at-least pin as a floor with no ceiling", () => {
    expect(satisfiesPin(parsePin(">=20.19.0", "p"), "22.11.0")).toBe(true);
    expect(satisfiesPin(parsePin(">=20.19.0", "p"), "20.19.0")).toBe(true);
    expect(satisfiesPin(parsePin(">=20.19.0", "p"), "20.18.9")).toBe(false);
    expect(satisfiesPin(parsePin(">= 20.19.0", "p"), "21.0.0")).toBe(true);
  });

  it("orders pre-releases below the version they precede, semver's own rule", () => {
    const before = parseVersion("1.2.3-rc.1");
    const release = parseVersion("1.2.3");
    expect(before).not.toBeNull();
    expect(release).not.toBeNull();
    if (before === null || release === null) return;
    expect(compareVersions(before, release)).toBe(-1);
    expect(satisfiesPin(parsePin(">=1.2.3", "p"), "1.2.3-rc.1")).toBe(false);
    expect(satisfiesPin(parsePin(">=1.2.3-rc.1", "p"), "1.2.3-rc.2")).toBe(true);
    // A numeric identifier is lower precedence than an alphanumeric one.
    expect(satisfiesPin(parsePin(">=1.0.0-1", "p"), "1.0.0-alpha")).toBe(true);
  });

  it("ignores build metadata, which takes no part in precedence", () => {
    expect(satisfiesPin(parsePin("9.15.9", "p"), "9.15.9+sha512.abc")).toBe(true);
  });

  it("does not satisfy a pin with a found value that is not a version", () => {
    expect(satisfiesPin(parsePin("9.15.9", "p"), "not a version")).toBe(false);
  });

  it("holds a pre-release AND build metadata to semver's identifier charset", () => {
    // THE ONE PART OF A PIN THAT REACHES AN ARGV UNRESHAPED. The numbers become
    // numbers; these two halves were checked only for emptiness (pre-release)
    // and not read at all (build), so a metacharacter rode into
    // `<tool>@<version>` as part of the pin.
    for (const hostile of [
      "1.2.3-; rm -rf /",
      "1.2.3-a&&b",
      "1.2.3-a|b",
      "1.2.3-`id`",
      "1.2.3-$(id)",
      "1.2.3-'x'",
      '1.2.3-"x"',
      "1.2.3-a b",
      "1.2.3+; rm -rf /",
      "1.2.3+$(id)",
      "1.2.3+a b",
      "1.2.3+a+b",
      "1.2.3-",
      "1.2.3-a..b",
    ]) {
      expect(parseVersion(hostile), hostile).toBeNull();
      expect(() => parsePin(hostile, "project.toolchain.t.version"), hostile).toThrow(
        /is not a version pin nen can evaluate/,
      );
    }
    // And every legitimate identifier still parses: alphanumerics and a hyphen.
    for (const good of ["1.2.3-rc.1", "1.2.3-alpha-2", "1.2.3+sha512.abc", "1.2.3-rc.1+build-9"]) {
      expect(parseVersion(good), good).not.toBeNull();
    }
  });

  it("refuses a hostile pre-release at exit 2, before anything is spawned", async () => {
    const result = await withDeclaration(
      oneTool({
        $name: "placeholder-tool",
        version: "1.2.3-; rm -rf /",
        probe: ["placeholder-tool", "--version"],
        versionFrom: "first-semver-on-stdout",
        installer: "corepack",
      }),
      ["--install"],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/project\.toolchain\.placeholder-tool\.version/);
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses a pin form it cannot evaluate, naming the pointer and both forms", async () => {
    const result = await withDeclaration(
      oneTool({
        $name: "placeholder-tool",
        version: "^9.15.9",
        probe: ["placeholder-tool", "--version"],
        versionFrom: "first-semver-on-stdout",
        installer: "verify-only",
      }),
      [],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/project\.toolchain\.placeholder-tool\.version is '\^9\.15\.9'/);
    expect(result.err.join("\n")).toMatch(/an exact version .* and a floor/);
    // AND NOTHING WAS PROBED: an unevaluable pin is refused before the host is
    // touched, so a caller fixes a file rather than reading a table of rows nen
    // could never have judged.
    expect(result.seams.calls).toEqual([]);
  });
});

// ── (d) the nen row, from the dependency block ─────────────────────────────

describe("the nen row -- the dependency block, under the contract's zero-major rule", () => {
  it("reads the floor as a two-sided range at major zero", () => {
    const floor = parseMinimum("0.3", "dependency.minimum");
    expect(satisfiesMinimum(floor, "0.3.0")).toBe(true);
    expect(satisfiesMinimum(floor, "0.3.9")).toBe(true);
    // OUT OF RANGE IN BOTH DIRECTIONS -- the caveat the contract states, and
    // still the rule for a pin BELOW this build's compatibility floor (`0.3`
    // is; see the floor block below, where a pin at or above it widens).
    expect(satisfiesMinimum(floor, "0.2.9")).toBe(false);
    expect(satisfiesMinimum(floor, "0.4.0")).toBe(false);
  });

  it("moves the vehicle one component up above major zero", () => {
    const floor = parseMinimum("1.4", "dependency.minimum");
    expect(satisfiesMinimum(floor, "1.4.0")).toBe(true);
    expect(satisfiesMinimum(floor, "1.9.9")).toBe(true);
    expect(satisfiesMinimum(floor, "1.3.9")).toBe(false);
    expect(satisfiesMinimum(floor, "2.0.0")).toBe(false);
  });

  it("REFUSES a three-component floor rather than dropping the patch", () => {
    // `0.3.5` used to parse and silently become `0.3` -- a floor written to
    // exclude 0.3.4, applied as one that admits it, with nothing saying so.
    // There is no reading of MAJOR.MINOR.PATCH under this block's zero-major
    // rule, so the honest answer names the pointer.
    expect(() => parseMinimum("0.3.5", "dependency.minimum")).toThrow(
      /dependency\.minimum is '0\.3\.5'.*exactly two components/s,
    );
    expect(() => parseMinimum("1", "dependency.minimum")).toThrow(/is not the MAJOR\.MINOR floor/);
    expect(() => parseMinimum("not-a-version", "dependency.minimum")).toThrow(
      /is not the MAJOR\.MINOR floor/,
    );
  });

  it("normalises a leading v away rather than reading two floors out of one", () => {
    // `parseVersion` accepts and drops a leading `v` everywhere else in this
    // module, and `renderMinimum` renders the range back out of the NUMBERS --
    // so no `v` a declaration wrote can reach a report or a comparison.
    expect(parseMinimum("v0.3", "dependency.minimum")).toEqual(
      parseMinimum("0.3", "dependency.minimum"),
    );
    expect(satisfiesMinimum(parseMinimum("v0.3", "dependency.minimum"), "0.3.1")).toBe(true);
  });

  it("refuses a three-component dependency.minimum end to end, before any probe", async () => {
    const result = await withDeclaration(
      {
        $schema: "nen.contract/v0.1",
        dependency: {
          minimum: "0.3.5",
          pinned_ref: "v0.3.0",
          version_probe: ["nen", "--version"],
          bootstrap: {
            url: "https://example.invalid/nen.sh",
            script_path_in_source: "bootstrap/nen.sh",
          },
        },
        project: {
          lanes: { only: { stack: "nextjs", cwd: "." } },
          defaultLane: "only",
          verbs: { only: { build: { exe: "placeholder-tool", argv: ["go"] } } },
        },
      },
      [],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/dependency\.minimum is '0\.3\.5'/);
    expect(result.seams.calls).toEqual([]);
  });

  it("renders the range rather than the bare floor, so the row explains itself", async () => {
    const result = await capture([], { script: ALL_PRESENT });
    expect(result.out.join("\n")).toMatch(/nen\s+0\.3\.1\s+pinned >=0\.3\.0 <0\.4\.0/);
  });

  it("passes a nen inside the range and fails one above it", async () => {
    const inside = await capture(["--json"], { script: ALL_PRESENT });
    expect(row(inside, "nen")).toMatchObject({ state: "present-and-matching", found: "0.3.1" });

    const above = await capture(["--json"], {
      script: withProbe("nen --version", { stdout: "0.4.0\n" }),
    });
    expect(above.code).toBe(5);
    expect(row(above, "nen")).toMatchObject({ state: "present-but-wrong-version", found: "0.4.0" });
  });

  // ── the compatibility floor (the ruling of 2026-09-10) ───────────────────
  //
  // "Exact minor is fine, unless there is a breaking change." The old rule owed
  // a repin PR in every consuming repository on EVERY minor, breaking or not,
  // because nothing in the binary said which releases had broken anything.
  // `COMPATIBLE_MINOR_FLOOR` is that missing fact, and these are its branches.
  // Every case here names a SYNTHETIC build, so the rule is proved for release
  // lines that do not exist yet rather than only for the one being shipped.

  /** A build that is not this one: a version and the floor it declares. */
  function buildAt(version: string, floor: string): Build {
    const parsed = parseVersion(version);
    if (parsed === null) throw new Error(`'${version}' is not a version`);
    return { version: parsed, floor: parseMinimum(floor, "COMPATIBLE_MINOR_FLOOR") };
  }

  it("accepts a pin AT the floor from a later minor that kept the floor", () => {
    // The whole point of the change: a v0.8.0 that declared no breaking notes
    // keeps the floor at 0.7 -- and a consumer pinned `"0.7"` reads it without
    // a repin PR, which the old exact-minor rule made impossible.
    const build = buildAt("0.8.0", "0.7");
    const floor = parseMinimum("0.7", "dependency.minimum");
    expect(satisfiesMinimum(floor, "0.7.0", build)).toBe(true);
    expect(satisfiesMinimum(floor, "0.7.9", build)).toBe(true);
    expect(satisfiesMinimum(floor, "0.8.0", build)).toBe(true);
    expect(renderMinimum(floor, build)).toBe(">=0.7.0 <0.9.0");
  });

  it("refuses a pin BELOW the floor, and the refusal names the rule", () => {
    // v0.7.0's own notes ARE breaking (exit codes, path resolution), so the
    // floor it ships is its own minor and a `"0.6"` pin is refused exactly as
    // it was before -- with a sentence saying why, which it did not have.
    const build = buildAt("0.8.0", "0.7");
    const floor = parseMinimum("0.6", "dependency.minimum");
    expect(satisfiesMinimum(floor, "0.8.0", build)).toBe(false);
    expect(satisfiesMinimum(floor, "0.7.0", build)).toBe(false);
    // Its own minor still satisfies it: the pin is not nonsense, it is behind.
    expect(satisfiesMinimum(floor, "0.6.4", build)).toBe(true);
    expect(renderMinimum(floor, build)).toBe(">=0.6.0 <0.7.0");
    expect(minimumBelowFloor(floor, build)).toMatch(
      /minimum '0\.6' is below this build's compatibility floor '0\.7'/,
    );
    expect(minimumBelowFloor(floor, build)).toMatch(/declared breaking consumer notes/);
    expect(minimumBelowFloor(floor, build)).toMatch(/Repin to '0\.7'/);
    // A pin AT or ABOVE the floor is not a refusal at all, so it gets no
    // sentence: a way out printed on a row that has nowhere to go is noise.
    expect(minimumBelowFloor(parseMinimum("0.7", "dependency.minimum"), build)).toBeNull();
  });

  it("refuses a pin ABOVE this build's own minor, floor or no floor", () => {
    // A floor is a floor and never a ceiling. `0.9` is at or above 0.7, and a
    // 0.8.0 binary still does not satisfy it -- the version it has is the
    // version it has.
    const build = buildAt("0.8.0", "0.7");
    const floor = parseMinimum("0.9", "dependency.minimum");
    expect(satisfiesMinimum(floor, "0.8.0", build)).toBe(false);
    expect(satisfiesMinimum(floor, "0.9.0", build)).toBe(true);
    expect(renderMinimum(floor, build)).toBe(">=0.9.0 <0.10.0");
  });

  it("keeps the EXACT minor for a version this build cannot speak for", () => {
    // The floor says which releases broke something UP TO THIS ONE and nothing
    // about a release that has not happened: a 0.8.0 binary asked about a
    // 0.9.0 on the host has no way to know what 0.9.0 changed, so it answers
    // under the old exact-minor rule rather than guessing "compatible" -- the
    // fail-OPEN direction, in the one range where compatibility is least
    // guaranteed.
    const build = buildAt("0.8.0", "0.7");
    expect(satisfiesMinimum(parseMinimum("0.7", "dependency.minimum"), "0.9.0", build)).toBe(false);
    // And in the other direction: an old pin is still satisfied by the old
    // binary that answers it, which is what stops the floor becoming a false
    // refusal about a host this build never shipped against.
    const later = buildAt("0.9.0", "0.9");
    expect(satisfiesMinimum(parseMinimum("0.8", "dependency.minimum"), "0.8.0", later)).toBe(true);
  });

  it("leaves the >=1.0 rule exactly where it was", () => {
    // Above major zero the breaking-change vehicle is the MAJOR, so the floor
    // has nothing to say and must not be consulted: `1.4` means
    // `>=1.4.0 <2.0.0` under a 0.x build and under a 1.x one alike.
    for (const build of [buildAt("0.8.0", "0.7"), buildAt("1.9.0", "1.0")]) {
      const floor = parseMinimum("1.4", "dependency.minimum");
      expect(satisfiesMinimum(floor, "1.4.0", build)).toBe(true);
      expect(satisfiesMinimum(floor, "1.9.9", build)).toBe(true);
      expect(satisfiesMinimum(floor, "1.3.9", build)).toBe(false);
      expect(satisfiesMinimum(floor, "2.0.0", build)).toBe(false);
      expect(renderMinimum(floor, build)).toBe(">=1.4.0 <2.0.0");
    }
  });

  it("renders the exact range it applies -- the table cannot contradict the verdict", () => {
    // A row that printed `>=0.7.0 <0.8.0` beside a SATISFIED `0.8.0` would be a
    // report disagreeing with itself in two adjacent columns, which is the
    // failure this sweep exists to make impossible: for every pin and every
    // observed version, the rendered range and the verdict agree.
    const build = buildAt("0.8.0", "0.7");
    for (const pin of ["0.5", "0.6", "0.7", "0.8", "0.9"]) {
      const floor = parseMinimum(pin, "dependency.minimum");
      const range = /^>=0\.(\d+)\.0 <0\.(\d+)\.0$/.exec(renderMinimum(floor, build));
      expect(range, pin).not.toBeNull();
      for (const minor of [4, 5, 6, 7, 8, 9, 10]) {
        for (const patch of [0, 3]) {
          const found = `0.${minor}.${patch}`;
          const inRange = minor >= Number(range?.[1]) && minor < Number(range?.[2]);
          expect(satisfiesMinimum(floor, found, build), `${pin} vs ${found}`).toBe(inRange);
        }
      }
    }
  });

  it("changes NO verdict at the floor this release ships", () => {
    // The floor is seeded at v0.7.0's own minor because v0.7.0's notes are
    // breaking. While the floor EQUALS this build's minor the widened rule and
    // the old exact-minor rule agree on every input, which is the claim that
    // makes this release safe to install under an unchanged pin -- proved here
    // rather than asserted in a changelog.
    const build = thisBuild();
    expect(COMPATIBLE_MINOR_FLOOR).toBe(`${build.version.numbers[0]}.${build.version.numbers[1]}`);
    for (const pin of ["0.3", "0.6", "0.7", "0.8"]) {
      const floor = parseMinimum(pin, "dependency.minimum");
      expect(renderMinimum(floor, build), pin).toBe(`>=0.${floor.minor}.0 <0.${floor.minor + 1}.0`);
      for (const minor of [floor.minor - 1, floor.minor, floor.minor + 1]) {
        if (minor < 0) continue;
        expect(satisfiesMinimum(floor, `0.${minor}.2`, build), `${pin} vs 0.${minor}.2`).toBe(
          minor === floor.minor,
        );
      }
    }
  });

  it("prints the floor beside the binary's own version, on every run", async () => {
    const text = await capture([], { script: ALL_PRESENT });
    expect(text.out.join("\n")).toContain(
      `compat floor:  ${COMPATIBLE_MINOR_FLOOR}  (the lowest dependency.minimum nen ${VERSION} satisfies)`,
    );
  });

  it("says so on the row when the declaration's pin is below the floor", async () => {
    // End to end, through the real dispatch: the host has exactly the binary
    // this build IS, and the row is still WRONG -- so the way out has to say
    // that it is the PIN that is behind and not the machine, or a reader goes
    // and installs the version they already have.
    const result = await withDeclaration(
      {
        $schema: "nen.contract/v0.1",
        dependency: {
          minimum: "0.1",
          pinned_ref: "v0.1.0",
          version_probe: ["nen", "--version"],
          bootstrap: {
            url: "https://example.invalid/nen.sh",
            script_path_in_source: "bootstrap/nen.sh",
          },
        },
        project: {
          lanes: { only: { stack: "nextjs", cwd: "." } },
          defaultLane: "only",
          verbs: { only: { build: { exe: "placeholder-tool", argv: ["go"] } } },
        },
      },
      [],
      { script: [{ match: "nen --version", result: { stdout: `${VERSION}\n`, code: 0 } }] },
    );
    expect(result.code).toBe(5);
    expect(result.out.join("\n")).toMatch(
      /minimum '0\.1' is below this build's compatibility floor '0\.7'/,
    );
    expect(result.out.join("\n")).toMatch(/Repin to '0\.7'/);
  });

  it("reports a nen that will not start as missing, and never tries to install it", async () => {
    const result = await capture(["--json"], {
      script: withProbe("nen --version", { spawnFailed: true, code: -1 }),
    });
    expect(result.code).toBe(5);
    expect(row(result, "nen")).toMatchObject({
      state: "missing",
      installer: "verify-only",
      installCommand: null,
    });
    // Re-pinning nen is the bootstrap's job, and the TEXT row says so.
    const text = await capture([], {
      script: withProbe("nen --version", { spawnFailed: true, code: -1 }),
    });
    expect(text.out.join("\n")).toMatch(/verify-only: install by hand -- the bootstrap/);
  });

  // ── the renamed block, and the collision it used to produce ──────────────
  //
  // `dependency.name` is optional and defaults to nen's own program name, and
  // the collision guard tested THAT default while the row was named from the
  // field. Two declarations broke on the difference, in opposite directions,
  // and both are pinned here.

  /** A dependency block, renamed, beside one toolchain entry. */
  function renamedDependency(
    name: string,
    tool: string,
  ): Readonly<Record<string, unknown>> {
    return {
      $schema: "nen.contract/v0.1",
      dependency: {
        name,
        minimum: "0.3",
        pinned_ref: "v0.3.0",
        version_probe: [name, "--version"],
        bootstrap: {
          url: "https://example.invalid/nen.sh",
          script_path_in_source: "bootstrap/nen.sh",
        },
      },
      project: {
        lanes: { only: { stack: "nextjs", cwd: "." } },
        defaultLane: "only",
        toolchain: {
          [tool]: {
            version: "1.0.0",
            probe: [tool, "--version"],
            versionFrom: "first-semver-on-stdout",
            installer: "verify-only",
          },
        },
        verbs: { only: { build: { exe: "placeholder-tool", argv: ["go"] } } },
      },
    };
  }

  it("emits ONE row when the renamed block collides with a declared tool", async () => {
    // `dependency.name: "foo"` beside `toolchain.foo`: the explicit entry wins
    // and the dependency row is not synthesised. Two rows of one name would be
    // a report that contradicts itself -- and `--only foo` would return both.
    const result = await withDeclaration(renamedDependency("foo", "foo"), ["--json"], {
      script: [{ match: "foo --version", result: { stdout: "1.0.0\n" } }],
    });
    expect(result.code).toBe(0);
    expect(report(result).tools.map((entry): string => entry.name)).toEqual(["foo"]);
    // The surviving row is the TOOLCHAIN entry's -- an exact pin, not the
    // dependency block's zero-major range.
    expect(row(result, "foo").installer).toBe("verify-only");
    expect(spawned(result.seams)).toEqual(["foo --version"]);
  });

  it("still checks a renamed block when a DIFFERENT tool is declared", async () => {
    // `dependency.name: "nenx"` beside `toolchain.nen`: the old guard tested
    // the default name, found the `nen` entry, and dropped the nenx row -- so
    // the version the block exists to check was never checked at all.
    const result = await withDeclaration(renamedDependency("nenx", "nen"), ["--json"], {
      script: [
        { match: "nenx --version", result: { stdout: "0.9.0\n" } },
        { match: "nen --version", result: { stdout: "1.0.0\n" } },
      ],
    });
    expect(report(result).tools.map((entry): string => entry.name)).toEqual(["nenx", "nen"]);
    // And it was JUDGED: 0.9.0 is outside `>=0.3.0 <0.4.0`, so the run is 5.
    expect(row(result, "nenx")).toMatchObject({
      state: "present-but-wrong-version",
      found: "0.9.0",
      satisfied: false,
    });
    expect(result.code).toBe(5);
  });

  it("omits the row entirely when there is no dependency block", async () => {
    const result = await withDeclaration(
      oneTool({
        $name: "placeholder-tool",
        version: "1.0.0",
        probe: ["placeholder-tool", "--version"],
        versionFrom: "first-semver-on-stdout",
        installer: "verify-only",
      }),
      ["--json"],
      { script: [{ match: "placeholder-tool --version", result: { stdout: "1.0.0\n" } }] },
    );
    expect(result.code).toBe(0);
    expect(report(result).tools.map((entry): string => entry.name)).toEqual(["placeholder-tool"]);
  });
});

// ── (e) --install, and everything it will not do ───────────────────────────

describe("--install -- the one installer nen runs, at the version the declaration pins", () => {
  const INSTALL_STEPS: readonly string[] = [
    "corepack enable",
    "corepack prepare pnpm@9.15.9 --activate",
  ];

  it("runs both steps, in order, and re-probes what it installed", async () => {
    const result = await capture(["--install", "--only", "pnpm", "--json"], {
      staged: true,
      script: [
        { match: "pnpm --version", result: { spawnFailed: true, code: -1 } },
        ...INSTALL_STEPS.map((match): ScriptedCall => ({ match, result: { code: 0 } })),
        // The re-probe, answered as a host on which the install worked.
        { match: "pnpm --version", result: { stdout: "9.15.9\n" } },
      ],
    });
    expect(spawned(result.seams)).toEqual([
      "pnpm --version",
      ...INSTALL_STEPS,
      "pnpm --version",
    ]);
    expect(result.code).toBe(0);
    expect(row(result, "pnpm")).toMatchObject({ state: "present-and-matching", found: "9.15.9" });
    expect(report(result).mode).toBe("install");
  });

  it("does not call a row ok on the strength of an installer's exit code alone", async () => {
    // RULE 7, PROVED. Both steps succeed and the re-probe still cannot start
    // the tool -- an install that landed somewhere not on this PATH. The row
    // stays missing and the run exits 5, because "the installer said 0" is not
    // "the tool is there at the pinned version".
    const result = await capture(["--install", "--only", "pnpm", "--json"], {
      script: [
        { match: "pnpm --version", result: { spawnFailed: true, code: -1 } },
        ...INSTALL_STEPS.map((match): ScriptedCall => ({ match, result: { code: 0 } })),
      ],
    });
    expect(spawned(result.seams)).toEqual(["pnpm --version", ...INSTALL_STEPS, "pnpm --version"]);
    expect(result.code).toBe(5);
    expect(row(result, "pnpm").state).toBe("missing");
  });

  it("stops at a failing step and runs nothing after it", async () => {
    const result = await capture(["--install", "--only", "pnpm", "--json"], {
      script: [
        { match: "pnpm --version", result: { spawnFailed: true, code: -1 } },
        { match: "corepack enable", result: { code: 1 } },
      ],
    });
    // The second step is absent from the script, so a seam call for it would
    // THROW -- which is exactly how "nothing after it ran" is proved.
    expect(spawned(result.seams)).toEqual(["pnpm --version", "corepack enable"]);
    expect(result.code).toBe(5);
  });

  it("exits 0 when everything nen could install now passes, verify-only absences included", async () => {
    // The design's own rule, and the reason for it: exiting 5 here because a
    // vendor IDE is absent makes the install form permanently red on a machine
    // nen can never fix. The CHECK is what answers "is this host ready".
    const result = await capture(["--install", "--json"], {
      script: [
        NEN_OK,
        { match: "node --version", result: { spawnFailed: true, code: -1 } },
        { match: "pnpm --version", result: { stdout: "9.15.9\n" } },
        JDK_OK,
        SDK_OK,
        WRAPPER_OK,
      ],
    });
    expect(result.code).toBe(0);
    expect(row(result, "node").state).toBe("missing");
    // And nothing was installed for it: verify-only means verify only.
    expect(spawned(result.seams).some((call): boolean => call.startsWith("corepack"))).toBe(false);
  });

  it("does not act for an installer that is declared and not enabled in this release", async () => {
    const script: readonly ScriptedCall[] = [
      { match: "placeholder-sdk-select -p", result: { stdout: "no-such-directory\n" } },
    ];
    const json = await capture(["--only", "placeholder-sdk", "--json"], { script });
    // Only the probe ran. An unscripted install call would have thrown.
    expect(spawned(json.seams)).toEqual(["placeholder-sdk-select -p"]);
    expect(row(json, "placeholder-sdk").installCommand).toBeNull();

    const text = await capture(["--only", "placeholder-sdk"], { script });
    expect(text.out.join("\n")).toMatch(/sdkmanager: not enabled in this release/);
    expect(text.out.join("\n")).toMatch(/Install placeholder-sdk 35\.0\.0 with 'sdkmanager' by hand/);

    // AND UNDER `--install` IT IS A REFUSAL, not a run that does nothing: see
    // the narrowing cases below.
    const asked = await capture(["--install", "--only", "placeholder-sdk"], { script });
    expect(asked.code).toBe(2);
    expect(asked.seams.calls).toEqual([]);
  });

  it("names the manual way out for a verify-only row and installs nothing", async () => {
    const result = await capture(["--only", "node"], {
      script: [{ match: "node --version", result: { spawnFailed: true, code: -1 } }],
    });
    expect(spawned(result.seams)).toEqual(["node --version"]);
    expect(result.out.join("\n")).toMatch(/verify-only: install by hand/);
    expect(result.out.join("\n")).toMatch(/Install node >=20\.19\.0/);
  });

  // ── --install --only <nothing nen installs>: refused, not a green no-op ───

  it("REFUSES --install --only when nothing in the narrowed set is installable", async () => {
    // The old answer was exit 0 with `satisfied: false` in the report -- a
    // green exit for a line that did nothing it was asked to do.
    const result = await capture(["--install", "--only", "node,placeholder-sdk"], {
      script: ALL_PRESENT,
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/narrows this run to tools nen installs none of/);
    expect(result.err.join("\n")).toMatch(/node \(verify-only\): /);
    expect(result.err.join("\n")).toMatch(/placeholder-sdk \(sdkmanager\): /);
    expect(result.err.join("\n")).toMatch(/run the same line without --install/);
    // BEFORE THE FIRST PROBE: nothing about the refusal depends on the host.
    expect(result.seams.calls).toEqual([]);
  });

  it("does not refuse when the narrowed set has one installable row", async () => {
    const result = await capture(["--install", "--only", "node,pnpm", "--json"], {
      script: [NODE_OK, PM_OK],
    });
    expect(result.code).toBe(0);
    expect(spawned(result.seams)).toEqual(["node --version", "pnpm --version"]);
  });

  it("keeps the exit-0 rule for a FULL --install, and says what stays missing", async () => {
    // The general rule is deliberate: exiting 5 because a vendor IDE is absent
    // makes the install form permanently red on a machine nen can never fix.
    // The cost is a green exit beside a host that is not ready, and the answer
    // to the cost is the count -- in the summary and in a footer.
    const result = await capture(["--install", "--json"], {
      script: [
        NEN_OK,
        { match: "node --version", result: { spawnFailed: true, code: -1 } },
        PM_OK,
        JDK_OK,
        SDK_OK,
        WRAPPER_OK,
      ],
    });
    expect(result.code).toBe(0);
    expect(report(result).summary.notInstallable).toBe(1);

    const text = await capture(["--install"], {
      script: [
        NEN_OK,
        { match: "node --version", result: { spawnFailed: true, code: -1 } },
        PM_OK,
        JDK_OK,
        SDK_OK,
        WRAPPER_OK,
      ],
    });
    expect(text.out.join("\n")).toMatch(
      /note: 1 declared tool is still missing .* installs it in this release \(node\)/,
    );
    expect(text.out.join("\n")).toMatch(/the CHECK -- the same line without --install/);
  });

  it("prints no such footer when the install left nothing behind", async () => {
    const result = await capture(["--install"], { script: ALL_PRESENT });
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).not.toMatch(/still missing/);
  });

  it("says there is nothing to install for a wrapper row", async () => {
    const result = await capture(["--only", "placeholder-wrapper"], {
      script: [{ match: "placeholder-wrapper --version", result: { spawnFailed: true, code: -1 } }],
    });
    expect(result.out.join("\n")).toMatch(/wrapper: nothing to install/);
  });

  it("refuses a range pin under --install, before anything is installed", async () => {
    const result = await withDeclaration(
      oneTool({
        $name: "pnpm",
        version: ">=9.0.0",
        probe: ["pnpm", "--version"],
        versionFrom: "first-semver-on-stdout",
        installer: "corepack",
      }),
      ["--install"],
      { script: [{ match: "pnpm --version", result: { spawnFailed: true, code: -1 } }] },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/nothing was installed/);
    expect(result.err.join("\n")).toMatch(/activates ONE exact version/);
    expect(spawned(result.seams)).toEqual(["pnpm --version"]);
  });

  it("refuses a pin the lane's own manifest contradicts, before anything is installed", async () => {
    const result = await withDeclaration(
      oneTool({
        $name: "pnpm",
        version: "9.15.9",
        probe: ["pnpm", "--version"],
        versionFrom: "first-semver-on-stdout",
        installer: "corepack",
      }),
      ["--install"],
      {
        manifest: { name: "x", packageManager: "pnpm@10.0.0" },
        script: [{ match: "pnpm --version", result: { spawnFailed: true, code: -1 } }],
      },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/The two disagree, and nen installs neither/);
    expect(spawned(result.seams)).toEqual(["pnpm --version"]);
  });

  it("compares the manifest pin as a VERSION, so two agreeing spellings agree", async () => {
    // A STRING COMPARE MADE AGREEING SIDES DISAGREE. `9.15` beside a manifest's
    // `9.15.0` is the same version under this family's own arithmetic --
    // `satisfiesPin` says so on the row above -- and yet the cross-check
    // refused, telling a repository its manifest contradicted a pin it agrees
    // with. Both spellings, both directions.
    for (const [pin, manifest] of [
      ["9.15", "pnpm@9.15.0"],
      ["9.15.0", "pnpm@9.15"],
      ["9.15.9", "pnpm@v9.15.9"],
      ["9.15.9", "pnpm@9.15.9+sha512.abc"],
    ] as const) {
      const result = await withDeclaration(
        oneTool({
          $name: "pnpm",
          version: pin,
          probe: ["pnpm", "--version"],
          versionFrom: "first-semver-on-stdout",
          installer: "corepack",
        }),
        ["--install", "--only", "pnpm"],
        {
          manifest: { name: "x", packageManager: manifest },
          script: [
            { match: "pnpm --version", result: { spawnFailed: true, code: -1 } },
            { match: "corepack enable", result: { code: 0 } },
            { match: `corepack prepare pnpm@${pin} --activate`, result: { code: 0 } },
          ],
        },
      );
      expect(result.err.join("\n"), `${pin} vs ${manifest}`).not.toMatch(/The two disagree/);
      // AND THE ARGV CARRIES THE DECLARATION'S SPELLING, not the manifest's:
      // agreeing is not the same as adopting.
      expect(spawned(result.seams), `${pin} vs ${manifest}`).toContain(
        `corepack prepare pnpm@${pin} --activate`,
      );
    }
  });

  it("does not call a manifest version it cannot read a disagreement", async () => {
    // The field belongs to the ecosystem, not to nen: the courtesy fires when
    // BOTH sides state something comparable, and stays quiet otherwise.
    const result = await withDeclaration(
      oneTool({
        $name: "pnpm",
        version: "9.15.9",
        probe: ["pnpm", "--version"],
        versionFrom: "first-semver-on-stdout",
        installer: "corepack",
      }),
      ["--install", "--only", "pnpm"],
      {
        manifest: { name: "x", packageManager: "pnpm@catalog:default" },
        script: [
          { match: "pnpm --version", result: { spawnFailed: true, code: -1 } },
          { match: "corepack enable", result: { code: 0 } },
          { match: "corepack prepare pnpm@9.15.9 --activate", result: { code: 0 } },
        ],
      },
    );
    expect(result.err.join("\n")).not.toMatch(/The two disagree/);
    expect(spawned(result.seams)).toContain("corepack prepare pnpm@9.15.9 --activate");
  });

  it("accepts an agreeing manifest pin, integrity suffix and all", () => {
    // The fixture's own manifest agrees, which is the case the end-to-end
    // install test above rides on. This pins the SPLIT that makes it agree.
    expect(readManifestPin(SHU_TOOLS_REPO)).toEqual({
      name: "pnpm",
      version: "9.15.9",
      raw: "pnpm@9.15.9",
    });
  });
});

// ── (f) --dry-run: nothing runs, and every command is printed ──────────────

describe("--dry-run -- prints every command and spawns nothing whatever", () => {
  it("runs no probe and no install, and says so in every row", async () => {
    // The script is EMPTY, so any call at all would throw. That is half the
    // assertion; the other half is that the call list is empty rather than
    // merely un-thrown.
    const result = await capture(["--dry-run", "--json"]);
    expect(result.code).toBe(0);
    expect(result.seams.calls).toEqual([]);
    const parsed = report(result);
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.tools.every((entry): boolean => entry.state === "not-probed")).toBe(true);
    expect(parsed.tools.every((entry): boolean => entry.satisfied === null)).toBe(true);
    expect(parsed.tools.every((entry): boolean => entry.found === null)).toBe(true);
  });

  it("spawns nothing even with --install, which is why the classifier can be pinned", async () => {
    const result = await capture(["--install", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.seams.calls).toEqual([]);
  });

  it("prints the probe it would run and the install it would run, per row", async () => {
    const result = await capture(["--dry-run"]);
    const text = result.out.join("\n");
    expect(text).toMatch(/would probe: node --version/);
    expect(text).toMatch(/would probe: placeholder-jdk -version/);
    expect(text).toMatch(/would install: corepack enable/);
    expect(text).toMatch(/corepack prepare pnpm@9\.15\.9 --activate/);
  });

  it("prints the same commands --install would actually spawn", async () => {
    // The parity that makes a dry run worth reading: the thing you approve is
    // the thing that runs.
    const dry = await capture(["--dry-run", "--json"]);
    const printed = row(dry, "pnpm").installCommand;
    const wet = await capture(["--install", "--only", "pnpm", "--json"], {
      script: [
        { match: "pnpm --version", result: { spawnFailed: true, code: -1 } },
        { match: "corepack enable", result: { code: 0 } },
        { match: "corepack prepare pnpm@9.15.9 --activate", result: { code: 0 } },
      ],
    });
    expect(printed).toEqual(
      spawned(wet.seams).filter((call): boolean => call !== "pnpm --version"),
    );
  });
});

// ── (g) the --json contract ────────────────────────────────────────────────

describe("--json -- one object, in one key order", () => {
  it("pins the report's key order", async () => {
    const result = await capture(["--json"], { script: ALL_PRESENT });
    expect(Object.keys(report(result))).toEqual([
      "contract",
      "lane",
      "stack",
      "mode",
      "compatibleMinorFloor",
      "summary",
      "tools",
      "exitCode",
    ]);
    expect(report(result).contract).toBe("nen.shu.tools/v0.1");
    // A FACT ABOUT THE BINARY, carried on every report -- including one whose
    // declaration has no `dependency` block at all, because "do I owe a repin"
    // is a question about nen and not about the declaration that asked.
    expect(report(result).compatibleMinorFloor).toBe(COMPATIBLE_MINOR_FLOOR);
  });

  it("pins every row's key order", async () => {
    const result = await capture(["--json"], { script: ALL_PRESENT });
    for (const entry of report(result).tools) {
      expect(Object.keys(entry)).toEqual([
        "name",
        "required",
        "packMinimum",
        "pinned",
        "versionFrom",
        "probe",
        "found",
        "probeOutput",
        "satisfied",
        "state",
        "installer",
        "installCommand",
        "remedy",
        "install",
        "why",
      ]);
    }
  });

  it("pins the summary's key order, and its arithmetic", async () => {
    const result = await capture(["--json"], {
      script: withProbe("pnpm --version", { spawnFailed: true, code: -1 }),
    });
    const summary = report(result).summary;
    expect(Object.keys(summary)).toEqual([
      "checked",
      "satisfied",
      "missing",
      "wrong",
      "notProbed",
      "installed",
      "refused",
      "notInstallable",
    ]);
    // THE FOUR STATE COUNTS SUM TO `checked`, which is what makes them readable
    // as a whole rather than as four unrelated numbers.
    expect(summary.satisfied + summary.missing + summary.wrong + summary.notProbed).toBe(
      summary.checked,
    );
    expect(summary).toMatchObject({ checked: 6, missing: 1, satisfied: 5, installed: 0 });
  });

  it("counts a refused plan even when the host already satisfies the pin", async () => {
    // THE PLAN CAN BE REFUSED WHILE THE ROW PASSES: a manifest that disagrees
    // with the declaration's pin refuses the corepack plan regardless of what
    // the host reports, and here the host happens to already be at the exact
    // version the declaration pins. `summary.refused` has to count this row
    // anyway -- it is a finding about the DECLARATION, not about the host --
    // and the row itself has no way out to print, because there is nothing for
    // this run to fix: `remedy` is null and `satisfied` is true. A version of
    // `summarise` that derives `refused` from `row.remedy`'s rendered text
    // (rather than from `plan.install.kind`) misses this row entirely, because
    // `remedyOf` prints nothing for a row that already passes.
    const result = await withDeclaration(
      oneTool({
        $name: "pnpm",
        version: "9.15.9",
        probe: ["pnpm", "--version"],
        versionFrom: "first-semver-on-stdout",
        installer: "corepack",
      }),
      ["--json"],
      {
        manifest: { name: "x", packageManager: "pnpm@10.0.0" },
        script: [{ match: "pnpm --version", result: { stdout: "9.15.9\n" } }],
      },
    );
    expect(result.code).toBe(0);
    const parsed = report(result);
    const pnpmRow = parsed.tools.find((entry): boolean => entry.name === "pnpm");
    expect(pnpmRow).toMatchObject({ satisfied: true, remedy: null, state: "present-and-matching" });
    expect(parsed.summary.refused).toBe(1);
  });

  it("keeps stdout exactly one document", async () => {
    const result = await capture(["--json"], { script: ALL_PRESENT });
    expect(() => JSON.parse(result.out.join("\n"))).not.toThrow();
  });

  it("carries the same exit code in the document as the process returns", async () => {
    const failed = await capture(["--json"], {
      script: withProbe("pnpm --version", { spawnFailed: true, code: -1 }),
    });
    expect(report(failed).exitCode).toBe(failed.code);
  });
});

// ── (g2) --json says everything the table says ─────────────────────────────
//
// The finding this section exists for: `--json` shipped strictly WEAKER than
// the text it comes from. The pin, each row's way out, what the probe printed
// and what an install ran were all in the table and in none of the document --
// so a REFUSED corepack row and a verify-only row were indistinguishable to a
// machine reader, and a row nen had just fixed was byte-identical to one that
// was always fine.

describe("--json carries every value the table prints", () => {
  it("carries the pin, normalised, for a pin and for a range alike", async () => {
    const result = await capture(["--json"], { script: ALL_PRESENT });
    expect(row(result, "pnpm").pinned).toBe("9.15.9");
    expect(row(result, "node").pinned).toBe(">=20.19.0");
    // The `nen` row's floor is rendered as the two-sided range it stands for,
    // exactly as the table shows it.
    expect(row(result, "nen").pinned).toBe(">=0.3.0 <0.4.0");
    const text = await capture([], { script: ALL_PRESENT });
    expect(text.out.join("\n")).toContain("pinned >=0.3.0 <0.4.0");
  });

  it("carries the probe argv and the versionFrom that reads it", async () => {
    const result = await capture(["--json"], { script: ALL_PRESENT });
    expect(row(result, "placeholder-jdk")).toMatchObject({
      probe: "placeholder-jdk -version",
      versionFrom: "first-semver-on-stderr",
    });
    // `versionFrom` is what makes a satisfied row with NO version readable: the
    // table says "(presence only)" and the document now says why.
    expect(row(result, "placeholder-sdk")).toMatchObject({
      versionFrom: "path-exists",
      found: null,
      satisfied: true,
    });
  });

  it("tells a REFUSED row from a verify-only row, which `why` could not", async () => {
    // BOTH ROWS ARE UNRUNNABLE AND `why` IS THE DECLARATION'S REASON FOR THE
    // PIN -- so before `remedy` these two were the same row to a reader that
    // could not see the text.
    const refused = await capture(["--only", "pnpm", "--json"], {
      platform: "win32",
      script: [{ match: "pnpm --version", result: { spawnFailed: true, code: -1 } }],
    });
    expect(row(refused, "pnpm").remedy).toMatch(/^corepack: REFUSED -- /);
    expect(row(refused, "pnpm").installCommand).toBeNull();

    const byHand = await capture(["--only", "node", "--json"], {
      script: [{ match: "node --version", result: { spawnFailed: true, code: -1 } }],
    });
    expect(row(byHand, "node").remedy).toMatch(/^verify-only: install by hand -- /);

    const notEnabled = await capture(["--only", "placeholder-sdk", "--json"], {
      script: [{ match: "placeholder-sdk-select -p", result: { stdout: "no-such-directory\n" } }],
    });
    expect(row(notEnabled, "placeholder-sdk").remedy).toMatch(
      /^sdkmanager: not enabled in this release -- /,
    );

    const nothing = await capture(["--only", "placeholder-wrapper", "--json"], {
      script: [{ match: "placeholder-wrapper --version", result: { spawnFailed: true, code: -1 } }],
    });
    expect(row(nothing, "placeholder-wrapper").remedy).toMatch(/^wrapper: nothing to install -- /);
  });

  it("gives a row that passes no way out at all, in either field", async () => {
    const result = await capture(["--json"], { script: ALL_PRESENT });
    for (const entry of report(result).tools) {
      expect([entry.installCommand, entry.remedy], entry.name).toEqual([null, null]);
    }
  });

  it("carries the install transcript, so a fixed row is not a row that was fine", async () => {
    const fixed = await capture(["--install", "--only", "pnpm", "--json"], {
      staged: true,
      script: [
        { match: "pnpm --version", result: { spawnFailed: true, code: -1 } },
        { match: "corepack enable", result: { code: 0 } },
        { match: "corepack prepare pnpm@9.15.9 --activate", result: { code: 0 } },
        { match: "pnpm --version", result: { stdout: "9.15.9\n" } },
      ],
    });
    const install = row(fixed, "pnpm").install;
    expect(install?.outcome).toBe("installed");
    expect(install?.failure).toBeNull();
    expect(install?.steps.map((step): string => [step.exe, ...step.argv].join(" "))).toEqual([
      "corepack enable",
      "corepack prepare pnpm@9.15.9 --activate",
    ]);
    expect(install?.steps.every((step): boolean => step.exitCode === 0)).toBe(true);
    expect(install?.steps.every((step): boolean => typeof step.durationMs === "number")).toBe(true);
    expect(report(fixed).summary.installed).toBe(1);

    // The row that was ALWAYS fine, in the same mode: same state, and an
    // install object that says nothing ran.
    const alreadyFine = await capture(["--install", "--only", "pnpm", "--json"], {
      script: [PM_OK],
    });
    expect(row(alreadyFine, "pnpm").state).toBe(row(fixed, "pnpm").state);
    expect(row(alreadyFine, "pnpm").install).toEqual({
      steps: [],
      outcome: "skipped",
      failure: null,
    });
    expect(report(alreadyFine).summary.installed).toBe(0);
  });

  it("reports a failed install as failed, with the step that stopped it", async () => {
    const result = await capture(["--install", "--only", "pnpm", "--json"], {
      script: [
        { match: "pnpm --version", result: { spawnFailed: true, code: -1 } },
        { match: "corepack enable", result: { code: 1 } },
      ],
    });
    const install = row(result, "pnpm").install;
    expect(install?.outcome).toBe("failed");
    expect(install?.failure).toMatch(/the installer exited 1/);
    expect(install?.steps).toHaveLength(1);
  });

  it("leaves `install` null in every mode that installs nothing", async () => {
    for (const argv of [["--json"], ["--dry-run", "--json"], ["--install", "--dry-run", "--json"]]) {
      const result = await capture(argv, {
        script: argv.includes("--dry-run") ? [] : ALL_PRESENT,
      });
      for (const entry of report(result).tools) {
        expect(entry.install, `${argv.join(" ")} / ${entry.name}`).toBeNull();
      }
    }
  });

  it("quotes what an unreadable probe printed, in both surfaces", async () => {
    // m5: the row says "present, version unknown" and the output used to be
    // discarded -- the one case where the output IS the finding.
    const script = withProbe("node --version", { stdout: "a build with no version in it\n" });
    const json = await capture(["--json"], { script });
    expect(row(json, "node")).toMatchObject({
      state: "present-but-wrong-version",
      found: null,
      probeOutput: "a build with no version in it",
    });
    const text = await capture([], { script });
    expect(text.out.join("\n")).toMatch(/printed: a build with no version in it/);
  });

  it("falls back to the other stream when the declared one is empty", async () => {
    // "the declaration named the wrong stream" is one of the two things this
    // line diagnoses, and quoting only the empty stream would diagnose neither.
    const result = await capture(["--json"], {
      script: withProbe("node --version", { stdout: "", stderr: "permission denied\n" }),
    });
    expect(row(result, "node").probeOutput).toBe("permission denied");
  });

  it("leaves probeOutput null on every row whose version WAS read", async () => {
    const result = await capture(["--json"], { script: ALL_PRESENT });
    for (const entry of report(result).tools) {
      expect(entry.probeOutput, entry.name).toBeNull();
    }
  });

  it("renders the table FROM the document, so neither can outgrow the other", async () => {
    // The structural pin behind this whole section: every way out, every
    // command, every probe argv and every install step the DOCUMENT carries is
    // a string the TABLE prints. A field dropped from one goes missing from the
    // other, loudly, rather than quietly from one of them.
    const dry = await capture(["--dry-run", "--json"]);
    const dryText = await capture(["--dry-run"]);
    for (const entry of report(dry).tools) {
      expect(dryText.out.join("\n"), entry.name).toContain(entry.probe);
      expect(dryText.out.join("\n"), entry.name).toContain(entry.pinned);
      for (const command of entry.installCommand ?? []) {
        expect(dryText.out.join("\n"), entry.name).toContain(command);
      }
      if (entry.remedy !== null) expect(dryText.out.join("\n"), entry.name).toContain(entry.remedy);
    }

    const installed = await capture(["--install", "--only", "pnpm", "--json"], {
      staged: true,
      script: [
        { match: "pnpm --version", result: { spawnFailed: true, code: -1 } },
        { match: "corepack enable", result: { code: 0 } },
        { match: "corepack prepare pnpm@9.15.9 --activate", result: { code: 0 } },
        { match: "pnpm --version", result: { stdout: "9.15.9\n" } },
      ],
    });
    const installedText = await capture(["--install", "--only", "pnpm"], {
      staged: true,
      script: [
        { match: "pnpm --version", result: { spawnFailed: true, code: -1 } },
        { match: "corepack enable", result: { code: 0 } },
        { match: "corepack prepare pnpm@9.15.9 --activate", result: { code: 0 } },
        { match: "pnpm --version", result: { stdout: "9.15.9\n" } },
      ],
    });
    for (const step of row(installed, "pnpm").install?.steps ?? []) {
      expect(installedText.out.join("\n")).toContain(`ran: ${[step.exe, ...step.argv].join(" ")}`);
    }
  });
});

// ── (h) the advisory pack column ───────────────────────────────────────────

describe("packMinimum -- advisory, and never able to move the exit code", () => {
  it("shows the catalogue's tested minimum beside what was probed", async () => {
    const result = await capture(["--json"], { script: ALL_PRESENT });
    expect(row(result, "node").packMinimum).toBe("20.19.0");
    expect(row(result, "pnpm").packMinimum).toBe("9.15.9");
    const text = await capture([], { script: ALL_PRESENT });
    expect(text.out.join("\n")).toMatch(/\(tested minimum 20\.19\.0\)/);
  });

  it("leaves the column empty for a tool the catalogue does not carry", async () => {
    const result = await capture(["--json"], { script: ALL_PRESENT });
    expect(row(result, "placeholder-jdk").packMinimum).toBeNull();
    expect(row(result, "nen").packMinimum).toBeNull();
  });

  it("leaves every column empty for a stack the catalogue does not carry", async () => {
    // A declaration may name any stack id: it is the repository's word, and an
    // advisory column that could refuse a check would be an authority.
    const result = await withDeclaration(
      {
        $schema: "nen.contract/v0.1",
        project: {
          lanes: { only: { stack: "a-stack-nobody-catalogued", cwd: "." } },
          defaultLane: "only",
          toolchain: {
            node: {
              version: ">=20.19.0",
              probe: ["node", "--version"],
              versionFrom: "first-semver-on-stdout",
              installer: "verify-only",
            },
          },
          verbs: { only: { build: { exe: "placeholder-tool", argv: ["go"] } } },
        },
      },
      ["--json"],
      { script: [NODE_OK] },
    );
    expect(result.code).toBe(0);
    expect(row(result, "node").packMinimum).toBeNull();
  });

  it("does not fail a row whose pin is far below the tested minimum", async () => {
    // THE MUTATION THIS ROW EXISTS FOR. The catalogue says 20.19.0; the
    // declaration pins something much older and the host satisfies it. That is
    // exit 0, with the advisory column printed beside it: the pack is a
    // catalogue, and a catalogue that failed a build would be an authority.
    const result = await withDeclaration(
      {
        $schema: "nen.contract/v0.1",
        project: {
          lanes: { only: { stack: "nextjs", cwd: "." } },
          defaultLane: "only",
          toolchain: {
            node: {
              version: ">=14.0.0",
              probe: ["node", "--version"],
              versionFrom: "first-semver-on-stdout",
              installer: "verify-only",
            },
          },
          verbs: { only: { build: { exe: "placeholder-tool", argv: ["go"] } } },
        },
      },
      ["--json"],
      { script: [{ match: "node --version", result: { stdout: "v16.0.0\n" } }] },
    );
    expect(result.code).toBe(0);
    expect(row(result, "node")).toMatchObject({
      satisfied: true,
      packMinimum: "20.19.0",
      found: "16.0.0",
    });
  });

  it("never lets a catalogue value reach a spawned argv", async () => {
    // THE (d2) INVARIANT, PROVED FROM THE OUTSIDE. The catalogue's tested
    // minimum for this tool is 9.15.9 and the declaration pins 9.0.0; the
    // install argv must carry the DECLARATION's version and never the
    // catalogue's, and the report must show both.
    const result = await withDeclaration(
      oneTool({
        $name: "pnpm",
        version: "9.0.0",
        probe: ["pnpm", "--version"],
        versionFrom: "first-semver-on-stdout",
        installer: "corepack",
      }),
      ["--install", "--json"],
      {
        script: [
          { match: "pnpm --version", result: { spawnFailed: true, code: -1 } },
          { match: "corepack enable", result: { code: 0 } },
          { match: "corepack prepare pnpm@9.0.0 --activate", result: { code: 0 } },
        ],
      },
    );
    expect(spawned(result.seams)).toContain("corepack prepare pnpm@9.0.0 --activate");
    expect(spawned(result.seams).join("\n")).not.toContain("9.15.9");
    expect(row(result, "pnpm").packMinimum).toBe("9.15.9");
  });
});

// ── (i) the refusals, and the no-elevation sweep ───────────────────────────

describe("the refusals", () => {
  it("answers 'nothing to check' at exit 0, pointing at detect", async () => {
    const result = await capture([], { repo: SHU_REPO });
    expect(result.code).toBe(0);
    expect(result.err.join("\n")).toMatch(/nothing to check/);
    expect(result.err.join("\n")).toMatch(/shu detect --repo/);
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses --only naming a tool the declaration does not carry, listing the ones it does", async () => {
    const result = await capture(["--only", "pnmp"], { script: ALL_PRESENT });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--only names 'pnmp'/);
    expect(result.err.join("\n")).toMatch(/It declares: nen, node, pnpm/);
    expect(result.seams.calls).toEqual([]);
  });

  it("narrows to exactly the tools --only names", async () => {
    const result = await capture(["--only", "node,pnpm", "--json"], {
      script: [NODE_OK, PM_OK],
    });
    expect(report(result).tools.map((entry): string => entry.name)).toEqual(["node", "pnpm"]);
    expect(spawned(result.seams)).toEqual(["node --version", "pnpm --version"]);
  });

  it("refuses an unknown --lane at 2, before any probe", async () => {
    const result = await capture(["--lane", "nowhere"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--lane 'nowhere' is not a lane/);
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses an unsupported host at 3, before any probe", async () => {
    const result = await withDeclaration(
      {
        $schema: "nen.contract/v0.1",
        project: {
          lanes: { only: { stack: "nextjs", cwd: "." } },
          defaultLane: "only",
          toolchain: {
            node: {
              version: ">=20.19.0",
              probe: ["node", "--version"],
              versionFrom: "first-semver-on-stdout",
              installer: "verify-only",
            },
          },
          verbs: { only: { build: { exe: "placeholder-tool", argv: ["go"] } } },
          hosts: { tools: ["win32"] },
        },
      },
      [],
      { platform: "darwin" },
    );
    expect(result.code).toBe(3);
    expect(result.err.join("\n")).toMatch(/restricts this verb to win32; this host is darwin/);
    expect(result.seams.calls).toEqual([]);
  });

  it("reports with no lane when the declaration names no default", async () => {
    // A LANE IS OPTIONAL ON THIS VERB, unlike every other one in the family:
    // `toolchain` hangs off the project, so refusing to say whether the machine
    // is set up until a caller picks one of three builds would be a refusal
    // with nothing behind it. The advisory column is empty, because no stack
    // was named.
    const result = await withDeclaration(
      {
        $schema: "nen.contract/v0.1",
        project: {
          lanes: { a: { stack: "nextjs", cwd: "." }, b: { stack: "gatsby", cwd: "." } },
          defaultLane: null,
          toolchain: {
            node: {
              version: ">=20.19.0",
              probe: ["node", "--version"],
              versionFrom: "first-semver-on-stdout",
              installer: "verify-only",
            },
          },
          verbs: { a: { build: { exe: "placeholder-tool", argv: ["go"] } } },
        },
      },
      ["--json"],
      { script: [NODE_OK] },
    );
    expect(result.code).toBe(0);
    const parsed = report(result);
    expect(parsed.lane).toBeNull();
    expect(parsed.stack).toBeNull();
    expect(parsed.tools[0]?.packMinimum).toBeNull();
  });

  it("prints NO document under --json when it refuses, exactly as the family does", async () => {
    // THE FAMILY'S RULE, STATED RATHER THAN INVENTED AROUND. Every refusal in
    // this CLI is a line on stderr and an empty stdout (../index.ts's
    // `runFamily`), and a `--json` reader therefore never has to tell a report
    // from an error object on the same stream. A refusal envelope for this one
    // verb would be a second shape only this verb has -- and the caller who
    // wants a machine-readable pre-flight already has `--dry-run --json`.
    const refusals: readonly (readonly string[])[] = [
      ["--install", "--json"],
      ["--only", "pnmp", "--json"],
      ["--lane", "nowhere", "--json"],
      ["--install", "--only", "node", "--json"],
    ];
    for (const argv of refusals) {
      const result = await capture(argv, {
        platform: "win32",
        script: withProbe("pnpm --version", { spawnFailed: true, code: -1 }),
      });
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.out, argv.join(" ")).toEqual([]);
      expect(result.err.length, argv.join(" ")).toBeGreaterThan(0);
    }
    // The pre-flight that IS a document, for the same declaration.
    const preflight = await capture(["--install", "--dry-run", "--json"], { platform: "win32" });
    expect(preflight.code).toBe(0);
    expect(() => JSON.parse(preflight.out.join("\n"))).not.toThrow();
  });

  it("refuses a sibling verb's flag rather than ignoring it", async () => {
    const result = await capture(["--write"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--write .* not read by 'shu tools'/);
  });

  it("refuses --only on a verb that does not read it", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const code = await runFamily(
      shuCommand,
      ["shu", "build", "--only", "x"],
      SHU_TOOLS_REPO,
      false,
      io,
      new ScriptedSeams([], { platform: "linux" }),
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--only .* not read by 'shu build'/);
  });
});

// ── (i2) the install plan, per host ────────────────────────────────────────

describe("the install plan is decided against the HOST, and the host is injected", () => {
  const PNPM = {
    tool: "pnpm",
    version: "9.15.9",
    probe: ["pnpm", "--version"],
    versionFrom: "first-semver-on-stdout",
    installer: "corepack",
    why: null,
    raw: {},
  } as const;

  /** The golden argv, per host. One table, so a change to either is visible. */
  const GOLDEN: Readonly<Record<string, readonly string[] | null>> = {
    darwin: ["corepack enable", "corepack prepare pnpm@9.15.9 --activate"],
    linux: ["corepack enable", "corepack prepare pnpm@9.15.9 --activate"],
    // `null` means: no plan at all on this host.
    win32: null,
  };

  for (const [host, expected] of Object.entries(GOLDEN)) {
    it(`renders ${expected === null ? "no runnable plan" : "the two steps"} on ${host}`, () => {
      const plan = resolveInstall(PNPM, null, host as NodeJS.Platform);
      if (expected === null) {
        expect(plan.kind).toBe("refused");
        // ACTIONABLE, NOT MERELY REFUSED: the exact commands to run by hand.
        if (plan.kind !== "refused") return;
        expect(plan.why).toContain("corepack enable && corepack prepare pnpm@9.15.9 --activate");
        expect(plan.why).toContain("never uses a shell");
        expect(plan.why).toContain("without --install");
        return;
      }
      expect(plan.kind).toBe("runnable");
      if (plan.kind !== "runnable") return;
      expect(plan.steps.map((step): string => [step.exe, ...step.argv].join(" "))).toEqual(expected);
    });
  }

  it("refuses --install on win32 before anything is installed, and says how to do it", async () => {
    // `--only pnpm` narrows to one row whose plan is refused on this host, so
    // the narrowing refusal answers first -- BEFORE any probe -- and carries
    // that row's own reason, commands and all.
    const narrowed = await capture(["--install", "--only", "pnpm"], {
      platform: "win32",
      script: [{ match: "pnpm --version", result: { spawnFailed: true, code: -1 } }],
    });
    expect(narrowed.code).toBe(2);
    expect(narrowed.err.join("\n")).toMatch(/narrows this run to a tool nen installs none of/);
    expect(narrowed.err.join("\n")).toMatch(/corepack enable && corepack prepare pnpm@9\.15\.9/);
    expect(narrowed.seams.calls).toEqual([]);

    // The whole declaration under --install: the probes run (an assessment
    // precedes any install), and then the refusal stops the run before the
    // first installer -- with the same reason.
    const whole = await capture(["--install"], {
      platform: "win32",
      script: withProbe("pnpm --version", { spawnFailed: true, code: -1 }),
    });
    expect(whole.code).toBe(2);
    expect(whole.err.join("\n")).toMatch(/nothing was installed/);
    expect(whole.err.join("\n")).toMatch(/corepack enable && corepack prepare pnpm@9\.15\.9/);
    expect(spawned(whole.seams).some((call): boolean => call.startsWith("corepack"))).toBe(false);
  });

  it("still CHECKS on win32, and prints the refusal as that row's way out", async () => {
    const result = await capture(["--only", "pnpm"], {
      platform: "win32",
      script: [{ match: "pnpm --version", result: { spawnFailed: true, code: -1 } }],
    });
    // A missing tool is still exit 5 on Windows: only the INSTALL is refused.
    expect(result.code).toBe(5);
    expect(result.out.join("\n")).toMatch(/corepack: REFUSED --/);
    expect(result.err.join("\n")).toMatch(/None of them has an installer nen runs/);
  });

  it("does not offer the commands as installable in a win32 dry run", async () => {
    const dry = await capture(["--dry-run", "--only", "pnpm", "--json"], { platform: "win32" });
    expect(dry.code).toBe(0);
    expect(dry.seams.calls).toEqual([]);
    expect(row(dry, "pnpm").installCommand).toBeNull();
  });

  it("keeps every other installer's plan host-independent", () => {
    // Only the ENABLED installer has a host to disagree about; the rest answer
    // the same everywhere, and a host-conditional refusal must not leak into a
    // row that was never going to run anything.
    for (const installer of INSTALLERS.filter((id): boolean => !ENABLED_INSTALLERS.includes(id))) {
      const entry = { ...PNPM, tool: "placeholder-tool", installer };
      const plans = (["darwin", "linux", "win32"] as const).map((host): string =>
        JSON.stringify(resolveInstall(entry, null, host)),
      );
      expect(new Set(plans).size, installer).toBe(1);
    }
  });
});

// ── (j) the mutants this suite let live ────────────────────────────────────
//
// Four rules the code states and the suite did not pin: a mutation testing run
// changed each one and every test still passed. They are here as their own
// section, in the mutation-testing idiom this repository already uses -- a
// surviving mutant is a missing test, and the missing test is written where the
// rule is, not where it happened to be noticed.

describe("the rules a mutation run walked through", () => {
  it("matches --only EXACTLY: not by case", async () => {
    // A tool name is the declaration's own spelling, and two spellings that
    // differ only in case are two different tools to every other part of this
    // verb (the row, the argv, the manifest cross-check). A `--only PNPM` that
    // quietly matched `pnpm` would install a row the caller did not name.
    const result = await capture(["--only", "PNPM"], { script: ALL_PRESENT });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--only names 'PNPM'/);
    expect(result.seams.calls).toEqual([]);
  });

  it("matches --only EXACTLY: not by prefix", async () => {
    // `--only pn` is a typo, not a filter. Matching it would silently widen a
    // narrowing flag -- the one flag whose whole job is to narrow.
    for (const typo of ["pn", "pnpm-", "node2", "ode"]) {
      const result = await capture(["--only", typo], { script: ALL_PRESENT });
      expect(result.code, typo).toBe(2);
      expect(result.err.join("\n"), typo).toMatch(/which this repository does not declare/);
      expect(result.seams.calls, typo).toEqual([]);
    }
  });

  it("prints no install command for a row that already passes", async () => {
    // The usage text says `installCommand` is non-null only when there is
    // something to do, and `pnpm` is the row that makes this provable: its
    // installer IS the one nen runs, so the only thing suppressing the command
    // is the row passing.
    const check = await capture(["--only", "pnpm", "--json"], { script: [PM_OK] });
    expect(row(check, "pnpm")).toMatchObject({ satisfied: true, installCommand: null });
    const text = await capture(["--only", "pnpm"], { script: [PM_OK] });
    expect(text.out.join("\n")).not.toMatch(/install:/);
    // And the same row, failing, DOES print it -- so the assertion above is
    // about the row's state and not about a command that was never there.
    const failing = await capture(["--only", "pnpm", "--json"], {
      script: [{ match: "pnpm --version", result: { stdout: "9.0.0\n" } }],
    });
    expect(row(failing, "pnpm").installCommand).toEqual([
      "corepack enable",
      "corepack prepare pnpm@9.15.9 --activate",
    ]);
  });

  it("does not treat a probe's exit code as the verdict, for the three version members", async () => {
    // A tool that printed its version and exited non-zero is PRESENT, and the
    // version it printed is the observation. Only a failure to START it means
    // missing -- which is why the seam keeps `spawnFailed` apart from a
    // non-zero code in the first place.
    const result = await capture(["--json"], {
      script: [
        { match: "nen --version", result: { code: 3, stdout: "0.3.1\n" } },
        { match: "node --version", result: { code: 1, stdout: "v22.11.0\n" } },
        { match: "pnpm --version", result: { code: 127, stdout: "9.15.9\n" } },
        { match: "placeholder-jdk -version", result: { code: 2, stderr: 'openjdk version "17.0.9"\n' } },
        SDK_OK,
        WRAPPER_OK,
      ],
    });
    expect(result.code).toBe(0);
    for (const name of ["nen", "node", "pnpm", "placeholder-jdk"]) {
      expect(row(result, name), name).toMatchObject({ state: "present-and-matching" });
    }
    // THE COUNTER-CASE, so this is a rule and not a blanket: for `path-exists`
    // the exit code IS part of the answer, because that member has no version
    // to stand as evidence that the tool answered at all.
    const pathRow = await capture(["--only", "placeholder-sdk", "--json"], {
      script: [{ match: "placeholder-sdk-select -p", result: { code: 1, stdout: "sdk-root\n" } }],
    });
    expect(row(pathRow, "placeholder-sdk").state).toBe("missing");
  });

  it("caps every observed string at MAX_FOUND, in the report and in the table", async () => {
    // `whole-line-stdout` hands back whatever the probe printed; without the
    // cap a probe that printed a paragraph puts a paragraph in a table cell and
    // in a --json field.
    expect(truncate("x".repeat(MAX_FOUND))).toHaveLength(MAX_FOUND);
    expect(truncate("x".repeat(MAX_FOUND + 1))).toBe(`${"x".repeat(MAX_FOUND)}...`);
    expect(truncate("x".repeat(MAX_FOUND * 10))).toHaveLength(MAX_FOUND + 3);

    // End to end: the fixture's `pnpm` row reads a WHOLE LINE, so a paragraph
    // on stdout is the one way arbitrary text reaches `found`.
    const shout = `${"L".repeat(400)}`;
    const result = await capture(["--only", "pnpm", "--json"], {
      script: [{ match: "pnpm --version", result: { stdout: `${shout}\n` } }],
    });
    expect(row(result, "pnpm").found).toBe(`${"L".repeat(MAX_FOUND)}...`);
    // And the same cap on the OTHER field that quotes a probe.
    const unreadable = await capture(["--json"], {
      script: withProbe("node --version", { stdout: `${shout}\n` }),
    });
    expect(row(unreadable, "node").probeOutput).toBe(`${"L".repeat(MAX_FOUND)}...`);
  });
});

describe("the no-elevation sweep", () => {
  // ../../ THE `taxonomy-purity.test.ts` PATTERN, APPLIED TO A DIFFERENT
  // INVARIANT. Every install command this release can render, for every
  // installer id the contract publishes, searched for the four ways a command
  // line asks for elevation. A hit is a build failure, not a review comment.
  const ELEVATION: readonly string[] = ["sudo", "runas", "pkexec", "Start-Process"];

  it("renders no elevation in any install plan, for any installer id", () => {
    const rendered: string[] = [];
    for (const installer of INSTALLERS) {
      const plan = resolveInstall(
        {
          tool: "placeholder-tool",
          version: "1.2.3",
          probe: ["placeholder-tool", "--version"],
          versionFrom: "first-semver-on-stdout",
          installer,
          why: null,
          raw: {},
        },
        null,
        "linux",
      );
      if (plan.kind === "runnable") {
        for (const step of plan.steps) rendered.push([step.exe, ...step.argv].join(" "));
      } else {
        rendered.push(plan.why);
      }
    }
    expect(rendered.length).toBeGreaterThan(0);
    for (const line of rendered) {
      for (const word of ELEVATION) {
        expect(line.toLowerCase(), line).not.toContain(word.toLowerCase());
      }
    }
  });

  it("enables exactly one installer, and it is the one that ships with its runtime", () => {
    expect(ENABLED_INSTALLERS).toEqual(["corepack"]);
  });

  it("resolves NO runnable plan for any installer outside the enabled set", () => {
    // THE RULE OVER THE WHOLE CLOSED SET, not over the one id a case happens to
    // name. Without this, teaching any other installer to return a runnable
    // plan would be caught by exactly one end-to-end test -- and this file is
    // the only sweep that reads ./install.ts, since ./purity.test.ts excludes
    // it. A new installer arriving must move ENABLED_INSTALLERS deliberately.
    for (const installer of INSTALLERS) {
      const plan = resolveInstall(
        {
          tool: "placeholder-tool",
          version: "1.2.3",
          probe: ["placeholder-tool", "--version"],
          versionFrom: "first-semver-on-stdout",
          installer,
          why: null,
          raw: {},
        },
        null,
        "linux",
      );
      expect(plan.kind === "runnable", installer).toBe(ENABLED_INSTALLERS.includes(installer));
    }
  });
});
