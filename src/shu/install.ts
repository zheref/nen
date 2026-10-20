// src/shu/install.ts -- closed, declaration-pinned installer plans.
// This pure builder is the narrow exception to the execution-path tool-name
// rule: it imports no seam, runs nothing and reads no profiles catalogue.
// Only --install runs these plans; --dry-run runs neither probes nor steps.
// No elevation, PATH/profile edits or project dependency installation.
// Tool runtime dependencies belong to the isolated tool installation.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Installer, ToolchainEntry } from "../schema/contract.js";
import { renderArgv, type RenderedStep } from "./render.js";
import { compareVersions, parsePin, parseVersion } from "./toolchain.js";

/**
 * What `--install` would do for one entry.
 *
 * `refused` IS A VALUE, NOT A THROW, so one resolution serves both modes: a
 * CHECK renders the reason as the row's way out (a reader learns the pin is
 * unusable before they ask nen to act on it), and `--install` turns the same
 * reason into exit 2. A function that threw could only ever serve the second.
 */
export type InstallPlan =
  | { readonly kind: "runnable"; readonly steps: readonly RenderedStep[]; readonly preconditions?: string }
  | { readonly kind: "nothing-to-install"; readonly why: string }
  | { readonly kind: "by-hand"; readonly why: string }
  | { readonly kind: "not-enabled"; readonly why: string }
  | { readonly kind: "refused"; readonly why: string };

/** Installer ids `--install` acts on in this release. */
export const ENABLED_INSTALLERS: readonly Installer[] = ["corepack", "gem", "gem-user"];

/** The package-manager activator that ships with the runtime it manages. */
const COREPACK = "corepack";
const RUBY = "ruby";

/** A pinned RubyGems tool installed only into the current user's gem home. */
function gemUserPlan(entry: ToolchainEntry, host: NodeJS.Platform): InstallPlan {
  const pin = parsePin(entry.version, `project.toolchain.${entry.tool}.version`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.tool)) {
    return {
      kind: "refused",
      why: `project.toolchain.${entry.tool} is not an unscoped Ruby gem name; gem-user never passes a scoped or path-shaped tool name to RubyGems.`,
    };
  }
  if (entry.versionFrom === "path-exists") {
    return { kind: "refused", why: "gem-user requires a version-reading probe; path-exists cannot verify the pinned version." };
  }
  if (pin.kind !== "exact") {
    return {
      kind: "refused",
      why: `project.toolchain.${entry.tool}.version pins the range '${entry.version}', but gem-user installs one exact version. Pin the Ruby gem version exactly or use verify-only.`,
    };
  }
  const gemVersion = pin.version.replace(/^[vV]/, "");
  if (!/^\d+(?:\.\d+)+$/.test(gemVersion)) {
    return {
      kind: "refused",
      why: `project.toolchain.${entry.tool}.version pins '${entry.version}', but gem-user installs only stable dotted-numeric RubyGems versions. Remove prerelease or build metadata, or use verify-only.`,
    };
  }
  if (host !== "darwin" && host !== "linux") {
    return {
      kind: "refused",
      why: `gem-user is supported only on darwin and linux; ${host} needs a separate installer decision. The declared probe still works without --install.`,
    };
  }
  return {
    kind: "runnable",
    preconditions: "Requires existing Ruby >=3.2 and RubyGems, a writable user gem home, network access to the configured gem source, and a declared version probe resolving the user gem on the existing PATH. Bashcov coverage also needs existing Bash 4.1+.",
    steps: [
      {
        exe: RUBY,
        argv: ["-rrubygems", "-e", 'abort "Ruby >=3.2.0 is required for gem-user" if Gem::Version.new(RUBY_VERSION) < Gem::Version.new("3.2.0")'],
        stdoutTo: null,
      },
      {
        exe: RUBY,
        argv: ["-S", "gem", "install", entry.tool, "--version", gemVersion, "--user-install", "--no-document", "--norc"],
        stdoutTo: null,
      },
    ],
  };
}

/**
 * The host this release will not run the enabled installer on, and the whole
 * argument for refusing rather than shipping a name that might work.
 *
 * ON WINDOWS THE ACTIVATOR IS A BATCH SHIM (`<name>.cmd`), not an executable
 * image, and every other binary this CLI spawns is a real one. Whether a shim
 * can be STARTED through this binary's one subprocess seam is not nen's
 * choice, and it is not stable either:
 *
 *   * node refuses it. Since the fix for CVE-2024-27980, `spawnSync` on Windows
 *     rejects a `.bat`/`.cmd` target unless `shell` is set -- and this family's
 *     first rule is that there is no shell, anywhere, ever.
 *   * a runtime that DOES start one starts it THROUGH the command interpreter,
 *     because Windows cannot execute a batch file any other way. That is a
 *     shell by another name: it re-parses the argument list nen assembled
 *     element by element, which is exactly the re-parse the CVE above was
 *     filed about, and it is the property this whole family is built to keep.
 *
 * So both answers are wrong for this verb -- one fails, the other quietly
 * becomes the thing nen promised not to do -- and the difference between them
 * depends on the runtime and its version rather than on anything in this
 * repository. NEN REFUSES, NAMING THE TWO COMMANDS TO RUN BY HAND. That is
 * fail-closed in this family's own direction: an install that "works on POSIX
 * and is untested on Windows" is a claim nobody checked, and the CHECK -- which
 * spawns only the declared probe -- is unaffected on every host.
 *
 * THE WAY THIS ROW OPENS is a Windows smoke test that starts the real shim on
 * the CI lane that already runs this suite on `windows-latest`, opt-in and
 * out of scope here (zheref/nen#91's item (f)). Until something has actually
 * started it, refusing is the only honest plan.
 */
const REFUSED_INSTALL_HOST: NodeJS.Platform = "win32";

/** The lane manifest whose pin the one enabled installer must agree with. */
const MANIFEST_FILE = "package.json";

/** The manifest field that states that pin. */
const MANIFEST_FIELD = "packageManager";

/**
 * A `<name>@<version>` pin read out of the lane's own manifest.
 *
 * `integrity` IS SPLIT OFF AND KEPT SEPARATE. Real manifests carry
 * `pnpm@9.15.9+sha512.<hash>`; the version half is what a pin comparison is
 * about, and carrying the hash into the comparison would make an agreeing
 * manifest read as a disagreeing one.
 */
export interface ManifestPin {
  readonly name: string;
  readonly version: string;
  /** The field verbatim, for the refusal to quote. */
  readonly raw: string;
}

/**
 * The lane manifest's own package-manager pin, or null when there is none.
 *
 * READ HERE RATHER THAN IMPORTED FROM ./detect.ts, which has a richer reader of
 * the same file. detect.ts reads the profiles pack, and importing it would put
 * the pack on the path of the module that builds an install argv -- the exact
 * edge ../profiles/inertness.test.ts fails the build on, and the exact claim
 * decision (d2) is about. Twenty lines of duplication is the price of that
 * property, and it is worth it.
 *
 * EVERY FAILURE IS `null`, DELIBERATELY. An absent manifest, an unreadable one,
 * malformed JSON, a field of the wrong type, a pin with no version half: none
 * of them is nen's to refuse. This field belongs to the ecosystem, not to nen,
 * and the cross-check below is a courtesy that fires when both sides state a
 * version -- not a second schema nen imposes on somebody's manifest.
 */
export function readManifestPin(directory: string): ManifestPin | null {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(join(directory, MANIFEST_FILE), "utf8")) as unknown;
  } catch {
    return null;
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) return null;
  const declared = (document as Record<string, unknown>)[MANIFEST_FIELD];
  if (typeof declared !== "string" || declared === "") return null;
  // The LAST `@`, never the first: a scoped name opens with one
  // (`@scope/thing@1.2.3`), so splitting on the first hands back an empty name.
  const at = declared.lastIndexOf("@");
  if (at <= 0) return null;
  const version = declared.slice(at + 1).split("+")[0] ?? "";
  if (version === "") return null;
  return { name: declared.slice(0, at), version, raw: declared };
}

/**
 * Whether the lane's manifest and the declaration's pin name DIFFERENT
 * versions -- compared as versions, never as strings.
 *
 * A STRING COMPARE MADE TWO AGREEING SIDES DISAGREE. `9.15` beside a manifest's
 * `9.15.0`, or `v9.15.9` beside `9.15.9`, are the same version under this
 * family's own arithmetic (missing components are zero; a leading `v` is
 * dropped) -- `satisfiesPin` says so on the row right above -- and yet the
 * cross-check refused the install, telling a repository its own manifest
 * contradicted a pin it agrees with. One comparison, in one place, so the
 * courtesy cannot contradict the verdict.
 *
 * A MANIFEST VERSION THAT IS NOT A VERSION IS NOT A DISAGREEMENT. This field
 * belongs to the ecosystem rather than to nen, and the cross-check fires only
 * when BOTH sides state something comparable -- the same rule `readManifestPin`
 * follows when it answers `null` to everything it cannot read.
 */
function disagrees(manifest: ManifestPin, pinned: string): boolean {
  const stated = parseVersion(manifest.version);
  const wanted = parseVersion(pinned);
  if (stated === null || wanted === null) return false;
  return compareVersions(stated, wanted) !== 0;
}

/** The one command pair the enabled installer runs, in order. */
function corepackSteps(tool: string, version: string): readonly RenderedStep[] {
  return [
    // Two steps, not one, and the first is not optional: both reference
    // repositories in the design's inventory run the enabler as its own CI step
    // before the activation, because the activation fails on a host where the
    // shim was never turned on.
    // NEITHER REDIRECTS. `stdoutTo` belongs to a step a DECLARATION states;
    // these two are nen's own, and an installer's output is relayed as it runs.
    { exe: COREPACK, argv: ["enable"], stdoutTo: null },
    { exe: COREPACK, argv: ["prepare", `${tool}@${version}`, "--activate"], stdoutTo: null },
  ];
}

function corepackPlan(
  entry: ToolchainEntry,
  manifest: ManifestPin | null,
  host: NodeJS.Platform,
): InstallPlan {
  // NO try/catch. `parsePin` throws only for a form nen cannot evaluate, and
  // ./tools.ts's `buildPlans` parses THIS pointer, for this entry, before it
  // calls here -- so the throw lands there, as the exit-2 refusal naming the
  // pointer and both supported forms, and a `refused` value built out of that
  // same message here would be a second spelling of one rule. A caller
  // reaching this function directly with an unevaluable pin gets that identical
  // refusal, which is the right answer rather than a special case.
  const pin = parsePin(entry.version, `project.toolchain.${entry.tool}.version`);
  // THE DECLARATION'S OWN FAULTS COME FIRST, and the host's second. A range pin
  // and a contradicted manifest are true on every machine and must be fixed
  // once; hearing about the host first would send a Windows reader to a
  // different computer to be told their declaration is still unusable.
  if (pin.kind !== "exact") {
    return {
      kind: "refused",
      why: `project.toolchain.${entry.tool}.version pins the range '${entry.version}', and this installer activates ONE exact version. nen will not resolve a range to "the newest thing that satisfies it" -- that is an unpinned install wearing a pin's clothes. State the exact version this repository runs, or set the installer to 'verify-only' so nen reports and never acts.`,
    };
  }
  if (manifest !== null && manifest.name === entry.tool && disagrees(manifest, pin.version)) {
    return {
      kind: "refused",
      why: `project.toolchain.${entry.tool}.version pins '${pin.version}', and this lane's ${MANIFEST_FILE} states '${MANIFEST_FIELD}: "${manifest.raw}"'. The two disagree, and nen installs neither: activating one would leave this repository running a version its own manifest contradicts, and choosing between them is a decision the repository has not made. Make them agree, then run this again.`,
    };
  }
  const steps = corepackSteps(entry.tool, pin.version);
  if (host === REFUSED_INSTALL_HOST) {
    return {
      kind: "refused",
      why: `on ${REFUSED_INSTALL_HOST} this installer is a batch shim ('${COREPACK}.cmd'), and nen's one subprocess seam never uses a shell. A runtime that refuses to start a batch file without one fails here; a runtime that starts it anyway starts it THROUGH the command interpreter, which re-parses the argument list nen assembled element by element -- a shell by another name, and the thing this family promises not to do. nen will not guess which of the two this host does, so it installs nothing on ${REFUSED_INSTALL_HOST} in this release. Run it by hand -- ${steps.map(renderArgv).join(" && ")} -- or run this verb without --install: the CHECK spawns only the probe this repository declared and works on every host.`,
    };
  }
  return { kind: "runnable", steps };
}

/** A deliberately narrow RubyGems mode for the shell coverage tool. */
function gemPlan(entry: ToolchainEntry, host: NodeJS.Platform): InstallPlan {
  if (entry.tool !== "bashcov") {
    return { kind: "refused", why: "the gem installer supports only bashcov; other gems require their own installer decision." };
  }
  if (entry.versionFrom === "path-exists") {
    return { kind: "refused", why: "the gem installer requires a version-reading probe; path-exists cannot verify the requested version after installation." };
  }
  // RubyGems' version grammar is different from semver: require a complete
  // numeric release, never a floor, prerelease alias, or abbreviated pin.
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(entry.version)) {
    return { kind: "refused", why: `project.toolchain.${entry.tool}.version must be an exact MAJOR.MINOR.PATCH release for the gem installer, found '${entry.version}'.` };
  }
  if (host !== "darwin" && host !== "linux") {
    return { kind: "refused", why: `the gem installer supports darwin and linux only; host '${host}' is unsupported. Nothing was installed.` };
  }
  return {
    kind: "runnable",
    preconditions: "Requires existing Ruby and RubyGems on PATH, network access to the configured gem source and a writable lane-local .nen/tools directory. Ruby compatibility is checked by RubyGems for the declared release. Running the coverage tool requires Bash 4.1+ (BASH_XTRACEFD); macOS /bin/bash 3.2 cannot capture its trace. Declare a compatible --bash-path in the coverage lane. Nen installs no runtime, edits no PATH/profile and installs no project dependencies.",
    steps: [
      // Read-only preconditions; stop before installation if either is absent.
      { exe: "ruby", argv: ["--version"], stdoutTo: null },
      { exe: "gem", argv: ["--version"], stdoutTo: null },
      { exe: "gem", argv: ["install", entry.tool, "--version", entry.version,
        "--install-dir", ".nen/tools/gems", "--bindir", ".nen/tools/bin", "--no-document", "--norc"], stdoutTo: null },
    ],
  };
}

/**
 * What `--install` would do for one entry, from the entry, the lane's manifest
 * and the host -- and from nothing else.
 *
 * THE SWITCH IS EXHAUSTIVE OVER ../schema/contract.ts's CLOSED SET, by type, so
 * a new installer id added to the contract fails to compile here rather than
 * falling through to a default that quietly does nothing. That is the whole
 * reason the set is closed: a declaration naming an installer nen has forgotten
 * about must be a build failure in nen, not a silent skip on somebody's host.
 *
 * `host` IS `Seams.platform`'S VALUE, PASSED AS A STRING, never read from
 * `process.platform`. Every host decision in this CLI is injected for the same
 * reason (the subprocess seam's own header states it): a refusal that could
 * only be proved on the platform the suite happens to run on is a refusal
 * proved on one of three CI lanes, which is the same as not proved -- and this
 * one is about `win32`, which is the lane nobody develops on. It arrives as an
 * argument rather than
 * through a seam because this module builds commands and runs none -- importing
 * the seam here is what ./purity.test.ts forbids, by name.
 *
 * IT STILL TAKES A DECLARATION AND NOTHING FROM THE CATALOGUE. `manifest` is the
 * lane's own `package.json` and `host` is this machine; neither is the profiles
 * pack, so decision (d2) -- an install argv is built from the DECLARATION's own
 * pin and from nothing else -- is untouched by either.
 */
export function resolveInstall(
  entry: ToolchainEntry,
  manifest: ManifestPin | null,
  host: NodeJS.Platform,
): InstallPlan {
  switch (entry.installer) {
    case "corepack":
      return corepackPlan(entry, manifest, host);
    case "gem":
      return gemPlan(entry, host);
    case "gem-user":
      return gemUserPlan(entry, host);
    case "wrapper":
      return {
        kind: "nothing-to-install",
        why: "this lane resolves the tool through the repository's own committed wrapper, so there is nothing to install. A repository WITHOUT one is a finding to fix in that repository, never a reason to install a build tool globally on this host.",
      };
    case "npx":
      return {
        kind: "nothing-to-install",
        why: "this tool is invoked through the project's own dependency graph, so there is nothing to install globally. The dependency install itself is a precondition nen asserts and never performs.",
      };
    case "verify-only":
      return {
        kind: "by-hand",
        why: `nen probes this tool and reports it; installing it is a system-wide decision with several common answers, and picking one for a developer is the line this verb does not cross. Install ${entry.tool} ${entry.version} the way this machine already installs such things.`,
      };
    case "sdkmanager":
    case "dotnet-install":
    case "winget":
      return {
        kind: "not-enabled",
        why: `the declaration names the '${entry.installer}' installer, which nen does not run in this release: every installer that fetches and executes vendor code, or writes into an SDK root, ships behind its own explicit decision rather than riding in with the first one. Install ${entry.tool} ${entry.version} with '${entry.installer}' by hand; nen keeps reporting it here.`,
      };
  }
}

/** Whether `--install` would actually run something for this plan. */
export function isRunnable(plan: InstallPlan): plan is { kind: "runnable"; steps: readonly RenderedStep[] } {
  return plan.kind === "runnable";
}

// ── what an install RUN looks like, once ./probe.ts has run one ─────────────
//
// THESE TYPES LIVE HERE, IN THE PURE MODULE, and that placement is the whole
// point of the split this verb is built around. ./tools.ts renders a report and
// reads the profiles pack; ./probe.ts spawns and must never reach the pack. If
// the reporter imported the runner for these two shapes, the module that reads
// the catalogue would sit one edge from the module that spawns -- which is the
// coupling decision (e2) exists to prevent, whether or not the computed sweep
// in ../profiles/inertness.test.ts would happen to notice it. So the vocabulary
// both halves need lives in the pure module both halves already import.

/** One install step, as it ran. */
export interface InstallStepReport {
  readonly exe: string;
  readonly argv: readonly string[];
  /** The installer's own code, verbatim. `null` when it could not be started. */
  readonly exitCode: number | null;
  readonly durationMs: number | null;
}

export interface InstallOutcome {
  readonly steps: readonly InstallStepReport[];
  readonly ok: boolean;
  /** Why the run stopped short, or null when it did not. */
  readonly failure: string | null;
}
