// src/issue/subissue.ts -- sub-issue attachment and the consolidation close,
// in the one order that is safe.
//
// THE ORDER IS THE FEATURE. `file -> attach -> close`, stated as a rule because
// the alternative has a name: "a close comment that points at an issue that does
// not exist yet is a dead reference, and a failure halfway through leaves the
// backlog in a state nobody planned". So this module runs the steps in that
// order and STOPS at the first failure, rather than continuing to the closes on
// the assumption that the attachments probably worked.
//
// THE API TAKES AN ID, NOT A NUMBER, and that is the single most common way this
// choreography breaks. `POST /repos/{owner}/{repo}/issues/{n}/sub_issues` wants
// the child's internal `id`; the number in the URL bar is the child's
// `number`. Posting the number succeeds for whichever issue happens to carry
// that id -- a DIFFERENT issue, possibly in a different repository -- so the
// resolution is done first, explicitly, and a child whose id cannot be resolved
// is never posted with its number as a guess.
//
// FALLBACK IS DETECTED, NOT PERFORMED. Where the sub-issues API is unavailable
// the documented fallback is a task list in the parent's body. This module
// reports that condition and hands back the exact task-list lines; it does not
// rewrite a body on its own, because "a claimed sub-issue graph that does not
// exist misleads every later sweep" and silently substituting one form for the
// other is how that claim gets made.
//
// THE LABEL UNION AND THE SEVERITY MAXIMUM ARE COMPUTED, NOT CHOSEN. Which
// labels are severities, and which severity outranks which, are the TARGET
// repository's vocabulary: the family is named by the caller and the ordering is
// read from that repository's own colour precedence, falling back to the order
// its taxonomy file declares them in. Nothing here knows a severity's name.
//
// THE CLOSE COMMENT IS A CHANNEL, AND ITS DEFAULT IS BYTE-FROZEN. The close
// message used to be the fixed string `Consolidated into #N.` with no way past
// it, so a caller whose choreography needs each absorbed member closed with a
// comment naming WHICH section absorbed it had to follow every
// `consolidate-close` with a hand-run `gh issue comment` per child
// (zheref/nen#29). That text differs per child, so a single template is not
// enough on its own -- ./command.ts therefore offers one template for the
// uniform case and a per-child map for the case the issue actually describes,
// and both arrive here as `CloseComments`. WITH NO CHANNEL SUPPLIED, THE
// RENDERED TEXT IS THE OLD FIXED STRING, BYTE FOR BYTE: the default is written
// below as the template `Consolidated into #{parent}.` precisely so that the
// back-compatibility claim is a substitution this module performs rather than a
// second code path that can drift from the first.
//
// `attach-sub` DELIBERATELY GETS NO SUCH CHANNEL. #29 asked for it on
// consolidate-close "and/or" attach-sub, and attach is the wrong half of the
// choreography to hang a comment on: the order rule at the top of this file
// exists because a failed attach STOPS the run before the closes, so a comment
// posted at attach time is a claim about a consolidation that may never
// complete -- the "dead reference" failure in the other direction. Attachment
// also already writes its own timeline event on both objects, so the comment
// would be a second, weaker record of the same fact. A caller who genuinely
// wants an attach-time comment now composes `nen issue comment` with
// `nen issue attach-sub`, which is what a general primitive is for.

import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { decomposeLabelName, type LabelTaxonomy } from "../schema/labels.js";

export interface IssueSummary {
  readonly number: number;
  readonly id: number | null;
  readonly title: string;
  readonly state: string;
  readonly labels: readonly string[];
  /**
   * True when the number actually names a PULL REQUEST. GitHub numbers issues
   * and PRs in one sequence and `issues/{n}` happily serves both, so every
   * caller that means "an issue" must be able to see which class it was
   * handed -- the payload's non-null `pull_request` is the one reliable
   * discriminator (issue #25: `gh issue view --json pull_request` does not
   * exist; it errors on every object, so there is no pre-check outside this
   * fetch).
   */
  readonly isPullRequest: boolean;
}

// One `gh api` read per issue. REST rather than `gh issue view`, because `id`
// -- the field the sub-issues API actually takes -- is not one of the fields
// `gh issue view --json` exposes.
export function readIssue(seams: Seams, target: Target, number: number): IssueSummary {
  const result = seams.run(GH, ["api", `repos/${target.slug}/issues/${number}`]);
  if (result.code !== 0) {
    throw new Error(
      `could not read ${target.slug}#${number}: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  const rawLabels = parsed["labels"];
  const labels = Array.isArray(rawLabels)
    ? rawLabels
        .map((label): string =>
          typeof label === "string" ? label : String((label as Record<string, unknown>)["name"] ?? ""),
        )
        .filter((name): boolean => name !== "")
    : [];
  const rawId = parsed["id"];
  // The REST payload carries `pull_request` (an object) ONLY when the number
  // names a PR; on a genuine issue the key is absent. Read it here, at the one
  // fetch, so no caller has to make a second request just to learn which
  // object class it was answered with.
  const rawPullRequest = parsed["pull_request"];
  return {
    number: Number(parsed["number"] ?? number),
    id: typeof rawId === "number" ? rawId : null,
    title: String(parsed["title"] ?? ""),
    state: String(parsed["state"] ?? ""),
    labels,
    isPullRequest: rawPullRequest !== undefined && rawPullRequest !== null,
  };
}

export interface AttachReport {
  readonly attached: readonly number[];
  readonly failed: readonly { readonly child: number; readonly reason: string }[];
  /**
   * Present when the API answered in a way that says the sub-issues endpoint is
   * not available here. The task-list lines are handed back so the caller can
   * use the documented fallback KNOWINGLY -- and say which form was used.
   */
  readonly fallbackTaskList: readonly string[] | null;
  readonly log: readonly string[];
}

// A response that means "this endpoint does not exist here" rather than "this
// request was wrong". 404 and 410 are the two GitHub returns for an endpoint
// that is absent or retired; a 422 is a bad request and must NOT be read as a
// missing API, because doing so would substitute the fallback for a defect.
function looksUnavailable(stderr: string): boolean {
  return /HTTP (404|410)\b/.test(stderr);
}

export function attachSub(
  seams: Seams,
  target: Target,
  parent: number,
  children: readonly number[],
  dryRun: boolean,
): AttachReport {
  const attached: number[] = [];
  const failed: { child: number; reason: string }[] = [];
  const log: string[] = [];
  let fallback: string[] | null = null;

  for (const child of children) {
    let summary: IssueSummary;
    try {
      summary = readIssue(seams, target, child);
    } catch (error) {
      failed.push({ child, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (summary.id === null) {
      failed.push({
        child,
        reason: `#${child} carries no 'id' in the API response, and the sub-issues endpoint takes an id. Posting the NUMBER instead would attach whichever issue happens to hold that id.`,
      });
      continue;
    }
    const argv = [
      "api",
      "--method",
      "POST",
      `repos/${target.slug}/issues/${parent}/sub_issues`,
      "-F",
      `sub_issue_id=${summary.id}`,
    ];
    if (dryRun) {
      log.push(`would run: gh ${argv.join(" ")}   (#${child} -> id ${summary.id})`);
      attached.push(child);
      continue;
    }
    const result = seams.run(GH, argv);
    if (result.code === 0) {
      attached.push(child);
      log.push(`attached #${child} (id ${summary.id}) to #${parent}`);
      continue;
    }
    const reason = outputLines(result.stderr).join(" ") || `exit ${result.code}`;
    failed.push({ child, reason });
    if (fallback === null && looksUnavailable(result.stderr)) {
      fallback = children.map((entry): string => `- [ ] #${entry}`);
      log.push(
        "the sub-issues endpoint answered 404/410 -- it is not available here. The documented fallback is a task list in the parent's body; the lines are in this report, and whichever form is used must be SAID, because a claimed sub-issue graph that does not exist misleads every later sweep.",
      );
    }
  }
  return { attached, failed, fallbackTaskList: fallback, log };
}

// --- consolidation -----------------------------------------------------------

export interface ConsolidationPlan {
  readonly parent: number;
  readonly children: readonly IssueSummary[];
  /** The union of every child's labels, minus the severity family. */
  readonly labelUnion: readonly string[];
  /** The highest severity among the children, or null when none carries one. */
  readonly severity: string | null;
  /** Which child set the severity -- so an overruled maximum can be argued with. */
  readonly severitySetBy: number | null;
  /** Children that already carry an open state and would be closed. */
  readonly toClose: readonly number[];
  /**
   * Populated ONLY when no severity family was named: every `<ns>:<family>`
   * prefix whose union above would put SEVERAL of its labels on the parent at
   * once. With no family named, the severity-max reduction below is
   * unreachable -- no real label's family string equals `""` -- so this is the
   * plan reporting "the guarantee that reduction exists for would be defeated
   * here", and the CLI refuses on it rather than proceeding silently.
   */
  readonly unreducedFamilies: readonly UnreducedFamily[];
  readonly notes: readonly string[];
}

export interface UnreducedFamily {
  /** `<namespace>:<family>`, spelled the way `--severity-family` takes it. */
  readonly family: string;
  /** The two-or-more distinct labels that would all land on the parent. */
  readonly labels: readonly string[];
}

export interface SeverityOrdering {
  /** `<namespace>:<family>`, e.g. as the target repository spells its severities. */
  readonly family: string;
  /** Leaf names, strongest first. */
  readonly order: readonly string[];
}

// The declaration order of a family's labels in the repository's own taxonomy
// file, which is the ordering the file itself asserts by writing them down in
// that sequence. It is a WEAKER source than an explicit precedence list and is
// used only when none is supplied -- and the plan says which was used.
export function orderingFromTaxonomy(taxonomy: LabelTaxonomy, family: string): SeverityOrdering {
  const [namespace, leaf] = family.split(":");
  if (namespace === undefined || leaf === undefined) return { family, order: [] };
  return {
    family,
    order: taxonomy
      .inFamily(namespace, leaf)
      .map((label): string => decomposeLabelName(label.name).leaf ?? "")
      .filter((name): boolean => name !== ""),
  };
}

export function planConsolidation(
  seams: Seams,
  target: Target,
  parent: number,
  children: readonly number[],
  taxonomy: LabelTaxonomy,
  severityFamily: string,
  ordering?: SeverityOrdering,
): ConsolidationPlan {
  const summaries = children.map((child): IssueSummary => readIssue(seams, target, child));
  const notes: string[] = [];

  const resolved =
    ordering ??
    (severityFamily === ""
      ? { family: "", order: [] }
      : orderingFromTaxonomy(taxonomy, severityFamily));
  if (severityFamily !== "" && ordering === undefined) {
    notes.push(
      `severity ordering read from ${taxonomy.path}'s declaration order for '${severityFamily}': ${resolved.order.join(" > ") || "(none declared)"}`,
    );
  }

  const union = new Set<string>();
  let severity: string | null = null;
  let severitySetBy: number | null = null;
  let bestRank = Number.MAX_SAFE_INTEGER;

  for (const child of summaries) {
    for (const label of child.labels) {
      const parts = decomposeLabelName(label);
      const family =
        parts.namespace === null || parts.family === null
          ? null
          : `${parts.namespace}:${parts.family}`;
      if (family !== null && family === severityFamily) {
        const rank = resolved.order.indexOf(parts.leaf ?? "");
        if (rank !== -1 && rank < bestRank) {
          bestRank = rank;
          severity = label;
          severitySetBy = child.number;
        }
        // A severity label is NOT unioned: exactly one belongs on the
        // consolidated issue, and unioning them would leave the parent carrying
        // several at once -- which is a state-machine violation, not a merge.
        continue;
      }
      union.add(label);
    }
  }

  // WHEN NO FAMILY WAS NAMED, DETECT WHAT THE REDUCTION WOULD HAVE CAUGHT.
  // The taxonomy declares its families STRUCTURALLY -- orderingFromTaxonomy
  // above reads whichever family the caller names; nothing in schemas/ marks
  // one family as "the severities" (that is §3: nen knows no severity's name).
  // So the detection is structural too: group the union's `<ns>:<family>/<leaf>`
  // labels by their family prefix, and any prefix contributing two or more
  // DISTINCT labels is a family the union is about to put on the parent
  // several-at-once -- the exact state the comment above calls a state-machine
  // violation. One label per family is fine (that is what a reduction would
  // have produced anyway); leafless labels (`ns:name`) have no family members
  // to collide with and never trip this.
  const unreducedFamilies: UnreducedFamily[] = [];
  if (severityFamily === "") {
    const byFamily = new Map<string, string[]>();
    for (const label of union) {
      const parts = decomposeLabelName(label);
      if (parts.namespace === null || parts.family === null || parts.leaf === null) continue;
      const key = `${parts.namespace}:${parts.family}`;
      byFamily.set(key, [...(byFamily.get(key) ?? []), label]);
    }
    for (const family of [...byFamily.keys()].sort()) {
      const labels = byFamily.get(family) ?? [];
      if (labels.length > 1) unreducedFamilies.push({ family, labels: [...labels].sort() });
    }
  }

  const toClose = summaries
    .filter((child): boolean => child.state.toLowerCase() === "open")
    .map((child): number => child.number);
  const alreadyClosed = summaries.filter((child): boolean => child.state.toLowerCase() !== "open");
  if (alreadyClosed.length > 0) {
    notes.push(
      `already closed, so not closed again: ${alreadyClosed.map((child): string => `#${child.number}`).join(", ")}`,
    );
  }

  return {
    parent,
    children: summaries,
    labelUnion: [...union].sort(),
    severity,
    severitySetBy,
    toClose,
    unreducedFamilies,
    notes,
  };
}

// --- the close comment ---------------------------------------------------------

/**
 * The close message this verb has always posted, now written as a TEMPLATE.
 *
 * `Consolidated into #{parent}.` renders to `Consolidated into #9.` -- the
 * exact string the fixed implementation emitted -- so "omitting the flag
 * changes nothing" is a property of one substitution rather than a promise two
 * branches have to keep in step.
 */
export const DEFAULT_CLOSE_COMMENT = "Consolidated into #{parent}.";

/**
 * The whole placeholder vocabulary, and it is deliberately two words long.
 *
 * Both substitute the BARE NUMBER, not `#<n>`: the caller writes the `#`, which
 * is what lets a cross-repository close comment spell the parent
 * `owner/name#{parent}` instead of being stuck with this repository's local
 * form. Anything else in braces is refused at the CLI (./command.ts) rather
 * than passed through, because an unrecognised placeholder would otherwise be
 * posted LITERALLY -- `{parnet}` on a public timeline, on a verb that closes
 * issues, with exit 0. "Anything else in braces" means exactly that, down to
 * `{{parent}}`, `{ parent }` and a brace with no partner at all (`#{parent`);
 * see PLACEHOLDER and LONE_BRACE below for why the guard is shaped around
 * brace RUNS rather than around word-shaped interiors, and why a run is not
 * the only shape a stray brace comes in.
 */
export const CLOSE_COMMENT_PLACEHOLDERS: readonly string[] = ["parent", "child"];

/**
 * EVERY RUN OF BRACES, not only the well-formed `{word}` ones.
 *
 * The first version of this matched `\{([A-Za-z0-9_-]*)\}`, which made the
 * guarantee above a half-guarantee: a brace run whose interior was not word
 * characters was neither refused NOR substituted, so it went out literally with
 * exit 0. The three shapes that reaches are exactly the three a human types by
 * mistake -- `#{{parent}}` (the Handlebars/Jinja spelling, which posted the
 * genuinely baffling `#{1}` because the INNER braces matched), `#{ parent }` and
 * `#{parent }` (a space that reads as nothing to the eye). Refusing only the
 * misspellings that happen to be alphanumeric is refusing the ones a caller is
 * least likely to make.
 *
 * The cost is that a close comment cannot contain literal braces at all --
 * `{"a": 1}` in a close comment is refused. That is the deliberate trade: this
 * text is posted to a public timeline by a verb that closes issues, brace-laden
 * prose in a one-line close comment is rare, and the refusal names the
 * vocabulary so the next invocation is right. A pass-through that is wrong is
 * not visible until someone reads the timeline.
 */
const PLACEHOLDER = /\{+[^{}]*\}+/g;

/**
 * A BRACE WITH NO PARTNER -- the half of the guard PLACEHOLDER structurally
 * cannot see (round-two review finding).
 *
 * PLACEHOLDER requires braces on BOTH sides, so `#{parent` matches nothing at
 * all: it was neither refused nor substituted, and went out literally on a REAL
 * close -- `Consolidated into #{parent` posted to a public timeline at exit 0.
 * That is the same defect the `{{parent}}` round fixed, one keystroke over: a
 * dropped closing brace is at least as common a typo as an extra one, and the
 * guard that refuses the extra one waved the dropped one straight through.
 *
 * Applied to the RESIDUE -- the template with every matched run blanked out --
 * so a well-formed `{parent}` does not report its own braces as strays. Each
 * offender is quoted with the non-brace, non-space run that follows it, because
 * a refusal that says only `{` tells a caller which CHARACTER is wrong and not
 * which WORD they meant to write.
 */
const LONE_BRACE = /[{}][^\s{}]*/g;

/**
 * The vocabulary word a brace run names, or null if it names none.
 *
 * Deliberately strict about the run itself: exactly one brace on each side, and
 * an interior that IS a vocabulary word with nothing around it. Everything the
 * regex above catches and this rejects is what `unknownPlaceholders` reports.
 */
function placeholderName(run: string): string | null {
  const match = /^\{([A-Za-z0-9_-]+)\}$/.exec(run);
  const name = match?.[1] ?? "";
  return CLOSE_COMMENT_PLACEHOLDERS.includes(name) ? name : null;
}

/** Every brace run in the template that is not one of the two placeholders, deduplicated in first-appearance order. */
export function unknownPlaceholders(template: string): readonly string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (placeholderName(match[0]) === null) found.add(match[0]);
  }
  return [...found];
}

/**
 * Every UNMATCHED brace in the template, deduplicated in first-appearance
 * order -- reported separately from `unknownPlaceholders` because the two are
 * different mistakes with different fixes: an unknown placeholder is a word
 * this vocabulary does not have, an unmatched brace is a brace the caller
 * forgot to close (or to open).
 *
 * Both are refused at the CLI (./command.ts) for the SAME reason -- a verb that
 * closes issues must never post a template fragment as prose -- and neither is
 * substituted here, so a renderer reached directly still passes the offending
 * bytes through untouched rather than half-rendering them.
 */
export function unmatchedBraces(template: string): readonly string[] {
  // Blanked to spaces rather than deleted, so a stray brace's trailing word is
  // still bounded by whatever really followed it in the template.
  const residue = template.replace(PLACEHOLDER, (run: string): string => " ".repeat(run.length));
  return [...new Set([...residue.matchAll(LONE_BRACE)].map((match): string => match[0]))];
}

/**
 * `{parent}` and `{child}` substituted; every other character passes through
 * untouched -- including a brace run this module does not recognise, which the
 * CLI has already refused by the time a real invocation reaches here.
 */
export function renderCloseComment(template: string, parent: number, child: number): string {
  return template.replace(PLACEHOLDER, (whole: string): string => {
    const name = placeholderName(whole);
    if (name === "parent") return String(parent);
    if (name === "child") return String(child);
    return whole;
  });
}

/**
 * The caller-supplied close text, in the two shapes ./command.ts accepts.
 *
 * `perChild` WINS over `template` for a child it names, so the two can be
 * reasoned about independently; in practice ./command.ts refuses both flags at
 * once, so exactly one of these is ever populated.
 */
export interface CloseComments {
  /** One template for every child, or null when the caller supplied a map. */
  readonly template: string | null;
  /** Child number -> that child's own template. */
  readonly perChild: ReadonlyMap<number, string>;
}

function templateFor(comments: CloseComments | null, child: number): string {
  if (comments === null) return DEFAULT_CLOSE_COMMENT;
  return comments.perChild.get(child) ?? comments.template ?? DEFAULT_CLOSE_COMMENT;
}

export interface ConsolidateReport {
  readonly log: readonly string[];
  readonly failed: readonly string[];
  readonly attached: readonly number[];
  readonly closed: readonly number[];
  /**
   * Each close comment this run REACHED, already rendered: the text posted, the
   * text attempted where the close failed, or -- under `dryRun` -- the text that
   * would have gone out. One entry per child in `toClose`, in that order, when
   * the closes ran at all.
   *
   * EMPTY WHEN THE ATTACH STAGE FAILED, even though `toClose` is not: the run
   * stops before the close loop (see below), so no comment was rendered, sent or
   * attempted, and reporting the texts that WOULD have gone out would read as a
   * list of things that did. `failed` is the field that says why the list is
   * short.
   *
   * Reported rather than left implicit in the argv, because a `--json` caller
   * that supplied a template has no other way to see the substitution its own
   * children got -- and a close comment is the half of this choreography a
   * human reads afterwards.
   */
  readonly closeComments: readonly { readonly child: number; readonly body: string }[];
}

// file -> attach -> close, and it stops at the first failing STAGE.
//
// The parent must already exist -- filing it is `nen issue file`, and it is a
// separate call on purpose: the consolidated issue's title and body are written
// by a human or an LLM, and a verb that generated them would be authoring the
// judgment this whole surface refuses to author.
//
// `comments` DEFAULTS TO NULL, so every existing call site keeps posting the
// fixed string it always posted -- see DEFAULT_CLOSE_COMMENT above.
export function consolidateClose(
  seams: Seams,
  target: Target,
  plan: ConsolidationPlan,
  dryRun: boolean,
  comments: CloseComments | null = null,
): ConsolidateReport {
  const log: string[] = [];
  const failed: string[] = [];
  const closeComments: { child: number; body: string }[] = [];

  log.push(`parent: #${plan.parent}`);
  log.push(`label union: ${plan.labelUnion.join(", ") || "(none)"}`);
  log.push(
    `severity: ${plan.severity ?? "(none)"}${plan.severitySetBy === null ? "" : ` (set by #${plan.severitySetBy})`}`,
  );
  for (const note of plan.notes) log.push(`note: ${note}`);

  const attachReport = attachSub(
    seams,
    target,
    plan.parent,
    plan.children.map((child): number => child.number),
    dryRun,
  );
  log.push(...attachReport.log);
  if (attachReport.failed.length > 0) {
    for (const failure of attachReport.failed) {
      failed.push(`attach #${failure.child}: ${failure.reason}`);
    }
    log.push(
      "STOPPED before the closes. A close comment naming a parent whose sub-issue graph is incomplete is a claim the graph does not support; the closes are the last step for exactly this reason.",
    );
    return { log, failed, attached: attachReport.attached, closed: [], closeComments };
  }

  const closed: number[] = [];
  for (const child of plan.toClose) {
    const template = templateFor(comments, child);
    const comment = renderCloseComment(template, plan.parent, child);
    closeComments.push({ child, body: comment });
    const argv = [
      "issue",
      "close",
      String(child),
      "--repo",
      target.slug,
      "--comment",
      comment,
    ];
    if (dryRun) {
      log.push(`would run: gh ${argv.join(" ")}`);
      closed.push(child);
      continue;
    }
    const result = seams.run(GH, argv);
    if (result.code !== 0) {
      failed.push(`close #${child}: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`);
      continue;
    }
    closed.push(child);
    // The old line CLAIMED the comment names the parent, which is only true of
    // the default template -- a caller-supplied one may name a section, a
    // decision, or nothing at all. So the claim is made only where it holds,
    // and the default's line stays byte-identical for anyone reading a
    // transcript diff against an older run.
    log.push(
      template === DEFAULT_CLOSE_COMMENT
        ? `closed #${child} with a comment naming #${plan.parent}`
        : `closed #${child} with the caller-supplied close comment`,
    );
  }
  return { log, failed, attached: attachReport.attached, closed, closeComments };
}
