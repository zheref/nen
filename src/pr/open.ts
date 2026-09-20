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
}

export type OpenOutcome =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "done"; readonly report: OpenReport; readonly lines: readonly string[] };

export interface OpenOptions {
  readonly base: string;
  /** `--head`, or null for the checked-out branch. */
  readonly head: string | null;
  readonly title: string;
  /** The body file, resolved -- handed to gh as-is. */
  readonly bodyFile: string;
  readonly draft: boolean;
  readonly dryRun: boolean;
}

const PR_URL = /https:\/\/[^\s]+\/pull\/(\d+)/;

function gitError(stderr: string, code: number): string {
  return outputLines(stderr).join(" ") || `exit ${code}`;
}

export function createArgv(target: Target, options: OpenOptions, head: string): readonly string[] {
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
    "--body-file",
    options.bodyFile,
    ...(options.draft ? ["--draft"] : []),
  ];
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
  const local = seams.run(GIT, ["rev-parse", head], { cwd });
  if (local.code !== 0) throw new Error(`could not resolve '${head}' ('git rev-parse ${head}' failed: ${gitError(local.stderr, local.code)}).`);
  const localSha = local.stdout.trim();
  const remote = seams.run(GIT, ["ls-remote", "origin", `refs/heads/${head}`], { cwd });
  if (remote.code !== 0) throw new Error(`could not ask origin what it holds at '${head}' ('git ls-remote origin refs/heads/${head}' failed: ${gitError(remote.stderr, remote.code)}).`);
  const remoteSha = outputLines(remote.stdout)[0]?.split(/\s+/)[0] ?? null;
  if (remoteSha === null) {
    return { kind: "refused", reason: `origin holds nothing at 'refs/heads/${head}': the branch tracks an upstream but the remote does not have it. Push it first ('nen wc publish').` };
  }
  if (remoteSha !== localSha) {
    return { kind: "refused", reason: `the local head of '${head}' (${localSha}) is not what origin holds (${remoteSha}). A pull request opened now would not show the commits you have here; push first ('nen wc publish'), or catch up if the remote moved.` };
  }

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
  const report = (number: number | null, url: string | null, existing: boolean): OpenReport => ({
    contract: OPEN_CONTRACT,
    number,
    url,
    head,
    base: options.base,
    draft: options.draft,
    dryRun: options.dryRun,
    existing,
  });
  const first = open[0];
  if (first !== undefined) {
    const number = typeof first.number === "number" ? first.number : null;
    const url = typeof first.url === "string" ? first.url : null;
    return {
      kind: "done",
      report: report(number, url, true),
      lines: [`a pull request is already open for '${head}': #${number ?? "?"} ${url ?? ""} -- nothing was opened. One head, one pull request.`],
    };
  }

  // 4. THE CREATE, or the line that would.
  const argv = createArgv(target, options, head);
  if (options.dryRun) {
    return { kind: "done", report: report(null, null, false), lines: [`would run: gh ${argv.map((token): string => (/[\s"']/.test(token) ? JSON.stringify(token) : token)).join(" ")}`] };
  }
  const created = seams.run(GH, argv);
  if (created.spawnFailed || created.code !== 0) throw new Error(`pull request creation failed ('gh pr create' ${created.spawnFailed ? "could not be started" : `exited ${created.code}`}: ${gitError(created.stderr, created.code)}).`);
  const match = PR_URL.exec(created.stdout);
  if (match === null || match[1] === undefined) {
    throw new Error("pull request creation returned no pull request URL, so there is nothing to report as opened. Check GitHub before running this again: a second run would open a second one only if the first did not land.");
  }
  const number = Number(match[1]);
  return { kind: "done", report: report(number, match[0], false), lines: [`opened ${target.slug}#${number}: ${match[0]}${options.draft ? " (draft)" : ""}`] };
}
