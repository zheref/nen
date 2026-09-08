// src/shu/install.ts -- the closed installer table for `nen shu tools`, and the
// ONE module in this family that names the single installer nen implements.
//
// WHY THIS FILE IS EXCLUDED FROM ./purity.test.ts, AND WHY THE EXCLUSION IS
// NARROW. The family's rule is that no file on the execution path names a
// toolchain executable, because `nen shu build` must run what the target
// repository declared and nothing else. `shu tools --install` is the one verb
// that inverts that: it spawns a program NEN chose, to change THE HOST. There
// is no declaration to take that name from -- the declaration names an
// installer ID (`../schema/contract.ts`'s closed `INSTALLERS` set), and turning
// an id into a command is exactly the knowledge nen has to carry itself. So the
// name lives here, in one module, which:
//
//   * builds commands and never runs one (./probe.ts spawns; this file is
//     pure), so the sweep's real subject -- what reaches a spawn -- is still
//     covered by the modules the sweep still reads;
//   * carries ONE such name, and ./purity.test.ts asserts that positively
//     rather than merely skipping the file: an exclusion that only subtracts is
//     an exclusion that silently widens the first time somebody adds a second
//     name to it;
//   * never reads the profiles pack, so the (d2) inertness rule is untouched --
//     an install argv is built from the DECLARATION's own pin and from nothing
//     else, which is the whole content of decision (d2).
//
// THE EIGHT FAIL-CLOSED RULES, where this file is the one that keeps them:
//
//   1. Check is the default. There is no field, env var or declaration key that
//      turns an install on; only `--install` does, in ./command.ts.
//   2. `--dry-run` prints and runs nothing. The commands it prints are the ones
//      this file resolves, from the same call.
//   3. NEVER sudo, never elevation. Nothing here renders one, and ./tools.test.ts
//      sweeps every rendered plan for `sudo`, `runas`, `pkexec` and
//      `Start-Process -Verb RunAs`.
//   4. Never an installer the declaration does not name. The id comes from the
//      entry; an id outside the closed set was already refused by the contract
//      loader, at exit 2, listing the known ones.
//   5. NEVER A VERSION THE DECLARATION DOES NOT PIN. The one enabled installer
//      activates an EXACT version, so a range pin is refused rather than
//      resolved to "the newest thing that satisfies it", and a pin the lane's
//      own manifest contradicts is refused rather than silently preferred.
//      There is no fallback to the catalogue's tested minimum.
//   6. Never a URL nen invented. Nothing here fetches; the one enabled
//      installer ships with the runtime it manages.
//   7. Never edits PATH, a shell profile or an environment.
//   8. Never installs a project's dependencies. That is a PRECONDITION nen
//      asserts and never performs (./run.ts's header) -- a dependency install
//      executes the project's own postinstall scripts, which is a different
//      thing to consent to than activating a pinned package manager.
//
// WHAT IS ENABLED IN THIS RELEASE: one id. The declaration's other installer
// ids are real and are reported, with the version they pin, as work for a
// human -- decision (d). A tool a repository believes nen manages, which nen
// silently skips, is the failure this whole family is written against, so
// "not enabled in this release" is a row a reader sees rather than an absence.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Installer, ToolchainEntry } from "../schema/contract.js";
import type { RenderedStep } from "./render.js";
import { parsePin } from "./toolchain.js";

/**
 * What `--install` would do for one entry.
 *
 * `refused` IS A VALUE, NOT A THROW, so one resolution serves both modes: a
 * CHECK renders the reason as the row's way out (a reader learns the pin is
 * unusable before they ask nen to act on it), and `--install` turns the same
 * reason into exit 2. A function that threw could only ever serve the second.
 */
export type InstallPlan =
  | { readonly kind: "runnable"; readonly steps: readonly RenderedStep[] }
  | { readonly kind: "nothing-to-install"; readonly why: string }
  | { readonly kind: "by-hand"; readonly why: string }
  | { readonly kind: "not-enabled"; readonly why: string }
  | { readonly kind: "refused"; readonly why: string };

/** The installer ids `--install` acts on in this release. Exactly one. */
export const ENABLED_INSTALLERS: readonly Installer[] = ["corepack"];

/** The package-manager activator that ships with the runtime it manages. */
const COREPACK = "corepack";

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

/** The one command pair the enabled installer runs, in order. */
function corepackSteps(tool: string, version: string): readonly RenderedStep[] {
  return [
    // Two steps, not one, and the first is not optional: both reference
    // repositories in the design's inventory run the enabler as its own CI step
    // before the activation, because the activation fails on a host where the
    // shim was never turned on.
    { exe: COREPACK, argv: ["enable"] },
    { exe: COREPACK, argv: ["prepare", `${tool}@${version}`, "--activate"] },
  ];
}

function corepackPlan(entry: ToolchainEntry, manifest: ManifestPin | null): InstallPlan {
  let pin;
  try {
    pin = parsePin(entry.version, `project.toolchain.${entry.tool}.version`);
  } catch (error) {
    return { kind: "refused", why: error instanceof Error ? error.message : String(error) };
  }
  if (pin.kind !== "exact") {
    return {
      kind: "refused",
      why: `project.toolchain.${entry.tool}.version pins the range '${entry.version}', and this installer activates ONE exact version. nen will not resolve a range to "the newest thing that satisfies it" -- that is an unpinned install wearing a pin's clothes. State the exact version this repository runs, or set the installer to 'verify-only' so nen reports and never acts.`,
    };
  }
  if (manifest !== null && manifest.name === entry.tool && manifest.version !== pin.version) {
    return {
      kind: "refused",
      why: `project.toolchain.${entry.tool}.version pins '${pin.version}', and this lane's ${MANIFEST_FILE} states '${MANIFEST_FIELD}: "${manifest.raw}"'. The two disagree, and nen installs neither: activating one would leave this repository running a version its own manifest contradicts, and choosing between them is a decision the repository has not made. Make them agree, then run this again.`,
    };
  }
  return { kind: "runnable", steps: corepackSteps(entry.tool, pin.version) };
}

/**
 * What `--install` would do for one entry, from the entry and nothing else.
 *
 * THE SWITCH IS EXHAUSTIVE OVER ../schema/contract.ts's CLOSED SET, by type, so
 * a new installer id added to the contract fails to compile here rather than
 * falling through to a default that quietly does nothing. That is the whole
 * reason the set is closed: a declaration naming an installer nen has forgotten
 * about must be a build failure in nen, not a silent skip on somebody's host.
 */
export function resolveInstall(entry: ToolchainEntry, manifest: ManifestPin | null): InstallPlan {
  switch (entry.installer) {
    case "corepack":
      return corepackPlan(entry, manifest);
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
