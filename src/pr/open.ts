// src/pr/open.ts -- `nen pr open`: open exactly ONE pull request from a head
// that is already on the remote, refusing when one is open for that head
// already (zheref/nen#227; Hatsu's `shibari` hand-rolled `gh pr create`).
//
// THE HEAD MUST BE PUSHED, AND THE CHECK IS AGAINST THE REMOTE, NOT A
// TRACKING REF. `git ls-remote origin refs/heads/<head>` asks the remote what
// it holds at that name RIGHT NOW and the answer must equal the local sha:
// a pull request opened from a head the remote does not have (or has an
// older version of) is a pull request whose diff is not the one anybody
// reviewed. No upstream at all is refused first, because a branch nobody
// published is a branch nobody can open a pull request from.
//
// ONE PULL REQUEST PER HEAD. `gh pr list --head <branch> --state open` is
// asked before anything is created; a hit is reported -- number and url --
// at exit 1, and nothing is opened. The second pull request from one branch
// is the mistake every retry wrapper makes once.
//
// THROUGH `gh`, LIKE EVERY OTHER WRITE IN THIS FAMILY. ../pr/fetch.ts reads
// through `gh` and ../issue/file.ts creates through `gh`; this follows the
// same seam and the same result-reading discipline: the number is READ OUT
// of the url gh printed, never assumed.
//
// `--assignee` IS CHECKED BEFORE ANYTHING IS OPENED, AND READ BACK AFTER
// (zheref/nen#293). A rule stated as "every pull request is assigned" that is
// enforced by a `gh pr edit --add-assignee` somebody remembers afterwards
// makes the one forgotten pull request look exactly like the others. So every
// login is asked of GitHub first -- `GET /users/<login>` (does it exist) and
// `GET /repos/<o>/<n>/assignees/<login>` (can it be assigned HERE) -- and any
// that fails refuses the whole call by name, nothing opened: never a pull
// request opened unassigned. `@me` is resolved to the login of the token
// running this verb (`GET /user`) and that login is printed, because an agent
// running on somebody's credentials assigning "me" is exactly the ambiguity
// worth closing; it is never handed to gh literally. After the create the
// assignees are READ BACK (`gh pr view --json assignees`), and one missing is
// exit 1 with the opened pull request still named -- reported, never retried.

import { GH, GIT, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";

export const OPEN_CONTRACT = "nen.pr.open/v0.1";

/** KEY ORDER IS THE CONTRACT; ./open.test.ts pins it. */
export interface OpenReport {
  readonly contract: string;
  /** The pull request's number -- the one opened, or (with `existing`) the one already open. null on a dry run. */
  readonly number: number | null;
  readonly url: string | null;
  readonly head: string;
  readonly base: string;
  readonly draft: boolean;
  readonly dryRun: boolean;
  /** True when a pull request was already open for `head` and nothing was created. */
  readonly existing: boolean;
  /** The validated, canonical logins asked for; [] without `--assignee`. */
  readonly assignees: readonly string[];
  /** The login `@me` resolved to, or null when `@me` was not asked for. */
  readonly me: string | null;
  /** The logins the read-back found assigned; null when nothing was opened or it could not be read. */
  readonly assigned: readonly string[] | null;
}

export type OpenOutcome =
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "done";
      readonly report: OpenReport;
      readonly lines: readonly string[];
      /** Set when the pull request WAS opened but something after the create failed (exit 1). */
      readonly failure?: string;
    };

export interface OpenOptions {
  readonly base: string;
  /** `--head`, or null for the checked-out branch. */
  readonly head: string | null;
  readonly title: string;
  /** The body file, resolved -- named in the dry run's report, never handed to gh. */
  readonly bodyFile: string;
  /**
   * The body's bytes, read once and checked by the private-name guard
   * (zheref/nen#363). THEY are what gh is handed, on stdin (`--body-file -`):
   * the path would be re-read by gh after the check, so anything written to
   * the file in between would be published unchecked.
   */
  readonly body: string;
  readonly draft: boolean;
  readonly dryRun: boolean;
  /** `--assignee`, split and syntax-checked by the caller; `@me` still literal here. */
  readonly assignees: readonly string[];
}

/** `@me`: the token's own login, resolved here and never passed through. */
export const ME = "@me";

/**
 * A GitHub login's shape: alphanumerics and single interior hyphens, 1-39
 * characters. Checked before any call so a login is safe to put in an API
 * path, and so a typo is a usage refusal rather than a 404 to interpret.
 */
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const PR_URL = /https:\/\/[^\s]+\/pull\/(\d+)/;

function gitError(stderr: string, code: number): string {
  return outputLines(stderr).join(" ") || `exit ${code}`;
}

export function createArgv(target: Target, options: OpenOptions, head: string, assignees: readonly string[] = []): readonly string[] {
  return [
    "pr",
    "create",
    "--repo",
    target.slug,
    "--base",
    options.base,
    "--head",
    head,
    "--title",
    options.title,
    // `-`: the body travels on stdin -- the bytes read and checked, never the
    // path (zheref/nen#363, the rule #329 set for 'issue file').
    "--body-file",
    "-",
    ...(options.draft ? ["--draft"] : []),
    ...(assignees.length > 0 ? ["--assignee", assignees.join(",")] : []),
  ];
}

export function meArgv(): readonly string[] {
  return ["api", "--method", "GET", "user"];
}

export function userArgv(login: string): readonly string[] {
  return ["api", "--method", "GET", `users/${login}`];
}

export function assignableArgv(target: Target, login: string): readonly string[] {
  return ["api", "--method", "GET", `repos/${target.slug}/assignees/${login}`];
}

export function assigneesReadArgv(target: Target, number: number): readonly string[] {
  return ["pr", "view", String(number), "--repo", target.slug, "--json", "assignees"];
}

function isNotFound(stderr: string): boolean {
  return /HTTP 404|Not Found/i.test(stderr);
}

function loginOf(stdout: string, what: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`${what} did not answer JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  const login = (parsed as { login?: unknown } | null)?.login;
  if (typeof login !== "string" || !LOGIN.test(login)) {
    throw new Error(`${what} answered no usable login.`);
  }
  return login;
}

/**
 * Every requested login, resolved and validated, or the refusal naming every
 * one that failed. A lookup that could not be MADE (not a 404) throws -- exit
 * 1, nothing opened -- because "could not check" is never "checked".
 */
export function resolveAssignees(
  seams: Seams,
  target: Target,
  requested: readonly string[],
): { readonly kind: "ok"; readonly logins: readonly string[]; readonly me: string | null } | { readonly kind: "refused"; readonly reason: string } {
  let me: string | null = null;
  if (requested.includes(ME)) {
    const result = seams.run(GH, meArgv());
    if (result.spawnFailed || result.code !== 0) {
      throw new Error(`could not resolve '@me' to a login ('gh api user' failed: ${gitError(result.stderr, result.code)}). Nothing was opened.`);
    }
    me = loginOf(result.stdout, "'gh api user'");
  }
  const problems: string[] = [];
  const logins: string[] = [];
  const seen = new Set<string>();
  for (const typed of requested) {
    const asked = typed === ME ? (me as string) : typed;
    const user = seams.run(GH, userArgv(asked));
    if (user.spawnFailed || user.code !== 0) {
      if (!user.spawnFailed && isNotFound(user.stderr)) {
        problems.push(`'${asked}' is not a GitHub user (GET /users/${asked} answered 404).`);
        continue;
      }
      throw new Error(`could not look up assignee '${asked}' ('gh api users/${asked}' failed: ${gitError(user.stderr, user.code)}). Nothing was opened.`);
    }
    const login = loginOf(user.stdout, `'gh api users/${asked}'`);
    const assignable = seams.run(GH, assignableArgv(target, login));
    if (assignable.spawnFailed || assignable.code !== 0) {
      if (!assignable.spawnFailed && isNotFound(assignable.stderr)) {
        problems.push(`'${login}' exists but cannot be assigned on ${target.slug} (GET /repos/${target.slug}/assignees/${login} answered 404).`);
        continue;
      }
      throw new Error(`could not check whether '${login}' can be assigned on ${target.slug} ('gh api repos/${target.slug}/assignees/${login}' failed: ${gitError(assignable.stderr, assignable.code)}). Nothing was opened.`);
    }
    const key = login.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      logins.push(login);
    }
  }
  if (problems.length > 0) {
    return { kind: "refused", reason: `--assignee: ${problems.join(" ")} Nothing was opened -- a pull request is never opened unassigned when an assignee was asked for.` };
  }
  return { kind: "ok", logins, me };
}

/** The logins GitHub reports assigned, or null with the reason it could not be read. */
function readAssigned(seams: Seams, target: Target, number: number): { readonly logins: readonly string[] | null; readonly error: string | null } {
  const result = seams.run(GH, assigneesReadArgv(target, number));
  if (result.spawnFailed || result.code !== 0) {
    return { logins: null, error: `'gh pr view ${number} --json assignees' failed: ${gitError(result.stderr, result.code)}` };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { assignees?: unknown };
    if (!Array.isArray(parsed.assignees)) throw new Error("no assignees array");
    const logins = (parsed.assignees as { login?: unknown }[]).map((entry): string => {
      if (typeof entry?.login !== "string") throw new Error("an assignee with no login");
      return entry.login;
    });
    return { logins, error: null };
  } catch (error) {
    return { logins: null, error: `'gh pr view ${number} --json assignees' answered unreadably (${error instanceof Error ? error.message : String(error)})` };
  }
}

export function listArgv(target: Target, head: string): readonly string[] {
  return ["pr", "list", "--repo", target.slug, "--head", head, "--state", "open", "--json", "number,url"];
}

export function openPullRequest(seams: Seams, cwd: string, target: Target, options: OpenOptions): OpenOutcome {
  // 1. THE HEAD: named, or the branch checked out here.
  let head = options.head;
  if (head === null) {
    const branch = seams.run(GIT, ["symbolic-ref", "--short", "HEAD"], { cwd });
    if (branch.code !== 0) {
      return { kind: "refused", reason: `HEAD is detached ('git symbolic-ref --short HEAD' failed: ${gitError(branch.stderr, branch.code)}) and no --head was given -- there is no branch to open a pull request from.` };
    }
    head = branch.stdout.trim();
  }

  // 2. PUBLISHED, AND CURRENT ON THE REMOTE.
  const upstream = seams.run(GIT, ["rev-parse", "--abbrev-ref", `${head}@{upstream}`], { cwd });
  if (upstream.code !== 0) {
    return { kind: "refused", reason: `'${head}' has no upstream -- it has never been published, so there is nothing on GitHub to open a pull request from. Push it first ('nen wc publish --set-upstream').` };
  }
  // THE REMOTE IS THE UPSTREAM'S, never a hard-coded `origin` (Nobunaga N7):
  // `<remote>/<branch>` is split the way ../wc/publish.ts splits it, and it is
  // THAT remote which is asked what it holds.
  const upstreamName = upstream.stdout.trim();
  const slash = upstreamName.indexOf("/");
  if (slash === -1) throw new Error(`the upstream of '${head}' is '${upstreamName}', which does not look like '<remote>/<branch>' -- refusing to guess which remote to ask.`);
  const remoteName = upstreamName.slice(0, slash);
  const tracked = upstreamName.slice(slash + 1);
  const local = seams.run(GIT, ["rev-parse", head], { cwd });
  if (local.code !== 0) throw new Error(`could not resolve '${head}' ('git rev-parse ${head}' failed: ${gitError(local.stderr, local.code)}).`);
  const localSha = local.stdout.trim();
  const remote = seams.run(GIT, ["ls-remote", remoteName, `refs/heads/${tracked}`], { cwd });
  if (remote.code !== 0) throw new Error(`could not ask ${remoteName} what it holds at '${tracked}' ('git ls-remote ${remoteName} refs/heads/${tracked}' failed: ${gitError(remote.stderr, remote.code)}).`);
  const remoteSha = outputLines(remote.stdout)[0]?.split(/\s+/)[0] ?? null;
  if (remoteSha === null) {
    return { kind: "refused", reason: `${remoteName} holds nothing at 'refs/heads/${tracked}': '${head}' tracks '${upstreamName}' but the remote does not have it. Push it first ('nen wc publish').` };
  }
  if (remoteSha !== localSha) {
    return { kind: "refused", reason: `the local head of '${head}' (${localSha}) is not what ${remoteName} holds at '${tracked}' (${remoteSha}). A pull request opened now would not show the commits you have here; push first ('nen wc publish'), or catch up if the remote moved.` };
  }

  // 2b. THE ASSIGNEES, every one checked before anything is opened.
  let assignees: readonly string[] = [];
  let me: string | null = null;
  if (options.assignees.length > 0) {
    const resolved = resolveAssignees(seams, target, options.assignees);
    if (resolved.kind === "refused") return resolved;
    assignees = resolved.logins;
    me = resolved.me;
  }
  const meLines = me === null ? [] : [`@me resolved to '${me}' (the login of the token running this verb).`];

  // 3. ONE PULL REQUEST PER HEAD.
  const listed = seams.run(GH, listArgv(target, head));
  if (listed.spawnFailed || listed.code !== 0) throw new Error(`could not list open pull requests for '${head}' on ${target.slug} ('gh pr list' failed: ${gitError(listed.stderr, listed.code)}).`);
  let open: { number?: unknown; url?: unknown }[];
  try {
    const parsed = JSON.parse(listed.stdout.trim() === "" ? "[]" : listed.stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not an array");
    open = parsed as { number?: unknown; url?: unknown }[];
  } catch (error) {
    throw new Error(`'gh pr list' for '${head}' did not answer a JSON array (${error instanceof Error ? error.message : String(error)}).`);
  }
  const report = (number: number | null, url: string | null, existing: boolean, assigned: readonly string[] | null = null): OpenReport => ({
    contract: OPEN_CONTRACT,
    number,
    url,
    head,
    base: options.base,
    draft: options.draft,
    dryRun: options.dryRun,
    existing,
    assignees,
    me,
    assigned,
  });
  const first = open[0];
  if (first !== undefined) {
    const number = typeof first.number === "number" ? first.number : null;
    const url = typeof first.url === "string" ? first.url : null;
    return {
      kind: "done",
      report: report(number, url, true),
      lines: [...meLines, `a pull request is already open for '${head}': #${number ?? "?"} ${url ?? ""} -- nothing was opened. One head, one pull request.`],
    };
  }

  // 4. THE CREATE, or the line that would.
  const argv = createArgv(target, options, head, assignees);
  if (options.dryRun) {
    return { kind: "done", report: report(null, null, false), lines: [...meLines, `would run: gh ${argv.map((token): string => (/[\s"']/.test(token) ? JSON.stringify(token) : token)).join(" ")}`] };
  }
  const created = seams.run(GH, argv, { stdin: options.body });
  const match = created.spawnFailed ? null : PR_URL.exec(created.stdout);
  if (created.spawnFailed || (created.code !== 0 && match === null)) throw new Error(`pull request creation failed ('gh pr create' ${created.spawnFailed ? "could not be started" : `exited ${created.code}`}: ${gitError(created.stderr, created.code)}).`);
  if (match === null || match[1] === undefined) {
    throw new Error("pull request creation returned no pull request URL, so there is nothing to report as opened. Check GitHub before running this again: a second run would open a second one only if the first did not land.");
  }
  const number = Number(match[1]);
  const openedLine = `opened ${target.slug}#${number}: ${match[0]}${options.draft ? " (draft)" : ""}`;
  // A NON-ZERO EXIT THAT STILL PRINTED A URL OPENED SOMETHING. It is reported
  // as opened -- never as "creation failed", which would invite a second one
  // -- and the exit is 1, naming what gh said.
  const createFailure = created.code === 0 ? null : `'gh pr create' exited ${created.code} after printing ${match[0]} (${gitError(created.stderr, created.code)}); the pull request exists. Check it before running anything again.`;
  if (assignees.length === 0) {
    return { kind: "done", report: report(number, match[0], false), lines: [openedLine], ...(createFailure === null ? {} : { failure: createFailure }) };
  }
  const readBack = readAssigned(seams, target, number);
  const assignedLine = readBack.logins === null ? [] : [`assigned (read back): ${readBack.logins.length === 0 ? "nobody" : readBack.logins.join(", ")}`];
  const done = (failure: string | null): OpenOutcome => ({
    kind: "done",
    report: report(number, match[0], false, readBack.logins),
    lines: [...meLines, openedLine, ...assignedLine],
    ...(failure === null ? {} : { failure }),
  });
  if (readBack.logins === null) {
    return done(`${target.slug}#${number} was opened, and its assignees could not be read back (${readBack.error ?? "unknown"}); the assignment is NOT confirmed. Check it before assigning again.${createFailure === null ? "" : ` ${createFailure}`}`);
  }
  const have = new Set(readBack.logins.map((login): string => login.toLowerCase()));
  const missing = assignees.filter((login): boolean => !have.has(login.toLowerCase()));
  if (missing.length > 0) {
    return done(`${target.slug}#${number} was opened, and the read-back does not show ${missing.map((login): string => `'${login}'`).join(", ")} assigned. Nothing was retried.${createFailure === null ? "" : ` ${createFailure}`}`);
  }
  return done(createFailure);
}
