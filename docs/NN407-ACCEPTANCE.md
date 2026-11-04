# NN407 acceptance map

This delivery preserves current main behavior while adapting the recovered
process implementation. Its base is the independently delivered canon batch
[NN623](https://github.com/zheref/nen/pull/623), not the older host-admission PR.
Each requested item is accounted for below. Fixtures were run freshly for this
delivery; their results are in the delivery PR, rather than inferred from their
presence. No merge, release, consumer repin or richer consumer-guard retirement
is claimed.

| Item | Result | Fixture / evidence |
|---|---|---|
| 1 | Opt-out phrases in HTML comments and fences do not suppress fragments. | `src/changelog/fragment.test.ts` |
| 2 | `commit format --body-file` uses existing wrapping/policy and refuses competing sources. | `src/commit/command.test.ts` |
| 3 | Preserves main's checked `issue file --title-file`; conflicting sources refuse before filing. | `src/issue/command.test.ts` |
| 4 | `shu test --lanes` preflights all explicit lanes and emits one aggregate result, including later-lane failures/refusals. Execution is derived from step evidence, not invocation intent. | `src/shu/command.test.ts`, including dependency loss between preview and execution |
| 5 | `report render --out -` supplies the expressly permitted stdout alternative; outside-root file writes remain refused. | `src/report/render.test.ts` |
| 6 | Explicit HTML/Markdown escaping, default HTML retained. | `src/report/render.test.ts` |
| 7 | One surface-generation plan preflights all rows and ownership before any write; hook-root literals/expressions retained. | `src/surface/command.test.ts` |
| 8 | Nen checks a caller-trusted bootstrap script digest before Bash. Hatsu renderer/template wiring is delivered in companion [HA554](https://github.com/zheref/hatsu/pull/554), using the same trusted pin, script hash and Linux binary hash. | `src/supply/bootstrap.test.ts`; companion renderer self-test 255 assertions and seven bootstrap behavior cases; consumer release/adoption remains explicit |
| 9 | Caller-proven settled stacked PR handover checks matching bases; current repository-specific merged/stacked policies remain available. | `src/loop/slots.test.ts` |
| 10 | Only the exact owner-config ignore default is considered, from an absolute HOME/USERPROFILE; explicit paths replace it and all existing privacy guards remain. | `src/issue/command.test.ts` |
| 11 | New optional declared agent-spec metadata read, selected as `report data --agents-dir claude/agents/`; no implicit scan or contents publication. Legacy output is unchanged without the flag. | `src/report/agents.test.ts` (nested path, legacy sibling exclusion, links, empty public argument) |
| 12 | Withdrawn by the maintainer's 2026-10-17 issue comment; no refusal class is introduced. | [Authoritative withdrawal](https://github.com/zheref/nen/issues/407#issuecomment-6242840790); existing three decision classes retained |
| 13 | Phase-aware jobs must name phases; optional independent inventory/registry proves document-phase coverage and rejects foreign phases. Canon check supplies the independent registry. | `src/classify/taxonomy.test.ts`, `src/classify/command.test.ts`, `src/canon/check.test.ts` |
| 14 | `report check` owns the requested declared-variant render/token/block/order/desk-star/visible-escape checks, with distinct wiring failures. It uses the actual renderer, rejects duplicate/undeclared HTML sections and variant mismatch. | `src/report/check.test.ts`; NN406's richer Hatsu guard/adoption remains separately open, not weakened or retired here |
| 15 | Preserves main's absent-anchor and target release-level handling; coalesces repeated fragment `###` subsections in fixed order (Added, Changed, Fixed, Removed, Deprecated, Security, Breaking / consumer notes, then unknown headings alphabetically). Fenced examples and meaningful indentation remain content. | `src/changelog/collate.test.ts` |
| 16 | Permission-only mirror drift is separate from hand-edited bytes and can be repaired without rewriting bytes. | `src/surface/mirror.test.ts` |
| 17 | Existing scenario resolver already reads maintained-tool `scenario` and names that exact missing key; Hatsu's maintained-tools row now declares `bankai-machinery`. No second resolver is added. | `src/repo/scenario.test.ts`; current Hatsu `nen/repos.json`; NN569 path/manifest work is in base NN623 |
| 18 | `wc publish --gated` checks catch-up/no-op, proved object, same-name upstream, ordered iteration checks, outgoing attribution, re-read and non-force push. No first publish or force route. | `src/wc/gated.integration.test.ts`, including HEAD races and exact-base-merge attribution |
| 19 | `canon check` composes registry validity, independent phase coverage and bidirectional dry-run label parity. | `src/canon/check.test.ts` |
| 20 | `tag announce` reads exactly two bounded CR-stripped identity lines, distinguishes no declaration, declaration fault and wiring, and mutates no tag. | `src/tag/announce.test.ts` |

Every row also has a release-fragment line, including the withdrawal and the
existing-declaration reconciliation. HA554 must be reviewed and adopted with
this release to complete item 8's cross-repository wiring; Nen does not claim a
consumer has already repinned a binary that is not released yet.
