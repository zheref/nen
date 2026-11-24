// src/pr/version_collision.testkit.ts -- a scripted repository for the
// version-collision limb's tests (zheref/nen#663): branches, commits carrying
// a plugin manifest, merge bases and an open pull request inventory, served
// through the same optional `PrStateSource` methods the real client offers.
// Every read is recorded by key, any key can be made to fail, and a hook runs
// after each read so a test can move the repository between the two passes.
//
// Fictional throughout: the repository is `acme/widget`. It names no
// reviewer and reads no fixture: the caller hands it the gates text and the
// reviews a ready head carries, so the identities stay the caller's data.

import type { PrRef, PrStateSource } from "../github/pr_state.js";
import type { CheckRollupPage, PullRequestSnapshot, ReviewRequestsPage, ReviewThreadPage } from "../github/graphql.js";

const GATES_FILE = "nen/gates.json";

export const OWNER = "acme";
export const NAME = "widget";
export const SLUG = `${OWNER}/${NAME}`;
export const VERSION_FILE = ".claude-plugin/plugin.json";
export const OPT_IN = { version_file: VERSION_FILE, version_pointer: "/version", shipped_paths: ["claude/**", ".claude-plugin/**"] };

/** A 40-hex SHA from a short hex seed: `sha("1a")` is `1a1a…`. */
export function sha(seed: string): string {
  return seed.repeat(Math.ceil(40 / seed.length)).slice(0, 40);
}

/** Pass to `gatesText` to leave the `version_collision` key out altogether. */
export const NO_OPT_IN: unique symbol = Symbol("no version_collision key");

/** A gates file's text with `version_collision` set to `versionCollision` (`NO_OPT_IN`: the key left out). */
export function withOptIn(gates: string, versionCollision: unknown = OPT_IN): string {
  const fixture = JSON.parse(gates) as Record<string, unknown>;
  return JSON.stringify(versionCollision === NO_OPT_IN ? fixture : { ...fixture, version_collision: versionCollision }, null, 2);
}

export function manifest(version: string): string {
  return JSON.stringify({ name: "widget", version, description: "a fictional plugin" }, null, 2);
}

export interface WorldPr {
  readonly number: number;
  head: string;
  base: string;
  readonly draft?: boolean;
  readonly fork?: boolean;
  files: string[];
}

export interface CollisionWorld {
  readonly defaultBranch: string;
  /** Branch name -> live tip. */
  branches: Record<string, string>;
  /** Commit -> the manifest's version; `null` is a commit with no manifest. */
  versions: Record<string, string | null>;
  /** Commit -> raw manifest text, winning over `versions`. */
  manifests: Record<string, string>;
  /** `<base>...<head>` -> merge base. */
  mergeBases: Record<string, string>;
  /** The gates text at any commit (`null`: no file). */
  gatesAt: (ref: string) => string | null;
  /** The reviews a head carries -- the caller's identities, never this kit's. */
  readonly reviewsAt: (head: string) => unknown[];
  /** Open pull requests, oldest first; the subject among them. */
  prs: WorldPr[];
  /** The snapshot's oids, frozen when set (the live tips may then differ). */
  snapshot?: { readonly base: string; readonly default: string };
}

export interface ReadOptions {
  /** Keys whose read throws. */
  readonly fail?: ReadonlySet<string>;
  /** Runs after each SERVED read, with how many times that key has been read. */
  readonly after?: (key: string, count: number) => void;
  /** Optional methods the transport does not offer. */
  readonly omit?: readonly ("fileAtRef" | "pullRequestFiles" | "openPullRequestsPage" | "branchTip" | "mergeBase")[];
}

export interface WorldSource extends PrStateSource {
  readonly calls: string[];
}

/** A whole readiness source for one subject, its collision reads scripted from `world`. */
export function worldSource(world: CollisionWorld, subject: number, options: ReadOptions = {}): WorldSource {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const serve = <T>(key: string, value: () => T): T => {
    calls.push(key);
    if (options.fail?.has(key) === true) throw new Error(`HTTP 502: scripted failure of ${key}`);
    const result = value();
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    options.after?.(key, count);
    return result;
  };
  const pr = (): WorldPr => {
    const found = world.prs.find((entry): boolean => entry.number === subject);
    if (found === undefined) throw new Error(`the world has no #${subject}`);
    return found;
  };
  const snapshot = (): PullRequestSnapshot => {
    const own = pr();
    return {
      pullRequest: {
        number: subject,
        mergeable: "MERGEABLE",
        isDraft: false,
        headRefOid: own.head,
        headRefName: `feature/${subject}`,
        baseRefName: own.base,
        baseRefOid: world.snapshot?.base ?? world.branches[own.base] ?? "",
        author: { login: "someone" },
        labels: [],
        reviewRequests: [],
      },
      defaultBranch: world.defaultBranch,
      defaultBranchOid: world.snapshot?.default ?? world.branches[world.defaultBranch] ?? "",
      checkRollup: [{ name: "ci / build", status: "COMPLETED", conclusion: "SUCCESS" }],
      checkRollupPageInfo: { hasNextPage: false, endCursor: null },
      reviewRequests: [],
      reviewRequestsPageInfo: { hasNextPage: false, endCursor: null },
    };
  };
  const source: Record<string, unknown> = {
    calls,
    pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => snapshot(),
    reviews: async (): Promise<unknown[]> => world.reviewsAt(pr().head),
    reviewThreadsPage: async (): Promise<ReviewThreadPage> => ({ nodes: [], hasNextPage: false, endCursor: null }),
    timeline: async (): Promise<unknown[]> => [],
    checkRollupPage: async (): Promise<CheckRollupPage> => {
      throw new Error("not paginated in this fixture");
    },
    reviewRequestsPage: async (): Promise<ReviewRequestsPage> => {
      throw new Error("not paginated in this fixture");
    },
    fileAtRef: async (_repo: PrRef, path: string, ref: string): Promise<string | null> =>
      serve(`file:${path}@${ref}`, (): string | null => {
        if (path === GATES_FILE) return world.gatesAt(ref);
        if (path !== VERSION_FILE) return null;
        const raw = world.manifests[ref];
        if (raw !== undefined) return raw;
        const version = world.versions[ref];
        if (version === undefined) throw new Error(`HTTP 404: No commit found for SHA: ${ref}`);
        return version === null ? null : manifest(version);
      }),
    pullRequestFiles: async (_repo: PrRef, number: number): Promise<unknown[]> =>
      serve(`files:#${number}`, (): unknown[] => {
        const found = world.prs.find((entry): boolean => entry.number === number);
        if (found === undefined) throw new Error(`HTTP 404: no #${number}`);
        return found.files.map((filename): unknown => ({ filename, status: "modified" }));
      }),
    openPullRequestsPage: async (_repo: PrRef, page: number): Promise<unknown> =>
      serve(`pulls:${page}`, (): unknown =>
        world.prs.slice((page - 1) * 100, page * 100).map((entry): unknown => ({
          number: entry.number,
          draft: entry.draft === true,
          head: { sha: entry.head, ref: `feature/${entry.number}`, repo: { full_name: entry.fork === true ? `outsider/${NAME}` : SLUG } },
          base: { ref: entry.base, repo: { full_name: SLUG } },
        })),
      ),
    branchTip: async (_repo: PrRef, branch: string): Promise<string> =>
      serve(`tip:${branch}`, (): string => {
        const tip = world.branches[branch];
        if (tip === undefined) throw new Error(`HTTP 404: no branch ${branch}`);
        return tip;
      }),
    mergeBase: async (_repo: PrRef, base: string, head: string): Promise<string> =>
      serve(`compare:${base}...${head}`, (): string => {
        const found = world.mergeBases[`${base}...${head}`];
        if (found === undefined) throw new Error(`HTTP 404: no merge base for ${base}...${head}`);
        return found;
      }),
  };
  for (const name of options.omit ?? []) delete source[name];
  return source as unknown as WorldSource;
}

// ── the baseline repository ─────────────────────────────────────────────────

export const MAIN_OLD = sha("0a"); // the merge base every branch was cut from: 1.3.0
export const MAIN = sha("1b"); // main's live tip: still 1.3.0
export const SUBJECT_HEAD = sha("4c"); // #42's head: bumps to 1.4.0

/**
 * The baseline: main at 1.3.0; #42 (the subject, base main) changes
 * `claude/skills/x.md` and bumps to 1.4.0 from a 1.3.0 merge base. Nothing
 * else is open. Clear.
 */
export function baseline(gates: string, reviewsAt: (head: string) => unknown[]): CollisionWorld {
  return {
    defaultBranch: "main",
    branches: { main: MAIN },
    versions: { [MAIN_OLD]: "1.3.0", [MAIN]: "1.3.0", [SUBJECT_HEAD]: "1.4.0" },
    manifests: {},
    mergeBases: { [`main...${SUBJECT_HEAD}`]: MAIN_OLD },
    gatesAt: (): string | null => withOptIn(gates),
    reviewsAt,
    prs: [{ number: 42, head: SUBJECT_HEAD, base: "main", files: ["claude/skills/x.md", "changelog.d/x.md"] }],
  };
}

/** Add one same-repository peer proposing `version` from its own merge base on `base`. */
export function addPeer(
  world: CollisionWorld,
  number: number,
  version: string,
  options: { base?: string; mergeBaseVersion?: string; files?: string[]; draft?: boolean; fork?: boolean } = {},
): WorldPr {
  const head = sha(`${number.toString(16)}e`);
  const mergeBase = sha(`${number.toString(16)}f`);
  const base = options.base ?? "main";
  world.versions[head] = version;
  world.versions[mergeBase] = options.mergeBaseVersion ?? "1.3.0";
  world.mergeBases[`${base}...${head}`] = mergeBase;
  const entry: WorldPr = {
    number,
    head,
    base,
    files: options.files ?? [`claude/skills/${number}.md`],
    ...(options.draft === undefined ? {} : { draft: options.draft }),
    ...(options.fork === undefined ? {} : { fork: options.fork }),
  };
  world.prs.push(entry);
  return entry;
}
