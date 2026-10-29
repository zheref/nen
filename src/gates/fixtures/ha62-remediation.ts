// Literal historical inputs for NN216's HA62 replay, not a current PR-state fetch.
// NN214 quotes the 15:19 premerge verdict: row 4 owed Copilot, checks were green,
// all threads resolved and no R3 requested. Passing row 1 established MERGEABLE.
// GitHub now says MERGED (16:05:57); that later state cannot prove old readiness.
// Public reviews/checks corroborate the records below, all posted before 15:19.
// Review bodies are omitted; GraphQL reviews are flattened to the evaluator's
// author/state/commit_id/submitted_at shape. Human COMMENTED records are retained.
export const HA62_REMEDIATION = {
  provenance: {
    pullRequest: "https://github.com/zheref/hatsu/pull/62",
    reproduction: "https://github.com/zheref/nen/issues/214",
    evaluatedAt: "2026-09-14T15:19:00Z",
    policyAtBase: "https://github.com/zheref/hatsu/blob/41ef23fff07cd5ec40848b539038e605a1a9d495/nen/gates.json",
    reconstruction: "Premerge evaluator snapshot reconstructed from NN214's contemporaneous quoted verdict and HA62's public review/check records; not a saved complete transport response.",
    laterMergedAt: "2026-09-14T16:05:57Z",
    remediation: {
      parent: "9937635aef2f2db5618fefb7a9e677bbcc1b512c",
      commit: "554314cb9e463f4e5d7bae871330c48584667aca",
      files: 17,
      insertions: 88,
      deletions: 63,
      source: "https://github.com/zheref/hatsu/commit/554314cb9e463f4e5d7bae871330c48584667aca",
      description: "Real R2 fixes to En evidence refresh, coverage/declaration routing, checklist claims, descriptions and mirrors; no empty-change exemption.",
    },
  },
  // The historical file, including its lack of bounded_policy_exempt, quorum,
  // optional AI policy or approval requirements. Do not substitute BANKAI_REPO.
  gates: {
    version: 1,
    $comment: "Maintainer ruling 2026-09-12: Copilot supplies the sole automated review round. A separate APPROVED review is not required; the maintainer's human merge decision remains outside this automated readiness verdict.",
    reviewers: [{
      name: "copilot",
      login_pattern: { pattern: "^(copilot|copilot-pull-request-reviewer(\\[bot\\])?)$", ignoreCase: true },
    }],
    approval_policy: "review-round-only",
    default_approvers: [],
    base_reviewers: ["copilot"],
    delivery: {
      $comment: "Current local delivery branches use the Codex prefix and the maintainer credentials.",
      author_pattern: { pattern: "^zheref$", ignoreCase: true },
      head_ref_prefixes: ["codex/"],
      labels: [],
    },
  },
  state: {
    mergeable: "MERGEABLE",
    head_sha: "554314cb9e463f4e5d7bae871330c48584667aca",
    base_sha: "41ef23fff07cd5ec40848b539038e605a1a9d495",
    author: "zheref",
    // HA62's actual branch, not a synthetic codex/ delivery context.
    head_ref: "grok/kurapika/mukai-impacted-regression",
    base_ref: "main",
    default_branch: "main",
    labels: [],
    reviews: [
      { author: "copilot-pull-request-reviewer", state: "COMMENTED", commit_id: "c5f453b143796728aa5404ec3ffb929fec5e9562", submitted_at: "2026-09-14T14:57:36Z" },
      { author: "copilot-pull-request-reviewer", state: "COMMENTED", commit_id: "9937635aef2f2db5618fefb7a9e677bbcc1b512c", submitted_at: "2026-09-14T15:12:05Z" },
      { author: "zheref", state: "COMMENTED", commit_id: "554314cb9e463f4e5d7bae871330c48584667aca", submitted_at: "2026-09-14T15:18:24Z" },
      { author: "zheref", state: "COMMENTED", commit_id: "554314cb9e463f4e5d7bae871330c48584667aca", submitted_at: "2026-09-14T15:18:26Z" },
      { author: "zheref", state: "COMMENTED", commit_id: "554314cb9e463f4e5d7bae871330c48584667aca", submitted_at: "2026-09-14T15:18:27Z" },
      { author: "zheref", state: "COMMENTED", commit_id: "554314cb9e463f4e5d7bae871330c48584667aca", submitted_at: "2026-09-14T15:18:29Z" },
    ],
    checks: [
      { __typename: "CheckRun", name: "check", workflowName: "plugin-bump-check", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-14T15:18:13Z", completedAt: "2026-09-14T15:18:26Z", detailsUrl: "https://github.com/zheref/hatsu/actions/runs/34861261818/job/104033775992" },
      { __typename: "CheckRun", name: "surface-mirror-check", workflowName: "surface-mirror-check", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-14T15:18:13Z", completedAt: "2026-09-14T15:18:24Z", detailsUrl: "https://github.com/zheref/hatsu/actions/runs/34861261831/job/104033776234" },
      { __typename: "CheckRun", name: "check", workflowName: "plugin-bump-check", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-14T15:18:15Z", completedAt: "2026-09-14T15:18:22Z", detailsUrl: "https://github.com/zheref/hatsu/runs/104033808438" },
      { __typename: "CheckRun", name: "surface-mirror-check", workflowName: "plugin-bump-check", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-14T15:18:14Z", completedAt: "2026-09-14T15:18:21Z", detailsUrl: "https://github.com/zheref/hatsu/runs/104033801693" },
    ],
    review_requests: [],
    unresolved_threads: 0,
  },
} as const;
