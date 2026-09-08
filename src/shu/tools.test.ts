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
  parseVersion,
  parsePin,
  satisfiesMinimum,
  parseMinimum,
  satisfiesPin,
} from "./toolchain.js";

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
  readonly found: string | null;
  readonly satisfied: boolean | null;
  readonly state: string;
  readonly installer: string;
  readonly installCommand: readonly string[] | null;
  readonly why: string | null;
}

interface Report {
  readonly contract: string;
  readonly lane: string | null;
  readonly stack: string | null;
  readonly mode: string;
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
    // OUT OF RANGE IN BOTH DIRECTIONS -- the caveat the contract states.
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
    const json = await capture(["--install", "--only", "placeholder-sdk", "--json"], { script });
    // Only the probe ran. An unscripted install call would have thrown.
    expect(spawned(json.seams)).toEqual(["placeholder-sdk-select -p"]);
    expect(row(json, "placeholder-sdk").installCommand).toBeNull();

    const text = await capture(["--install", "--only", "placeholder-sdk"], { script });
    expect(text.out.join("\n")).toMatch(/sdkmanager: not enabled in this release/);
    expect(text.out.join("\n")).toMatch(/Install placeholder-sdk 35\.0\.0 with 'sdkmanager' by hand/);
  });

  it("names the manual way out for a verify-only row and installs nothing", async () => {
    const result = await capture(["--install", "--only", "node"], {
      script: [{ match: "node --version", result: { spawnFailed: true, code: -1 } }],
    });
    expect(spawned(result.seams)).toEqual(["node --version"]);
    expect(result.out.join("\n")).toMatch(/verify-only: install by hand/);
    expect(result.out.join("\n")).toMatch(/Install node >=20\.19\.0/);
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
      "tools",
      "exitCode",
    ]);
    expect(report(result).contract).toBe("nen.shu.tools/v0.1");
  });

  it("pins every row's key order", async () => {
    const result = await capture(["--json"], { script: ALL_PRESENT });
    for (const entry of report(result).tools) {
      expect(Object.keys(entry)).toEqual([
        "name",
        "required",
        "packMinimum",
        "found",
        "satisfied",
        "state",
        "installer",
        "installCommand",
        "why",
      ]);
    }
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
      );
      expect(plan.kind === "runnable", installer).toBe(ENABLED_INSTALLERS.includes(installer));
    }
  });
});
