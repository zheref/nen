// src/canon/checkout.ts -- WHERE the canon checkout is on this machine, and
// whether it is a checkout of the pinned source AT the pinned tag
// (zheref/nen#294).
//
// THE PROBLEM IT CLOSES. `nen canon mirror generate|check` render from a
// checkout of the canonical handbooks repository at the consumer's pinned tag,
// and until this module that checkout reached them only as `--rules-dir`: a
// machine-local path. No literal argv can name a directory that differs per
// machine, so a consumer's declared iteration gate could not carry the mirror
// check, and "check the canon out at the tag, verify with describe" stayed a
// paragraph of prose in the skill that drives it.
//
// RESOLVE FROM DECLARATION AND ENVIRONMENT, NEVER BY GUESSING. The checkout's
// location is the consumer's own data, on the same `maintained_tools` entry
// that records the pin: `checkout_env` (the NAME of a variable a machine
// exports the path in) and `checkout` (a path template, `${VAR}` and
// `${VAR:-default}` expanded from the environment, relative paths against the
// consumer). Neither the variable's name nor any directory is a literal here
// (§3). The order is fixed and reported:
//
//   1. `--canon-checkout <path>` -- the caller, explicitly;
//   2. the variable `checkout_env` names, when it is set and non-empty;
//   3. the `checkout` template.
//
// A source that is ABSENT (no flag, no declaration, the variable unset) is
// passed over, and the report says so. A source that is PRESENT and does not
// yield a valid checkout ends the resolution there, failed and named: it never
// falls through to the next one. A fall-through would render the mirror from
// a directory the caller did not mean while reporting success -- the exact
// failure "never by guessing" rules out.
//
// VALID MEANS SIX FACTS, each its own named failure: the path is a directory;
// it is the TOP of a git work tree (a subdirectory is refused, not walked up
// from); its `origin` names the pinned source ON THE CONSUMER'S OWN ORIGIN
// HOST; the pinned tag exists there and HEAD is that tag's commit; nothing
// differs from it on disk -- modified, untracked, ignored, or hidden from
// status by assume-unchanged/skip-worktree; and every git call ran against
// that directory alone, with no inherited GIT_DIR-style redirect (Nobunaga
// round 1). nen fetches nothing and checks nothing out -- a checkout that is
// behind is reported, never moved.
//
// EVERY GIT CALL GOES THROUGH THE SEAM, read-only: `rev-parse`, `remote
// get-url`, `status`, `ls-files`, under GIT_OPTIONAL_LOCKS=0 and with
// `--no-optional-locks` on the status, so not even the index is refreshed.

import { isAbsolute } from "node:path";
import { nativePaths, samePath, type PathSeam } from "./paths.js";
import { parseRemoteUrl } from "../github/target.js";
import { resolveAgainstRepo } from "../cli/inputs.js";
import { ENV_NAME_RE, type ToolCheckout } from "../schema/repos.js";
import { REPOS_FILE } from "../schema/source.js";
import { GIT, outputLines, redactRemoteCredentials, type Seams } from "../seam/exec.js";

export const CHECKOUT_CONTRACT = "nen.canon.checkout/v0.1";

/** Where a resolution's path came from. */
export type CheckoutSourceKind = "flag" | "env" | "declared-path";

/** One step of the fixed resolution order, and what became of it. */
export interface CheckoutStep {
  readonly kind: CheckoutSourceKind;
  /** `used`: this step supplied the path. `absent`: nothing here, passed over. */
  readonly status: "used" | "absent";
  /** What the step reads, in words: `--canon-checkout`, `$NAME (nen/repos.json maintained_tools[2].checkout_env)`, ... */
  readonly from: string;
  /** Why it was passed over, when it was. */
  readonly note?: string;
}

export interface CheckoutVerification {
  /** `origin`'s URL, credentials redacted. */
  readonly origin: string;
  /** The `owner/name` origin reads as. */
  readonly originSlug: string;
  /** The host origin is on -- the consumer's own origin host, which it must equal. */
  readonly host: string;
  readonly head: string;
  readonly tag: string;
  readonly tagCommit: string;
  readonly clean: true;
}

export type CheckoutFailureCode =
  | "unresolvable"
  | "bad-template"
  | "env-not-absolute"
  | "not-found"
  | "not-a-checkout"
  | "not-checkout-root"
  | "no-origin"
  | "wrong-source"
  | "no-consumer-origin"
  | "wrong-host"
  | "tag-missing"
  | "off-pin"
  | "dirty"
  | "git-unavailable";

export interface CheckoutFailure {
  readonly code: CheckoutFailureCode;
  readonly message: string;
}

export interface CheckoutResolution {
  readonly source: string;
  readonly ref: string;
  /** The checkout's absolute path, symlinks resolved; null when no source supplied one. */
  readonly path: string | null;
  /** The step that supplied `path`, or null. */
  readonly resolvedFrom: CheckoutStep | null;
  /** Every step consulted, in order -- the ones passed over included. */
  readonly steps: readonly CheckoutStep[];
  readonly verified: CheckoutVerification | null;
  readonly failure: CheckoutFailure | null;
}

export interface ResolveCheckoutOptions {
  /** The consumer's root (`--repo`); relative paths resolve against it. */
  readonly root: string;
  readonly source: string;
  readonly ref: string;
  /** `--canon-checkout`, as typed, or null. */
  readonly flag: string | null;
  /** The source's declaration in the consumer's registry, or null. */
  readonly declaration: ToolCheckout | null;
  readonly seams: Seams;
  /** The filesystem's answers; the host's own unless a test models another. */
  readonly paths?: PathSeam;
}

// ---------------------------------------------------------------------------
// The path template
// ---------------------------------------------------------------------------

export type TemplateResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };

/**
 * Expand `$NAME`, `${NAME}` and `${NAME:-default}` against `env`.
 *
 * DELIBERATELY THE SMALLEST SHELL SUBSET THAT CAN SPELL A CACHE SLOT
 * (`${XDG_CACHE_HOME:-${HOME}/.cache}/...`), and nothing else: no command
 * substitution, no globbing, no `~`, no arithmetic. A NAME that is unset or
 * empty with no default is a refusal naming the variable -- never an empty
 * string spliced into a path, which would resolve somewhere real and wrong. A
 * default is itself expanded. A leading `~` is refused rather than read
 * literally, because a directory named `~` under the consumer is never what
 * the author meant; `${HOME}` says it.
 */
export function expandCheckoutTemplate(template: string, env: Readonly<Record<string, string | undefined>>): TemplateResult {
  if (template.startsWith("~")) {
    return { ok: false, reason: `it starts with '~', which is not expanded: write \${HOME} instead` };
  }
  try {
    return { ok: true, value: expand(template, env) };
  } catch (error) {
    /* c8 ignore next -- expand() throws only TemplateError */
    if (!(error instanceof TemplateError)) throw error;
    return { ok: false, reason: error.message };
  }
}

class TemplateError extends Error {}

function expand(text: string, env: Readonly<Record<string, string | undefined>>): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char !== "$") {
      out += char;
      index += 1;
      continue;
    }
    const next = text[index + 1];
    if (next === "{") {
      const close = matchingBrace(text, index + 1);
      if (close === -1) throw new TemplateError(`'\${' at offset ${index} is never closed`);
      const body = text.slice(index + 2, close);
      const separator = body.indexOf(":-");
      const name = separator === -1 ? body : body.slice(0, separator);
      if (!ENV_NAME_RE.test(name)) throw new TemplateError(`'\${${body}}' does not name a variable (letters, digits, '_')`);
      const value = env[name];
      if (separator !== -1 && body.slice(separator + 2) === "") {
        throw new TemplateError(`'\${${body}}' has an empty ':-' default, which would splice nothing into the path; name a default, or drop ':-'`);
      }
      if (value !== undefined && value !== "") out += presentValue(name, value);
      else if (separator !== -1) out += expand(body.slice(separator + 2), env);
      else throw new TemplateError(`it names \${${name}}, which is not set in this environment and has no ':-' default`);
      index = close + 1;
      continue;
    }
    const bare = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index + 1));
    if (bare === null) throw new TemplateError(`a '$' at offset ${index} is not followed by a variable name or '{'`);
    const name = bare[0];
    const value = env[name];
    if (value === undefined || value === "") throw new TemplateError(`it names $${name}, which is not set in this environment`);
    out += presentValue(name, value);
    index += 1 + name.length;
  }
  return out;
}

/**
 * A set variable's value, refused when it is whitespace only: present, so not
 * "unset" (no default applies), and bad, so never spliced into a path -- the
 * same reading `checkout_env` gives a whitespace-only value (Nobunaga N9).
 */
function presentValue(name: string, value: string): string {
  if (value.trim() === "") throw new TemplateError(`it names ${name}, which is set to whitespace only -- present but not a path`);
  return value;
}

/** The index of the `}` closing the `{` at `open`, counting nested `${`; -1 when unbalanced. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function pointer(declaration: ToolCheckout, field: "checkout_env" | "checkout"): string {
  return `${REPOS_FILE} maintained_tools[${declaration.index}].${field}`;
}

/** Resolve, then verify. Never throws for a resolution or verification failure: `failure` carries it. */
export function resolveCanonCheckout(options: ResolveCheckoutOptions): CheckoutResolution {
  const { root, source, ref, flag, declaration, seams } = options;
  const steps: CheckoutStep[] = [];
  const done = (
    path: string | null,
    resolvedFrom: CheckoutStep | null,
    verified: CheckoutVerification | null,
    failure: CheckoutFailure | null,
  ): CheckoutResolution => ({ source, ref, path, resolvedFrom, steps, verified, failure });
  const fail = (code: CheckoutFailureCode, message: string, path: string | null = null, from: CheckoutStep | null = null): CheckoutResolution =>
    done(path, from, null, { code, message });

  // 1. The flag.
  let candidate: { readonly path: string; readonly step: CheckoutStep } | null = null;
  if (flag !== null) {
    const step: CheckoutStep = { kind: "flag", status: "used", from: "--canon-checkout" };
    steps.push(step);
    candidate = { path: resolveAgainstRepo(root, flag), step };
  } else {
    steps.push({ kind: "flag", status: "absent", from: "--canon-checkout", note: "not given" });
  }

  // 2. The declared variable.
  if (candidate === null) {
    const name = declaration?.checkoutEnv ?? null;
    if (declaration === null || name === null) {
      steps.push({ kind: "env", status: "absent", from: "checkout_env", note: `${source} declares no checkout_env` });
    } else {
      const from = `$${name} (${pointer(declaration, "checkout_env")})`;
      const value = seams.env[name];
      // UNSET OR EMPTY IS ABSENT; WHITESPACE ONLY IS PRESENT AND BAD (Nobunaga
      // N9): it falls to the absolute-path refusal below, never past it.
      if (value === undefined || value === "") {
        steps.push({ kind: "env", status: "absent", from, note: "not set in this environment" });
      } else {
        const step: CheckoutStep = { kind: "env", status: "used", from };
        steps.push(step);
        if (!isAbsolute(value)) {
          return fail(
            "env-not-absolute",
            `$${name} is '${value}', which is not an absolute path${value.trim() === "" ? " (whitespace only)" : ""}. A variable is machine state with no directory of its own to be relative to, so a relative value is refused rather than resolved against something the caller did not choose.`,
            null,
            step,
          );
        }
        candidate = { path: value, step };
      }
    }
  }

  // 3. The declared path template.
  if (candidate === null) {
    const template = declaration?.checkout ?? null;
    if (declaration === null || template === null) {
      steps.push({ kind: "declared-path", status: "absent", from: "checkout", note: `${source} declares no checkout path` });
    } else {
      const step: CheckoutStep = { kind: "declared-path", status: "used", from: `'${template}' (${pointer(declaration, "checkout")})` };
      steps.push(step);
      const expanded = expandCheckoutTemplate(template, seams.env);
      if (!expanded.ok) {
        return fail("bad-template", `the declared checkout '${template}' (${pointer(declaration, "checkout")}) cannot be expanded: ${expanded.reason}.`, null, step);
      }
      candidate = { path: resolveAgainstRepo(root, expanded.value), step };
    }
  }

  if (candidate === null) {
    return fail(
      "unresolvable",
      `no canon checkout for ${source}@${ref}: --canon-checkout was not given, and ${declaration === null ? `${REPOS_FILE} declares no checkout for ${source}` : `nothing ${source}'s ${REPOS_FILE} entry declares resolved here`}. Declare one on its maintained_tools entry -- 'checkout_env' (the NAME of a variable each machine exports the path in) and/or 'checkout' (a path template, e.g. '\${XDG_CACHE_HOME:-\${HOME}/.cache}/<dir>') -- or pass --canon-checkout <path>.`,
    );
  }

  const checked = verifyCanonCheckout(seams, candidate.path, source, ref, root, options.paths);
  if ("failure" in checked) return fail(checked.failure.code, checked.failure.message, checked.path, candidate.step);
  return done(checked.path, candidate.step, checked.verified, null);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

type Verified = { readonly path: string; readonly verified: CheckoutVerification } | { readonly path: string; readonly failure: CheckoutFailure };

/**
 * The git variables that would point a `git -C <path>` call at some OTHER
 * repository, index, object store or configuration than the one at `path`
 * (Nobunaga N2). Each is passed as `undefined`, which the runner drops from the
 * child's environment: with `GIT_DIR` inherited, `git -C /unrelated rev-parse`
 * answers for the inherited repository, and an unrelated directory verifies.
 */
const GIT_REDIRECTS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  // A global or system config file named by the environment could set the
  // very keys VERIFICATION_CONFIG pins, or a hook path (Nobunaga R2).
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
] as const;

/**
 * `-c` overrides every verification git call carries (Nobunaga R2): the
 * checkout's own config may not decide what "unchanged" means. An fsmonitor
 * hook that answers "nothing changed" hides an edit from status, an untracked
 * cache can serve a stale listing, and relaxed stat checks let a same-size
 * edit pass. `-c` outranks every config file, so these hold whatever the
 * checkout, the user or the system configured.
 */
export const VERIFICATION_CONFIG: readonly string[] = [
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "core.trustctime=true",
  "-c", "core.checkStat=default",
];

/**
 * The environment every verification git call runs under: the redirects above
 * and every `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` in this environment
 * dropped, `GIT_OPTIONAL_LOCKS=0`, so a `status` never refreshes and
 * rewrites the index of a checkout this verb promises only to read (N7), and
 * `GIT_NO_REPLACE_OBJECTS=1` (R1).
 */
export function verificationGitEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of GIT_REDIRECTS) out[name] = undefined;
  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) out[name] = undefined;
  }
  out["GIT_OPTIONAL_LOCKS"] = "0";
  // A `refs/replace/<tag-commit>` ref would make git read ANOTHER commit's
  // tree as the tag's, so a modified tree verifies (Nobunaga R1).
  out["GIT_NO_REPLACE_OBJECTS"] = "1";
  return out;
}

/**
 * The host a remote URL names, lowercased, user and port dropped -- the same
 * host whichever spelling git wrote: `ssh://git@Host:22/o/n`, `git@host:o/n`
 * and `https://u:p@host:443/o/n` all read `host`. Null for a local path or
 * anything else with no host (Nobunaga N4).
 */
export function remoteHost(url: string): string | null {
  const trimmed = url.trim();
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:]+)/.exec(trimmed);
  if (scheme !== null) return scheme[1] === undefined || scheme[1] === "" ? null : scheme[1].toLowerCase();
  if (trimmed.includes("://")) return null;
  const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)/.exec(trimmed);
  if (scp === null || scp[1] === undefined) return null;
  // `C:` on Windows is a drive, not a host: a one-letter "host" is a path.
  if (scp[1].length === 1) return null;
  return scp[1].toLowerCase();
}

/**
 * The facts that make `path` a checkout of `source` at `ref`, where `source`
 * is read from the same host the consumer (`consumerRoot`) lives on. Read-only:
 * every git call runs under `verificationGitEnv`.
 */
export function verifyCanonCheckout(
  seams: Seams,
  path: string,
  source: string,
  ref: string,
  consumerRoot: string,
  paths: PathSeam = nativePaths,
): Verified {
  const failed = (at: string, code: CheckoutFailureCode, message: string): Verified => ({ path: at, failure: { code, message } });

  // THE OS'S OWN SPELLING (`realpathSync.native`): on Windows it expands an
  // 8.3 short name, which the JavaScript realpath keeps -- and git always
  // answers with the long one (zheref/nen#294, Windows CI).
  let real: string;
  try {
    if (!paths.isDirectory(path)) return failed(path, "not-found", `'${path}' is not a directory.`);
    real = paths.realpath(path);
  } catch {
    return failed(path, "not-found", `'${path}' does not exist. Clone ${source} there and check out ${ref}, or point the declaration at the checkout you keep.`);
  }

  const env = verificationGitEnv(seams.env);
  const gitIn = (dir: string, args: readonly string[]): { code: number; stdout: string; spawnFailed: boolean } => {
    const result = seams.run(GIT, [...VERIFICATION_CONFIG, "-C", dir, ...args], { env });
    return { code: result.code, stdout: result.stdout, spawnFailed: result.spawnFailed };
  };
  const git = (args: readonly string[]): { code: number; stdout: string; spawnFailed: boolean } => gitIn(real, args);

  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.spawnFailed) return failed(real, "git-unavailable", `git could not be started, so '${real}' cannot be verified as a checkout of ${source}@${ref}.`);
  const topLine = outputLines(top.stdout)[0];
  if (top.code !== 0 || topLine === undefined) return failed(real, "not-a-checkout", `'${real}' is not inside a git work tree.`);
  // ONE DIRECTORY, TWO SPELLINGS: git's toplevel is forward-slashed and in
  // its own case on Windows. Both sides are resolved and compared as the
  // platform compares paths (./paths.ts).
  if (!samePath(topLine, real, seams.platform, paths)) {
    return failed(real, "not-checkout-root", `'${real}' is inside the work tree at '${topLine}' but is not its top. Name the checkout's root; nen does not walk up to find one.`);
  }

  const origin = git(["remote", "get-url", "origin"]);
  const url = outputLines(origin.stdout)[0];
  if (origin.code !== 0 || url === undefined) return failed(real, "no-origin", `'${real}' has no 'origin' remote, so nothing says it is a checkout of ${source}.`);
  const redacted = redactRemoteCredentials(url);
  const parsed = parseRemoteUrl(url);
  if (parsed === null || parsed.slug.toLowerCase() !== source.toLowerCase()) {
    return failed(real, "wrong-source", `'${real}''s origin is '${redacted}', which ${parsed === null ? "does not read as an owner/name repository" : `names ${parsed.slug}`}, not ${source}.`);
  }

  // THE HOST IS THE CONSUMER'S OWN (Nobunaga N4, ruled). An owner/name slug is
  // only an identity on a host: `evil.example/owner/handbooks` names the same
  // slug as the real one. The consumer's origin is the one host this run has
  // any reason to trust, so the canon must come from it.
  const consumerOrigin = gitIn(consumerRoot, ["remote", "get-url", "origin"]);
  const consumerUrl = outputLines(consumerOrigin.stdout)[0];
  const consumerHost = consumerOrigin.code === 0 && consumerUrl !== undefined ? remoteHost(consumerUrl) : null;
  if (consumerHost === null) {
    return failed(
      real,
      "no-consumer-origin",
      `the consumer '${consumerRoot}' has no readable 'origin' remote with a host${consumerUrl === undefined ? "" : ` ('${redactRemoteCredentials(consumerUrl)}')`}, so there is no host to hold ${source}'s checkout to. Add the consumer's origin.`,
    );
  }
  const host = remoteHost(url);
  if (host !== consumerHost) {
    return failed(real, "wrong-host", `'${real}''s origin '${redacted}' is on ${host ?? "no host"}, but the consumer's origin is on ${consumerHost}. The canon is read from the consumer's own host.`);
  }

  const tag = git(["rev-parse", "--verify", "--quiet", `refs/tags/${ref}^{commit}`]);
  const tagCommit = outputLines(tag.stdout)[0];
  if (tag.code !== 0 || tagCommit === undefined) {
    return failed(real, "tag-missing", `'${real}' has no tag ${ref}. Fetch the tags (git -C '${real}' fetch --tags origin) and check ${ref} out; nen fetches nothing.`);
  }
  const head = git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const headCommit = outputLines(head.stdout)[0];
  if (head.code !== 0 || headCommit === undefined) return failed(real, "off-pin", `'${real}' has no HEAD commit, so it is not at ${ref}.`);
  if (headCommit !== tagCommit) {
    return failed(real, "off-pin", `'${real}' is at ${headCommit.slice(0, 12)}, not at ${ref} (${tagCommit.slice(0, 12)}). Check ${ref} out there; nen never moves a checkout.`);
  }

  // CLEAN MEANS NOTHING ON DISK DIFFERS FROM THE TAG, whatever the checkout's
  // own configuration hides (Nobunaga N1): untracked files under
  // status.showUntrackedFiles=no, ignored files -- a rule file an exclude
  // hides is still a rule file the mirror reads -- and submodules are all
  // shown, explicitly, rather than left to config.
  const status = git(["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"]);
  if (status.code !== 0) return failed(real, "not-a-checkout", `git status failed in '${real}', so its cleanliness cannot be read.`);
  const dirty = outputLines(status.stdout);
  if (dirty.length > 0) {
    return failed(real, "dirty", `'${real}' is at ${ref} but has ${dirty.length} uncommitted, untracked or ignored entr${dirty.length === 1 ? "y" : "ies"} (first: '${dirty[0] ?? ""}'). A mirror rendered from it would cite ${ref} for bytes ${ref} does not hold.`);
  }
  // AND NOTHING STATUS IS TOLD TO LOOK AWAY FROM: an assume-unchanged entry
  // (a lowercase tag) or a skip-worktree one (`S`) hides an edit from status.
  const files = git(["ls-files", "-v"]);
  if (files.code !== 0) return failed(real, "not-a-checkout", `git ls-files failed in '${real}', so its hidden-change flags cannot be read.`);
  const hidden = outputLines(files.stdout).filter((line): boolean => {
    const flag = line.charAt(0);
    return flag === "S" || /^[a-z]$/.test(flag);
  });
  if (hidden.length > 0) {
    return failed(real, "dirty", `'${real}' has ${hidden.length} file${hidden.length === 1 ? "" : "s"} marked assume-unchanged or skip-worktree (first: '${hidden[0] ?? ""}'), so status cannot vouch for ${ref}'s bytes. Clear the flags (git update-index --no-assume-unchanged / --no-skip-worktree).`);
  }

  return { path: real, verified: { origin: redacted, originSlug: parsed.slug, host, head: headCommit, tag: ref, tagCommit, clean: true } };
}


// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The resolution in text: one line per fact, the passed-over steps included. */
export function checkoutLines(resolution: CheckoutResolution): string[] {
  const lines = [`source: ${resolution.source}@${resolution.ref}`, `checkout: ${resolution.path ?? "(unresolved)"}`];
  if (resolution.resolvedFrom !== null) lines.push(`resolved from: ${resolution.resolvedFrom.kind} ${resolution.resolvedFrom.from}`);
  for (const step of resolution.steps) {
    if (step.status === "absent") lines.push(`  passed over: ${step.kind} ${step.from} (${step.note ?? "absent"})`);
  }
  if (resolution.verified !== null) {
    const v = resolution.verified;
    lines.push(`verified: origin ${v.origin} names ${v.originSlug} on ${v.host}; HEAD ${v.head.slice(0, 12)} is ${v.tag}; clean`);
  }
  if (resolution.failure !== null) lines.push(`failed: ${resolution.failure.code}: ${resolution.failure.message}`);
  return lines;
}
