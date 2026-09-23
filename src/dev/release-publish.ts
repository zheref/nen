// src/dev/release-publish.ts -- publish ONE GitHub Release for a tag that
// already resolves on origin. The argv of `project.verbs.nen.release`.
//
// WHY THIS EXISTS. `nen shu release` runs whatever a repository declares under
// `project.verbs.<lane>.release`, and nen's own row was a SEAT: "publishing is
// `nen tag cut` plus a GitHub Release the maintainer creates by hand". That was
// false in practice -- v0.12.0, v0.13.0, v0.13.1 and v0.14.0 were each published
// by an agent session running `gh release create` on the maintainer's
// credentials after the maintainer's G3 go -- and the cost was concrete: Hatsu's
// `mugetsu`, whose whole job is to run this row at G3, got exit 4 from the seat
// and stopped, so publication happened outside the declared machinery. A
// declaration that disagrees with the practice is a bug in the declaration.
// Ported from zheref/hatsu's scripts/release-publish.sh, which retired the
// identical seat on 2026-09-19.
//
// A REPOSITORY SCRIPT, NOT A VERB, in `src/dev/` beside `sign.ts` and
// `matrix.ts`, and TypeScript rather than Hatsu's bash because
// `bootstrap/nen.sh` is the one shell file this repository ships (AK-11) and
// D16 bars a runtime python3 -- the two things Hatsu's script is written in.
//
// WHAT IT DOES, AND WHAT IT DOES NOT. It creates a GitHub Release for a tag
// that ALREADY exists locally and on the remote. It cuts no tag (`nen tag
// cut`), pushes nothing, builds nothing and uploads no asset: nen's
// `release-assets` workflow attaches the three binaries and SHA256SUMS on
// `release: published`. The notes are the tag's own CHANGELOG.md section(s),
// read from the TAG's tree (`git show <tag>:CHANGELOG.md`) so they are the
// notes that tag carries, not whatever the working tree says today.
//
// --tag IS OPTIONAL, deliberately: `nen shu release` runs the declared argv with
// no arguments of its own, so a row that required one could never be run by
// the verb that exists to run it. Omitted, the tag is the newest `v*` by
// version sort and it is NAMED as DERIVED in every output.
//
// EVERY REFUSAL FIRES BEFORE ANYTHING IS SENT. A GitHub Release notifies
// watchers the moment it exists, and one G3 go publishes one target once:
//   exit 1 -- no `v*` tag to derive from; the tag does not resolve locally; no
//             changelog section for it; the tag is not on the remote; a release
//             already exists for it.
//   exit 2 -- a usage defect; no `gh` or no usable token; no derivable slug.
// G3 (CON-6) still holds the go: this row is what mugetsu RUNS, never
// permission to run it.
//
// USAGE
//   bun src/dev/release-publish.ts [--tag <vX.Y.Z>] [--repo <path>]
//     [--slug <owner/name>] [--changelog <path>] [--previous-tag <vX.Y.Z>]
//     [--title <text>] [--dry-run] [--json]
//   bun src/dev/release-publish.ts --self-test

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const USAGE =
  "usage: bun src/dev/release-publish.ts [--tag <vX.Y.Z>] [--repo <path>] [--slug <owner/name>] [--changelog <path>] [--previous-tag <vX.Y.Z>] [--title <text>] [--dry-run] [--json] | --self-test";

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: NodeJS.ErrnoException | undefined;
}

/** Every external process goes through this, so the self-test can fake `gh`. */
export type Run = (exe: string, args: readonly string[], cwd: string) => RunResult;

const defaultRun: Run = (exe, args, cwd) => {
  const result = spawnSync(exe, [...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
};

export interface Options {
  tag?: string;
  repo: string;
  slug?: string;
  changelog?: string;
  previousTag?: string;
  title?: string;
  dryRun: boolean;
  json: boolean;
  selfTest: boolean;
}

class Refusal extends Error {
  constructor(message: string, readonly code: 1 | 2) {
    super(message);
  }
}

const VALUED = new Set(["--tag", "--repo", "--slug", "--changelog", "--previous-tag", "--title"]);

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = { repo: ".", dryRun: false, json: false, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--self-test") options.selfTest = true;
    else if (VALUED.has(flag)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--") || value === "") throw new Refusal(`${flag} needs a value. ${USAGE}`, 2);
      i += 1;
      if (flag === "--tag") options.tag = value;
      else if (flag === "--repo") options.repo = value;
      else if (flag === "--slug") options.slug = value;
      else if (flag === "--changelog") options.changelog = value;
      else if (flag === "--previous-tag") options.previousTag = value;
      else options.title = value;
    } else throw new Refusal(`unexpected argument '${flag}'. ${USAGE}`, 2);
  }
  return options;
}

/** `https://github.com/o/n.git` or `git@github.com:o/n.git` -> `o/n`. */
export function slugFromRemote(url: string): string | undefined {
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1];
}

/** The tag immediately BELOW `tag` in descending version order -- not merely the newest other one. */
export function previousTagOf(descending: readonly string[], tag: string): string | undefined {
  const at = descending.indexOf(tag);
  return at === -1 ? undefined : descending[at + 1];
}

function headingVersion(section: string): string {
  return (section.split("\n")[0] ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * Every `## ` section from `tag` down to, but excluding, `previous` -- so a tag
 * closing a multi-version gap carries every section in it. `undefined` when the
 * changelog has no section for the tag: the notes are never invented.
 */
export function composeNotes(changelog: string, tag: string, previous?: string): { notes: string; sections: number } | undefined {
  const sections = changelog.replace(/\r\n/g, "\n").split(/^## /m).slice(1);
  const out: string[] = [];
  let seen = false;
  for (const section of sections) {
    const version = headingVersion(section);
    if (seen && previous !== undefined && version === previous) break;
    if (version === tag) seen = true;
    if (seen) out.push(`## ${section.trimEnd()}\n`);
  }
  if (out.length === 0) return undefined;
  return { notes: out.join("\n"), sections: out.length };
}

/** `## v0.14.0 — unreleased` is a section a release must not carry. */
export function unreleasedHeading(changelog: string, tag: string): boolean {
  const line = changelog.split(/\r?\n/).find((l): boolean => l.startsWith("## ") && headingVersion(l.slice(3)) === tag);
  return line !== undefined && /unreleased/i.test(line);
}

export interface Plan {
  readonly slug: string;
  readonly tag: string;
  readonly derived: boolean;
  readonly previous: string | undefined;
  readonly title: string;
  readonly notes: string;
  readonly sections: number;
  readonly latest: boolean;
  readonly latestWhy: string;
  readonly argv: readonly string[];
}

function git(run: Run, repo: string, args: readonly string[]): RunResult {
  const result = run("git", args, repo);
  if (result.error !== undefined) throw new Refusal(`could not run git: ${result.error.message}`, 2);
  return result;
}

/** Everything local: resolve the tag, the slug, the notes and the argv. Sends nothing. */
export function plan(options: Options, run: Run = defaultRun): Plan {
  if (!existsSync(options.repo)) throw new Refusal(`--repo '${options.repo}' does not exist`, 2);
  const listed = git(run, options.repo, ["tag", "--list", "v*", "--sort=-v:refname"]);
  if (listed.status !== 0) throw new Refusal(`'git tag --list' failed in ${options.repo}: ${listed.stderr.trim()}`, 2);
  const descending = listed.stdout.split("\n").map((t): string => t.trim()).filter((t): boolean => t !== "");

  let tag = options.tag;
  const derived = tag === undefined;
  if (tag === undefined) {
    tag = descending[0];
    if (tag === undefined) throw new Refusal("no --tag was given and this repository has no 'v*' tag to derive one from. Cut one first ('nen tag cut'); this script publishes a tag, it never creates one.", 1);
  }
  if (git(run, options.repo, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).status !== 0) {
    throw new Refusal(`tag '${tag}' does not resolve in ${options.repo}. This script publishes a tag that already exists; cutting one is 'nen tag cut'.`, 1);
  }

  let slug = options.slug;
  if (slug === undefined) {
    const origin = git(run, options.repo, ["remote", "get-url", "origin"]);
    slug = origin.status === 0 ? slugFromRemote(origin.stdout) : undefined;
    if (slug === undefined) throw new Refusal("could not derive <owner/name> from origin; pass --slug", 2);
  }

  let changelog: string;
  let changelogSource: string;
  if (options.changelog !== undefined) {
    changelogSource = options.changelog;
    try {
      changelog = readFileSync(options.changelog, "utf8");
    } catch {
      throw new Refusal(`changelog '${options.changelog}' is not readable. The notes are composed from it; this script does not invent them.`, 1);
    }
  } else {
    changelogSource = `${tag}:CHANGELOG.md`;
    const shown = git(run, options.repo, ["show", `${tag}:CHANGELOG.md`]);
    if (shown.status !== 0) throw new Refusal(`'${tag}' carries no CHANGELOG.md. The notes are the tag's own changelog section; this script does not invent them.`, 1);
    changelog = shown.stdout;
  }

  const previous = options.previousTag ?? previousTagOf(descending, tag);
  const composed = composeNotes(changelog, tag, previous);
  if (composed === undefined) throw new Refusal(`no '## ${tag}' section in ${changelogSource}. The notes are the changelog's; this script does not write them.`, 1);
  if (unreleasedHeading(changelog, tag)) throw new Refusal(`the '## ${tag}' section in ${changelogSource} still says 'unreleased'. The release proposal dates it; publish the tag that carries the dated section.`, 1);

  // --latest moves a pointer, so it is passed only for the newest v*: a backfill
  // passing it would move GitHub's "Latest release" backwards.
  const newest = descending[0];
  const latest = tag === newest;
  const latestWhy = latest ? `yes -- '${tag}' is the newest v* tag` : `NO -- '${tag}' is older than '${newest ?? "?"}'; --latest would move the pointer backwards`;
  const title = options.title ?? `Nen ${tag}`;
  const argv = ["release", "create", tag, "--repo", slug, "--title", title, "--notes-file", "<notes>", "--verify-tag", ...(latest ? ["--latest"] : ["--latest=false"])];
  return { slug, tag, derived, previous, title, notes: composed.notes, sections: composed.sections, latest, latestWhy, argv };
}

function renderPlan(p: Plan, source: string): string {
  return [
    "would publish:",
    `  repository : ${p.slug}`,
    `  tag        : ${p.tag}${p.derived ? " (DERIVED -- newest v* tag; no --tag was given)" : ""}`,
    `  previous   : ${p.previous ?? "(none -- first release)"}`,
    `  title      : ${p.title}`,
    `  notes      : ${Buffer.byteLength(p.notes)} bytes, ${p.sections} section(s) from ${source}`,
    "  assets     : none (release-assets attaches the binaries on release: published)",
    `  command    : gh ${p.argv.join(" ")}`,
    `  latest     : ${p.latestWhy}`,
    "",
    "nothing was sent (--dry-run).",
  ].join("\n");
}

export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const defaultIo: Io = {
  out: (line): void => { process.stdout.write(`${line}\n`); },
  err: (line): void => { process.stderr.write(`${line}\n`); },
};

export function publish(options: Options, run: Run = defaultRun, io: Io = defaultIo): number {
  const p = plan(options, run);
  const source = options.changelog ?? `${p.tag}:CHANGELOG.md`;
  if (options.dryRun) {
    io.out(options.json ? JSON.stringify({ schema: "nen.dev.release-publish/v0.1", sent: false, ...p }) : renderPlan(p, source));
    return 0;
  }
  const auth = run("gh", ["auth", "status"], options.repo);
  if (auth.error !== undefined) throw new Refusal("no 'gh' on PATH -- this row publishes through the GitHub CLI", 2);
  if (auth.status !== 0) throw new Refusal("'gh' has no usable token; publication needs one", 2);
  if (run("gh", ["api", `repos/${p.slug}/git/ref/tags/${p.tag}`], options.repo).status !== 0) {
    throw new Refusal(`tag '${p.tag}' does not exist on ${p.slug}. Push it first ('nen tag cut --push'); a release must not point at a ref nobody can fetch.`, 1);
  }
  if (run("gh", ["release", "view", p.tag, "--repo", p.slug], options.repo).status === 0) {
    throw new Refusal(`a release already exists for '${p.tag}' on ${p.slug}. Re-publishing is never the fix; edit it by hand if the notes are wrong.`, 1);
  }
  const dir = mkdtempSync(join(tmpdir(), "nen-release-notes-"));
  try {
    const notesFile = join(dir, "notes.md");
    writeFileSync(notesFile, p.notes);
    const argv = p.argv.map((a): string => (a === "<notes>" ? notesFile : a));
    const created = run("gh", argv, options.repo);
    if (created.status !== 0) throw new Refusal(`'gh release create ${p.tag}' failed: ${created.stderr.trim()}`, 1);
    const url = created.stdout.trim().split("\n").pop() ?? "";
    io.out(options.json
      ? JSON.stringify({ schema: "nen.dev.release-publish/v0.1", sent: true, slug: p.slug, tag: p.tag, derived: p.derived, latest: p.latest, url })
      : `published ${p.tag}${p.derived ? " (derived)" : ""}: ${url}`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// self-test -- hermetic and offline: a throwaway git repository, a faked `gh`
// that records instead of sending, and nothing published, ever.
// --------------------------------------------------------------------------

const FIXTURE_CHANGELOG = `# Changelog

## v2.0.0 — the new one

- a thing that landed

## v1.0.0 — the old one

- ancient history
`;

export interface SelfTestResult {
  readonly ran: number;
  readonly failed: number;
  readonly lines: readonly string[];
}

export function selfTest(): SelfTestResult {
  const lines: string[] = [];
  let ran = 0;
  let failed = 0;
  const ok = (pass: boolean, name: string): void => {
    ran += 1;
    if (!pass) failed += 1;
    lines.push(`  ${pass ? "ok  " : "FAIL"}  ${name}`);
  };
  const root = mkdtempSync(join(tmpdir(), "nen-release-publish-"));
  const quiet: Io = { out: (): void => undefined, err: (): void => undefined };
  const capture = (): { io: Io; text: () => string } => {
    const buf: string[] = [];
    return { io: { out: (l): void => { buf.push(l); }, err: (l): void => { buf.push(l); } }, text: (): string => buf.join("\n") };
  };
  // Fake gh: remote tags, existing releases and every call recorded. Git is real.
  const fakeGh = (remoteTags: readonly string[], released: readonly string[], calls: string[][]): Run => (exe, args, cwd) => {
    if (exe !== "gh") return defaultRun(exe, args, cwd);
    calls.push([...args]);
    const pass: RunResult = { status: 0, stdout: "https://github.com/acme/widget/releases/tag/x\n", stderr: "" };
    const fail: RunResult = { status: 1, stdout: "", stderr: "not found" };
    if (args[0] === "auth") return pass;
    if (args[0] === "api") return remoteTags.some((t): boolean => (args[1] ?? "").endsWith(`/tags/${t}`)) ? pass : fail;
    if (args[0] === "release" && args[1] === "view") return released.includes(args[2] ?? "") ? pass : fail;
    return pass;
  };
  const outcome = (fn: () => number): number => {
    try {
      return fn();
    } catch (error) {
      return error instanceof Refusal ? error.code : 99;
    }
  };
  try {
    const repo = join(root, "widget");
    const g = (...args: string[]): void => {
      const r = spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`self-test fixture: git ${args.join(" ")}: ${r.stderr}`);
    };
    spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
    g("remote", "add", "origin", "https://github.com/acme/widget.git");
    writeFileSync(join(repo, "CHANGELOG.md"), FIXTURE_CHANGELOG);
    g("add", "CHANGELOG.md");
    g("commit", "-qm", "chore: seed");
    g("tag", "v1.0.0");
    g("tag", "v2.0.0");
    writeFileSync(join(repo, "CHANGELOG.md"), `# Changelog\n\n## v3.0.0 — unreleased\n\n- pending\n\n${FIXTURE_CHANGELOG.slice("# Changelog\n\n".length)}`);
    const base = (extra: Partial<Options> = {}): Options => ({ ...parseArgs([]), repo, ...extra });

    lines.push("notes composition -- the changelog's, never this script's");
    const dry = capture();
    ok(outcome(() => publish(base({ tag: "v2.0.0", dryRun: true }), defaultRun, dry.io)) === 0, "--dry-run exits 0");
    const n = dry.text();
    ok(n.includes("would publish") && n.includes("nothing was sent"), "--dry-run prints a plan and sends nothing");
    ok(n.includes("acme/widget"), "the slug is derived from origin");
    ok(n.includes("title      : Nen v2.0.0"), "the title follows nen's 'Nen <tag>' convention");
    ok(n.includes("1 section(s) from v2.0.0:CHANGELOG.md"), "one section, read from the TAG's tree, not the working tree");
    ok(n.includes("--verify-tag --latest") && n.includes("latest     : yes"), "--latest is passed for the newest tag");
    const gap = plan(base({ tag: "v2.0.0", previousTag: "v0.1.0" }));
    ok(gap.sections === 2, "a multi-version gap carries every section in it");
    const old = plan(base({ tag: "v1.0.0" }));
    ok(old.previous === undefined && old.sections === 1, "an older target derives the tag BELOW it and carries only its own section");
    ok(!old.latest && old.argv.includes("--latest=false"), "--latest is withheld for an older tag -- the pointer never moves backwards");

    lines.push("the derived tag");
    const derived = plan(base());
    ok(derived.tag === "v2.0.0" && derived.derived, "an omitted --tag derives the newest v*");
    const dd = capture();
    publish(base({ dryRun: true }), defaultRun, dd.io);
    ok(dd.text().includes("v2.0.0 (DERIVED"), "and names it as DERIVED");

    lines.push("local refusals -- each before anything is sent");
    const empty = join(root, "empty");
    spawnSync("git", ["init", "-q", empty], { encoding: "utf8" });
    ok(outcome(() => publish({ ...base({ dryRun: true }), repo: empty, slug: "a/b" }, defaultRun, quiet)) === 1, "no v* tag at all refuses (1) -- it publishes a tag, never creates one");
    ok(outcome(() => publish(base({ tag: "v9.9.9", dryRun: true }), defaultRun, quiet)) === 1, "a tag that does not resolve locally refuses (1)");
    ok(outcome(() => publish(base({ tag: "v2.0.0", changelog: join(root, "nope.md"), dryRun: true }), defaultRun, quiet)) === 1, "an unreadable --changelog refuses (1)");
    writeFileSync(join(root, "partial.md"), "# Changelog\n\n## v1.0.0 — only this\n\n- x\n");
    ok(outcome(() => publish(base({ tag: "v2.0.0", changelog: join(root, "partial.md"), dryRun: true }), defaultRun, quiet)) === 1, "no section for the tag refuses (1) -- notes are never invented");
    g("add", "CHANGELOG.md");
    g("commit", "-qm", "chore: v3 pending");
    g("tag", "v3.0.0");
    ok(outcome(() => publish(base({ tag: "v3.0.0", dryRun: true }), defaultRun, quiet)) === 1, "a section still marked 'unreleased' refuses (1)");
    ok(outcome(() => { parseArgs(["--asset", "x.zip"]); return 0; }) === 2, "--asset is refused (2) -- release-assets uploads, this script never does");
    ok(outcome(() => { parseArgs(["--tag"]); return 0; }) === 2, "a valued flag with no value refuses (2)");

    lines.push("remote refusals -- gh faked, nothing sent");
    const calls1: string[][] = [];
    ok(outcome(() => publish(base({ tag: "v2.0.0" }), fakeGh([], [], calls1), quiet)) === 1, "a tag missing on the remote refuses (1)");
    ok(!calls1.some((c): boolean => c[1] === "create"), "and no release was created");
    const calls2: string[][] = [];
    ok(outcome(() => publish(base({ tag: "v2.0.0" }), fakeGh(["v2.0.0"], ["v2.0.0"], calls2), quiet)) === 1, "a tag that already has a release refuses (1)");
    ok(!calls2.some((c): boolean => c[1] === "create"), "and no release was created");

    lines.push("the one send");
    const calls3: string[][] = [];
    const sent = capture();
    ok(outcome(() => publish(base({ tag: "v2.0.0" }), fakeGh(["v2.0.0"], [], calls3), sent.io)) === 0, "a tag on the remote with no release publishes (0)");
    const creates = calls3.filter((c): boolean => c[0] === "release" && c[1] === "create");
    ok(creates.length === 1, "exactly one 'gh release create'");
    const create = creates[0] ?? [];
    ok(create.includes("--verify-tag") && !create.includes("<notes>") && create.includes("--notes-file"), "with --verify-tag and a real notes file");
    ok(!calls3.some((c): boolean => c[1] === "upload" || c[0] === "push"), "no asset upload, no push");
    ok(sent.text().startsWith("published v2.0.0"), "the output names the tag it published");
  } catch (error) {
    ok(false, `fixture: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { ran, failed, lines };
}

export function releasePublishMain(argv: readonly string[], run: Run = defaultRun, io: Io = defaultIo): number {
  try {
    const options = parseArgs(argv);
    if (options.selfTest) {
      const result = selfTest();
      for (const line of result.lines) io.out(line);
      io.out("");
      io.out(result.failed > 0
        ? `release-publish --self-test: ${result.failed} FAILED of ${result.ran}`
        : `release-publish --self-test: all green (${result.ran} assertions)`);
      return result.failed > 0 ? 1 : 0;
    }
    return publish(options, run, io);
  } catch (error) {
    if (error instanceof Refusal) {
      io.err(`release-publish: ${error.message}`);
      return error.code;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = releasePublishMain(process.argv.slice(2));
}
