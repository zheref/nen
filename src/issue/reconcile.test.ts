import { describe, expect, it } from "vitest";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import {
  closingReferencesIn,
  compareArgv,
  defaultBranchArgv,
  mergedPullsArgv,
  openIssuesArgv,
  parseMergedPulls,
  reconcile,
  renderReconcile,
  stripNonReferenceText,
  RECONCILE_CONTRACT,
  MERGED_PULLS_QUERY,
  deliveryArgv,
  prCommitsArgv,
  repositoryLabelsArgv,
  type ReconcileOptions,
} from "./reconcile.js";

const TARGET: Target = { owner: "acme", repo: "widgets", slug: "acme/widgets" };
const OPTIONS: ReconcileOptions = { since: null, limit: 100, issues: null, holdLabels: [] };
const MAIN_SHA = "a".repeat(40);
const SIDE_SHA = "b".repeat(40);

function gh(argv: readonly string[]): string {
  return ["gh", ...argv].join(" ");
}

function issue(number: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { number, title: `issue ${number}`, url: `https://github.com/acme/widgets/issues/${number}`, labels: [], stateReason: "", ...extra };
}

function pull(number: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: `pr ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    baseRefName: "trunk",
    mergedAt: "2026-10-01T00:00:00Z",
    mergeCommit: { oid: MAIN_SHA },
    body: "",
    closingIssuesReferences: [],
    commits: [],
    ...extra,
  };
}

function linked(number: number, owner = "acme", name = "widgets"): Record<string, unknown> {
  return { number, url: `https://github.com/${owner}/${name}/issues/${number}`, repository: { name, owner: { login: owner } } };
}

/** A gh-list-shaped pull request, as the GraphQL search returns it. */
function node(row: Record<string, unknown>): Record<string, unknown> {
  const links = (row["closingIssuesReferences"] as unknown[] | undefined) ?? [];
  const commits = (row["commits"] as unknown[] | undefined) ?? [];
  return {
    ...row,
    closingIssuesReferences: { totalCount: links.length, nodes: links },
    commits: { totalCount: commits.length, nodes: commits.map((commit): unknown => ({ commit })) },
  };
}

function page(rows: readonly Record<string, unknown>[], next: string | null = null, issueCount?: number): ScriptedCall["result"] {
  return {
    stdout: JSON.stringify({
      data: { search: { ...(issueCount === undefined ? {} : { issueCount }), pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes: rows.map(node) } },
    }),
  };
}

interface World {
  readonly defaultBranch?: ScriptedCall["result"];
  readonly issues?: readonly Record<string, unknown>[] | ScriptedCall["result"];
  readonly pulls?: readonly Record<string, unknown>[] | ScriptedCall["result"];
  readonly openPulls?: readonly Record<string, unknown>[] | ScriptedCall["result"];
  readonly compares?: Readonly<Record<string, ScriptedCall["result"]>>;
  readonly options?: ReconcileOptions;
  readonly nextCursor?: string;
  readonly issueCount?: number;
  readonly extraPages?: readonly ScriptedCall[];
  /** `head -> result` for the delivery-PR lookup a diverged compare triggers. */
  readonly deliveries?: Readonly<Record<string, ScriptedCall["result"]>>;
  /** The repository's label list, read only when --hold-labels is given. */
  readonly repoLabels?: ScriptedCall["result"];
}

function asResult(value: readonly Record<string, unknown>[] | ScriptedCall["result"] | undefined): ScriptedCall["result"] {
  if (value === undefined) return { stdout: "[]" };
  return Array.isArray(value) ? { stdout: JSON.stringify(value) } : (value as ScriptedCall["result"]);
}

function run(world: World): { report: ReturnType<typeof reconcile>; calls: readonly string[] } {
  const options = world.options ?? OPTIONS;
  const script: ScriptedCall[] = [
    { match: gh(defaultBranchArgv(TARGET)), result: world.defaultBranch ?? { stdout: JSON.stringify({ defaultBranchRef: { name: "trunk" } }) } },
    { match: gh(openIssuesArgv(TARGET, options.limit)), result: asResult(world.issues) },
    ...(Array.isArray(world.pulls) || world.pulls === undefined
      ? [{ match: gh(mergedPullsArgv(TARGET, Math.min(100, options.limit), options.since, null)), result: page((world.pulls as Record<string, unknown>[] | undefined) ?? [], world.nextCursor ?? null, world.issueCount) }]
      : [{ match: gh(mergedPullsArgv(TARGET, Math.min(100, options.limit), options.since, null)), result: world.pulls as ScriptedCall["result"] }]),
    ...(world.extraPages ?? []),
    {
      match: "gh pr list --repo acme/widgets --state open --limit 100 --json number,title,url,isDraft,body,closingIssuesReferences",
      result: asResult(world.openPulls),
    },
    ...Object.entries(world.compares ?? {}).map(([sha, result]): ScriptedCall => ({ match: gh(compareArgv(TARGET, "trunk", sha)), result })),
    { match: gh(repositoryLabelsArgv(TARGET)), result: world.repoLabels ?? { stdout: "keep-open\nbug\n" } },
    ...Object.entries(world.deliveries ?? {}).map(([head, result]): ScriptedCall => ({ match: gh(deliveryArgv(TARGET, head, "trunk")), result })),
  ];
  const seams = new ScriptedSeams(script);
  const report = reconcile(seams, TARGET, options);
  return { report, calls: seams.calls.map((call): string => [call.command, ...call.args].join(" ")) };
}

/**
 * Every call is a read: a `list`/`view`, a `gh api` GET with no method or field
 * flag, or a GraphQL QUERY -- `gh api graphql` whose document holds no mutation.
 */
function isRead(call: string): boolean {
  if (/^gh (issue|pr) list /.test(call) || /^gh repo view /.test(call)) return true;
  if (/^gh api graphql /.test(call)) return /query=query\(/.test(call) && !/\bmutation\b/.test(call) && !/\s(-X|--method|--input)\b/.test(call);
  return /^gh api /.test(call) && !/\s(-X|--method|-f|-F|--field|--raw-field|--input)\b/.test(call);
}

describe("closing references -- GitHub's keyword grammar, nothing looser", () => {
  it("reads every keyword form, with or without a colon, and three reference spellings", () => {
    const text = [
      "Closes #1",
      "fixes: #2",
      "Resolved acme/widgets#3",
      "close https://github.com/acme/widgets/issues/4",
      "FIXED #5",
      "resolves #6",
    ].join("\n");
    expect(closingReferencesIn(text, TARGET).map(([n]): number => n)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps the reference exactly as written, for the report to cite", () => {
    expect(closingReferencesIn("This Closes: #12 at last.", TARGET)).toEqual([[12, "Closes: #12"]]);
  });

  it("never reads a mention, 'Part of', or a keyword inside a longer word", () => {
    expect(closingReferencesIn("see #1. Part of #2. Refs #3. disclose #4. prefixes #5", TARGET)).toEqual([]);
  });

  it("binds one keyword to one reference: 'Closes #1, #2' closes only #1, as on GitHub", () => {
    expect(closingReferencesIn("Closes #1, #2", TARGET).map(([n]): number => n)).toEqual([1]);
  });

  it("drops a reference to a different repository, case-insensitively matching this one", () => {
    expect(closingReferencesIn("Closes other/repo#7 and fixes ACME/Widgets#8", TARGET).map(([n]): number => n)).toEqual([8]);
  });

  it("does not read fenced code, inline code, indented code or HTML comments", () => {
    const text = [
      "<!-- Closes #1 -->",
      "```",
      "fixes #2",
      "```",
      "write `Closes #3` like this",
      "and ``Closes `#5` too`` in a double-backtick span",
      "",
      "    Fixes #6",
      "    closes #7",
      "",
      "Resolves #4",
    ].join("\n");
    expect(stripNonReferenceText(text)).not.toMatch(/#1|#2|#3|#5|#6|#7/);
    expect(closingReferencesIn(text, TARGET).map(([n]): number => n)).toEqual([4]);
  });

  it("keeps a four-space continuation line that follows a paragraph line -- it is not code", () => {
    expect(closingReferencesIn("A paragraph that wraps\n    and Closes #8 here", TARGET).map(([n]): number => n)).toEqual([8]);
  });
});

describe("parseMergedPulls -- three sources of closing reference, each cited", () => {
  it("collects linked, body and commit references per issue, same repository only", () => {
    const [parsed] = parseMergedPulls(
      JSON.stringify([
        pull(40, {
          closingIssuesReferences: [linked(11), linked(99, "other", "repo")],
          body: "Fixes #12",
          commits: [{ oid: "c".repeat(40), messageHeadline: "feat: thing", messageBody: "Closes: #13\n\nHatsu-Agent: x" }],
        }),
      ]),
      TARGET,
    );
    expect([...(parsed?.references.keys() ?? [])]).toEqual([11, 12, 13]);
    expect(parsed?.references.get(11)).toEqual([{ source: "linked", text: "https://github.com/acme/widgets/issues/11", commit: null }]);
    expect(parsed?.references.get(12)).toEqual([{ source: "body", text: "Fixes #12", commit: null }]);
    expect(parsed?.references.get(13)).toEqual([{ source: "commit", text: "Closes: #13", commit: "c".repeat(40) }]);
    expect(parsed?.mergeCommit).toBe(MAIN_SHA);
  });
});

describe("reconcile -- proposals bound to landed evidence", () => {
  it("proposes close for an open issue a PR merged into the default branch closes, citing PR, commit and reference", () => {
    const { report } = run({ issues: [issue(5), issue(6)], pulls: [pull(40, { body: "Closes #5" })] });
    expect(report.contract).toBe(RECONCILE_CONTRACT);
    expect(report.proposesOnly).toBe(true);
    expect(report.complete).toBe(true);
    expect(report.proposals).toHaveLength(1);
    const [proposal] = report.proposals;
    expect(proposal?.issue).toBe(5);
    expect(proposal?.action).toBe("close");
    expect(proposal?.evidence[0]).toMatchObject({ pr: 40, mergeCommit: MAIN_SHA, landing: "default-branch", base: "trunk" });
    expect(proposal?.evidence[0]?.references).toEqual([{ source: "body", text: "Closes #5", commit: null }]);
  });

  it("never proposes on a title that matches, or on a bare mention", () => {
    const { report } = run({
      issues: [issue(5, { title: "Add the widget exporter" })],
      pulls: [pull(40, { title: "Add the widget exporter", body: "Related to #5, see #5." })],
    });
    expect(report.proposals).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it("ignores a reference to an issue that is not open", () => {
    const { report } = run({ issues: [issue(5)], pulls: [pull(40, { body: "Closes #77" })] });
    expect(report.proposals).toEqual([]);
  });

  it("checks a non-default base with the compare API: reached -> close, not reached -> wait", () => {
    const { report, calls } = run({
      issues: [issue(5), issue(6)],
      pulls: [
        pull(40, { baseRefName: "epic/one", mergeCommit: { oid: MAIN_SHA }, body: "Closes #5" }),
        pull(41, { baseRefName: "epic/two", mergeCommit: { oid: SIDE_SHA }, body: "Closes #6" }),
      ],
      compares: { [MAIN_SHA]: { stdout: "behind\n" }, [SIDE_SHA]: { stdout: "ahead\n" } },
    });
    expect(calls).toContain(gh(compareArgv(TARGET, "trunk", MAIN_SHA)));
    expect(report.proposals.map((p): [number, string, string] => [p.issue, p.action, p.evidence[0]?.landing ?? ""])).toEqual([
      [5, "close", "reached-default-branch"],
      [6, "wait", "not-on-default-branch"],
    ]);
  });

  it("holds an issue carrying a caller-named hold label, whatever its evidence -- no label is built in", () => {
    const issues = [issue(5, { labels: [{ name: "keep-open" }] })];
    const pulls = [pull(40, { body: "Closes #5" })];
    expect(run({ issues, pulls }).report.proposals[0]?.action).toBe("close");
    const held = run({ issues, pulls, options: { ...OPTIONS, holdLabels: ["keep-open"] } }).report.proposals[0];
    expect(held?.action).toBe("hold");
    expect(held?.reason).toMatch(/'keep-open'/);
  });

  it("proposes review, not close, for an issue a human reopened", () => {
    const { report } = run({ issues: [issue(5, { stateReason: "REOPENED" })], pulls: [pull(40, { body: "Closes #5" })] });
    expect(report.proposals[0]?.action).toBe("review");
  });

  it("proposes review when an open PR still closes or mentions the issue (the open-pr-check guard)", () => {
    const { report } = run({
      issues: [issue(5)],
      pulls: [pull(40, { body: "Closes #5" })],
      openPulls: [{ number: 50, title: "more", url: "u", isDraft: true, body: "follow-up for #5", closingIssuesReferences: [] }],
    });
    expect(report.proposals[0]?.action).toBe("review");
    expect(report.proposals[0]?.openPullRequests).toEqual([50]);
  });

  it("gathers every PR that closes one issue into a single proposal", () => {
    const { report } = run({
      issues: [issue(5)],
      pulls: [pull(41, { body: "Fixes #5" }), pull(40, { closingIssuesReferences: [linked(5)] })],
    });
    expect(report.proposals).toHaveLength(1);
    expect(report.proposals[0]?.evidence.map((e): number => e.pr)).toEqual([41, 40]);
  });

  it("restricts to --issues and names the entries that are not open", () => {
    const { report } = run({
      issues: [issue(5), issue(6)],
      pulls: [pull(40, { body: "Closes #5\nCloses #6" })],
      options: { ...OPTIONS, issues: [6, 9] },
    });
    expect(report.proposals.map((p): number => p.issue)).toEqual([6]);
    expect(report.notOpen).toEqual([9]);
  });

  it("passes --since to the merged-PR search as merged:>=, and pages by cursor", () => {
    expect(mergedPullsArgv(TARGET, 100, "2026-09-01", null)).toContain("q=repo:acme/widgets is:pr is:merged merged:>=2026-09-01 sort:updated-desc");
    expect(mergedPullsArgv(TARGET, 100, null, null)).toContain("q=repo:acme/widgets is:pr is:merged sort:updated-desc");
    expect(mergedPullsArgv(TARGET, 7, null, "CUR")).toEqual(expect.arrayContaining(["first=7", "after=CUR"]));
  });

  it("selects commit oid and message only -- never the authors connection that blew GitHub's node budget", () => {
    expect(MERGED_PULLS_QUERY).toMatch(/commit \{ oid messageHeadline messageBody \}/);
    expect(MERGED_PULLS_QUERY).not.toMatch(/authors/);
    expect(MERGED_PULLS_QUERY).not.toMatch(/mutation/);
  });

  it("follows the cursor across pages until the search is exhausted", () => {
    const { report, calls } = run({
      issues: [issue(5), issue(6)],
      pulls: [pull(40, { body: "Closes #5" })],
      nextCursor: "P2",
      extraPages: [{ match: gh(mergedPullsArgv(TARGET, 99, null, "P2")), result: page([pull(41, { body: "Fixes #6" })]) }],
    });
    expect(calls).toContain(gh(mergedPullsArgv(TARGET, 99, null, "P2")));
    expect(report.scanned.mergedPullRequests).toBe(2);
    expect(report.proposals.map((p): number => p.issue)).toEqual([5, 6]);
    expect(report.complete).toBe(true);
  });

  it("makes only reads -- never a close, a comment or a label", () => {
    const { calls } = run({
      issues: [issue(5), issue(6)],
      pulls: [pull(40, { body: "Closes #5" }), pull(41, { baseRefName: "epic/x", mergeCommit: { oid: SIDE_SHA }, body: "Closes #6" })],
      compares: { [SIDE_SHA]: { stdout: "ahead" } },
    });
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.filter((call): boolean => !isRead(call))).toEqual([]);
  });
});

describe("reconcile -- an unreadable source is a finding, never a clean answer", () => {
  it("a failed open-issue read is a finding and the report is incomplete", () => {
    const { report } = run({ issues: { code: 1, stderr: "HTTP 502" }, pulls: [pull(40, { body: "Closes #5" })] });
    expect(report.complete).toBe(false);
    expect(report.proposals).toEqual([]);
    expect(report.findings).toEqual([{ source: "open-issues", detail: expect.stringMatching(/HTTP 502/) }]);
    expect(renderReconcile(report).join("\n")).toMatch(/INCOMPLETE .* NOT 'nothing to reconcile'/);
  });

  it("a failed merged-PR read is a finding", () => {
    const { report } = run({ issues: [issue(5)], pulls: { code: 1, stderr: "rate limited" } });
    expect(report.complete).toBe(false);
    expect(report.findings[0]?.source).toBe("merged-pull-requests");
  });

  it("a PR with more commits than were read is a finding, never a silent cut", () => {
    const row = node(pull(40));
    (row["commits"] as Record<string, unknown>)["totalCount"] = 150;
    const { report } = run({
      issues: [issue(5)],
      pulls: { stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [row] } } }) },
    });
    expect(report.complete).toBe(false);
    expect(report.findings[0]?.detail).toMatch(/PR #40 has 150 commits; only 0 were read/);
  });

  it("a GraphQL error answer is a finding, not an empty page", () => {
    const { report } = run({ issues: [issue(5)], pulls: { stdout: JSON.stringify({ errors: [{ message: "exceeds the maximum limit of 500,000" }] }) } });
    expect(report.complete).toBe(false);
    expect(report.findings[0]?.detail).toMatch(/500,000/);
  });

  it("unparseable JSON is a finding, not an empty list", () => {
    const { report } = run({ issues: { stdout: "{not json" } });
    expect(report.findings[0]?.source).toBe("open-issues");
  });

  it("a search that reached --limit with more left is a finding: it may have stopped before the PR that matters", () => {
    const options = { ...OPTIONS, limit: 2 };
    const { report } = run({ issues: [issue(5)], pulls: [pull(40), pull(41)], nextCursor: "MORE", options });
    expect(report.truncated.mergedPullRequests).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.findings[0]?.detail).toMatch(/narrow --since or raise --limit/);
  });

  it("a truncated open list names no entry 'not open'", () => {
    const options = { ...OPTIONS, limit: 1, issues: [9] };
    const { report } = run({ issues: [issue(5)], options });
    expect(report.notOpen).toEqual([]);
    expect(report.findings.map((f): string => f.source)).toContain("open-issues");
  });

  it("an unreadable default branch makes every landing unknown and proposes verify, not close", () => {
    const { report } = run({ defaultBranch: { code: 1, stderr: "not found" }, issues: [issue(5)], pulls: [pull(40, { body: "Closes #5" })] });
    expect(report.defaultBranch).toBeNull();
    expect(report.proposals[0]?.action).toBe("verify");
    expect(report.findings[0]?.source).toBe("default-branch");
  });

  it("a failed compare is a finding and the proposal is verify", () => {
    const { report } = run({
      issues: [issue(5)],
      pulls: [pull(40, { baseRefName: "epic/x", mergeCommit: { oid: SIDE_SHA }, body: "Closes #5" })],
      compares: { [SIDE_SHA]: { code: 1, stderr: "No common ancestor" } },
    });
    expect(report.proposals[0]?.action).toBe("verify");
    expect(report.findings[0]?.source).toBe("compare #40");
  });

  it("a failed open-PR guard downgrades close to verify and is a finding", () => {
    const { report } = run({ issues: [issue(5)], pulls: [pull(40, { body: "Closes #5" })], openPulls: { code: 1, stderr: "boom" } });
    expect(report.proposals[0]?.action).toBe("verify");
    expect(report.findings[0]?.source).toBe("open-pr-guard");
  });

  it("a complete scan with nothing to propose says so plainly", () => {
    const { report } = run({ issues: [issue(5)], pulls: [pull(40)] });
    expect(report.complete).toBe(true);
    expect(renderReconcile(report).join("\n")).toMatch(/no proposals: no open issue is closed/);
  });
});

describe("renderReconcile -- the same report in lines", () => {
  it("says it proposes only, and cites the action, PR, commit and reference", () => {
    const { report } = run({ issues: [issue(5)], pulls: [pull(40, { body: "Closes #5" })] });
    const text = renderReconcile(report).join("\n");
    expect(text).toMatch(/proposes only -- nothing was closed, commented on or labelled/);
    expect(text).toMatch(/#5 issue 5\n {2}propose: close -- PR #40 merged into 'trunk', the default branch/);
    expect(text).toMatch(/evidence: PR #40 \(default-branch, base trunk, merge commit aaaaaaaaaaaa/);
    expect(text).toMatch(/'Closes #5' in the PR body/);
  });
});

describe("round 1 (Nobunaga) on the delivery of #332", () => {
  it("N1: a last page with hasNextPage false but issueCount above the rows read is truncated -- GitHub search stops at 1000", () => {
    const { report } = run({ issues: [issue(5)], pulls: [pull(40), pull(41)], issueCount: 4000 });
    expect(report.truncated.mergedPullRequests).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.findings.map((f): string => f.source)).toEqual(["merged-pull-requests"]);
    expect(report.findings[0]?.detail).toMatch(/matched more than the 2 read .*stops at 1000/);
  });

  it("N1: the limit is checked before hasNextPage -- no page past --limit is asked for", () => {
    const { report, calls } = run({ issues: [issue(5)], pulls: [pull(40), pull(41)], nextCursor: "MORE", issueCount: 2, options: { ...OPTIONS, limit: 2 } });
    expect(calls.filter((call): boolean => call.startsWith("gh api graphql"))).toHaveLength(1);
    expect(report.truncated.mergedPullRequests).toBe(true);
  });

  it("N1: issueCount equal to the rows read is complete", () => {
    const { report } = run({ issues: [issue(5)], pulls: [pull(40), pull(41)], issueCount: 2 });
    expect(report.complete).toBe(true);
  });

  it("N2: an ESC sequence in a title, base or gh error never reaches the terminal; --json keeps the bytes", () => {
    const { report } = run({
      issues: [issue(5, { title: "evil \u001b[2Ktitle" })],
      pulls: [pull(40, { body: "Closes #5" })],
      openPulls: { code: 1, stderr: "boom \u001b[1A up" },
    });
    expect(report.proposals[0]?.title).toBe("evil \u001b[2Ktitle");
    const text = renderReconcile(report).join("\n");
    expect(text).not.toMatch(/\u001b/);
    expect(text).toMatch(/evil \[2Ktitle/);
    expect(text).toMatch(/boom \[1A up/);
  });

  it("N3: hold labels match case-insensitively", () => {
    const { report } = run({
      issues: [issue(5, { labels: [{ name: "Keep-Open" }] })],
      pulls: [pull(40, { body: "Closes #5" })],
      options: { ...OPTIONS, holdLabels: ["keep-open"] },
    });
    expect(report.proposals[0]?.action).toBe("hold");
    expect(report.complete).toBe(true);
  });

  it("N3: a hold label that matches no label in the REPOSITORY is a finding, never a silent 'nothing held'", () => {
    const { report, calls } = run({
      issues: [issue(5, { labels: [{ name: "keep-open" }] })],
      pulls: [pull(40, { body: "Closes #5" })],
      options: { ...OPTIONS, holdLabels: ["kep-open"] },
    });
    expect(calls).toContain(gh(repositoryLabelsArgv(TARGET)));
    expect(report.complete).toBe(false);
    expect(report.findings).toEqual([{ source: "hold-labels", detail: expect.stringMatching(/'kep-open' matches no label in acme\/widgets/) }]);
    expect(report.proposals[0]?.action).toBe("close");
  });

  it("N3: a hold label that exists in the repository but is on no open issue is fine and silent", () => {
    const { report } = run({
      issues: [issue(5)],
      pulls: [pull(40, { body: "Closes #5" })],
      options: { ...OPTIONS, holdLabels: ["KEEP-OPEN"] },
      repoLabels: { stdout: "Keep-Open\n" },
    });
    expect(report.complete).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.proposals[0]?.action).toBe("close");
  });

  it("N3: an unreadable or empty label list is a finding", () => {
    const options = { ...OPTIONS, holdLabels: ["keep-open"] };
    const failed = run({ issues: [issue(5)], options, repoLabels: { code: 1, stderr: "HTTP 403" } }).report;
    expect(failed.complete).toBe(false);
    expect(failed.findings[0]?.detail).toMatch(/could not read acme\/widgets's labels.*HTTP 403/);
    const empty = run({ issues: [issue(5)], options, repoLabels: { stdout: "" } }).report;
    expect(empty.findings[0]?.detail).toMatch(/empty label list/);
  });

  it("N3: no --hold-labels means the label list is never read", () => {
    const { calls } = run({ issues: [issue(5)], pulls: [pull(40, { body: "Closes #5" })] });
    expect(calls).not.toContain(gh(repositoryLabelsArgv(TARGET)));
  });

  it("N4: diverged with a merged delivery PR from the base proposes verify, citing it", () => {
    const { report, calls } = run({
      issues: [issue(5)],
      pulls: [pull(40, { baseRefName: "epic/x", mergeCommit: { oid: SIDE_SHA }, body: "Closes #5" })],
      compares: { [SIDE_SHA]: { stdout: "diverged" } },
      deliveries: { "epic/x": { stdout: JSON.stringify([{ number: 77, url: "u77", mergedAt: "2026-10-02T00:00:00Z" }]) } },
    });
    expect(calls).toContain(gh(deliveryArgv(TARGET, "epic/x", "trunk")));
    const proposal = report.proposals[0];
    expect(proposal?.action).toBe("verify");
    expect(proposal?.evidence[0]).toMatchObject({ landing: "diverged", delivery: { pr: 77, url: "u77", mergedAt: "2026-10-02T00:00:00Z" } });
    expect(proposal?.reason).toMatch(/PR #77 merged 'epic\/x' into 'trunk'/);
    expect(proposal?.reason).not.toMatch(/has NOT reached/);
    expect(report.complete).toBe(true);
  });

  it("N4: diverged with no delivery PR proposes wait, worded 'not reachable', never 'has NOT reached'", () => {
    const { report } = run({
      issues: [issue(5)],
      pulls: [pull(40, { baseRefName: "epic/x", mergeCommit: { oid: SIDE_SHA }, body: "Closes #5" })],
      compares: { [SIDE_SHA]: { stdout: "diverged" } },
      deliveries: { "epic/x": { stdout: "[]" } },
    });
    const proposal = report.proposals[0];
    expect(proposal?.action).toBe("wait");
    expect(proposal?.evidence[0]?.delivery).toBeNull();
    expect(proposal?.reason).toMatch(/not reachable from 'trunk' \(a squash or rebase landing reads the same way\)/);
    expect(proposal?.reason).not.toMatch(/has NOT reached/);
  });

  it("N4: a failed delivery lookup is a finding and the proposal is verify", () => {
    const { report } = run({
      issues: [issue(5)],
      pulls: [pull(40, { baseRefName: "epic/x", mergeCommit: { oid: SIDE_SHA }, body: "Closes #5" })],
      compares: { [SIDE_SHA]: { stdout: "diverged" } },
      deliveries: { "epic/x": { code: 1, stderr: "HTTP 500" } },
    });
    expect(report.proposals[0]?.action).toBe("verify");
    expect(report.findings[0]?.source).toBe("delivery epic/x");
  });

  it("N5: a PR seen on two pages is read once", () => {
    const { report } = run({
      issues: [issue(5)],
      pulls: [pull(40, { body: "Closes #5" })],
      nextCursor: "P2",
      extraPages: [{ match: gh(mergedPullsArgv(TARGET, 99, null, "P2")), result: page([pull(40, { body: "Closes #5" }), pull(41)]) }],
    });
    expect(report.scanned.mergedPullRequests).toBe(2);
    expect(report.proposals[0]?.evidence.map((e): number => e.pr)).toEqual([40]);
  });

  it("N5: evidence is sorted by mergedAt newest first, then PR number, whatever the search order", () => {
    const { report } = run({
      issues: [issue(5)],
      pulls: [
        pull(40, { mergedAt: "2026-09-01T00:00:00Z", body: "Closes #5" }),
        pull(42, { mergedAt: "2026-09-20T00:00:00Z", body: "Fixes #5" }),
        pull(41, { mergedAt: "2026-09-20T00:00:00Z", body: "Resolves #5" }),
      ],
    });
    expect(report.proposals[0]?.evidence.map((e): number => e.pr)).toEqual([42, 41, 40]);
  });

  function overflowing(): Record<string, unknown> {
    const row = node(pull(40));
    row["commits"] = { totalCount: 101, pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: [] };
    return row;
  }

  function searchAnswer(rows: readonly Record<string, unknown>[]): ScriptedCall["result"] {
    return { stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: rows } } }) };
  }

  it("N8: commits past the first 100 are paged by a per-PR follow-up, and a reference there counts", () => {
    const { report, calls } = run({
      issues: [issue(5)],
      pulls: searchAnswer([overflowing()]),
      extraPages: [
        {
          match: gh(prCommitsArgv(TARGET, 40, "C1")),
          result: {
            stdout: JSON.stringify({
              data: { repository: { pullRequest: { commits: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ commit: { oid: "d".repeat(40), messageHeadline: "fix: last", messageBody: "Closes: #5" } }] } } } },
            }),
          },
        },
      ],
    });
    expect(calls).toContain(gh(prCommitsArgv(TARGET, 40, "C1")));
    expect(report.complete).toBe(true);
    expect(report.proposals[0]?.evidence[0]?.references).toEqual([{ source: "commit", text: "Closes: #5", commit: "d".repeat(40) }]);
  });

  it("N8: a failed follow-up keeps the finding", () => {
    const { report } = run({
      issues: [issue(5)],
      pulls: searchAnswer([overflowing()]),
      extraPages: [{ match: gh(prCommitsArgv(TARGET, 40, "C1")), result: { code: 1, stderr: "HTTP 502" } }],
    });
    expect(report.complete).toBe(false);
    expect(report.findings[0]?.detail).toMatch(/PR #40 has 101 commits; only 0 were read: HTTP 502/);
  });
});
