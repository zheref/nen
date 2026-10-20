// PR lifecycle observation deliberately bypasses readiness assembly: a merged
// PR need not have readable checks, review rounds or a local/base gate policy.
import { VerbUsageError, type CommandContext } from "../cli/command.js";
import { assertRepoRoot } from "../repo/root.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { resolveRef, type PrReadyDeps } from "../verbs/pr_ready.js";
import type { WatchObservation } from "./until.js";

export interface LifecycleReading {
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly mergeSHA: string | null;
  readonly base: string;
  readonly headSHA: string;
}
export interface LifecycleObservation extends WatchObservation {
  readonly reading: LifecycleReading | null;
}

export function mergedReader(context: CommandContext, typedRef: string, deps: PrReadyDeps): () => Promise<LifecycleObservation> {
  const requiredHead = context.args.values["require-head"];
  if (requiredHead !== undefined && !/^[0-9a-f]{7,40}$/i.test(requiredHead)) {
    throw new VerbUsageError(`--require-head takes a commit SHA of 7 to 40 hex digits (got '${requiredHead}').`);
  }
  let ref: ReturnType<typeof resolveRef>;
  try {
    const root = assertRepoRoot({ repoFlag: context.repoFlag });
    ref = resolveRef(typedRef, context.args.values["gh-repo"], () => loadRepoRegistry(root));
  } catch (error) {
    throw new VerbUsageError(error instanceof Error ? error.message : String(error));
  }
  return async (): Promise<LifecycleObservation> => {
    try {
      const opened = deps.openSource(context.args.values["token-env"] ?? "GH_TOKEN");
      if (!opened.ok) throw new Error(opened.message);
      const { pullRequest: node } = await opened.source.pullRequestSnapshot(ref, ref.number);
      if (node === undefined) throw new Error("the response carried no pull request");
      const { state, baseRefName: base, headRefOid: headSHA, mergeCommit } = node;
      if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") throw new Error("the pull request state could not be read");
      if (typeof base !== "string" || base.trim() === "") throw new Error("the base branch could not be read");
      if (typeof headSHA !== "string" || !/^[0-9a-f]{40}$/i.test(headSHA)) throw new Error("the full head SHA could not be read");
      if (requiredHead !== undefined && !headSHA.toLowerCase().startsWith(requiredHead.toLowerCase())) {
        throw new Error(`--require-head ${requiredHead} does not match GitHub's head ${headSHA}`);
      }
      let mergeSHA: string | null = null;
      if (state === "MERGED") {
        const oid = typeof mergeCommit === "object" && mergeCommit !== null && !Array.isArray(mergeCommit)
          ? (mergeCommit as Record<string, unknown>)["oid"] : undefined;
        if (typeof oid !== "string" || !/^[0-9a-f]{40}$/i.test(oid)) throw new Error("the full merge commit SHA could not be read");
        mergeSHA = oid;
      } else if (mergeCommit !== null) {
        throw new Error("an unmerged pull request did not report a null merge commit");
      }
      const reading: LifecycleReading = { state, mergeSHA, base, headSHA };
      const message = state === "MERGED" ? `PR ${ref.owner}/${ref.repo}#${ref.number} MERGED at ${mergeSHA} into ${base}`
        : state === "CLOSED" ? `PR ${ref.owner}/${ref.repo}#${ref.number} CLOSED without merge into ${base}`
          : `PR ${ref.owner}/${ref.repo}#${ref.number} OPEN; waiting for merge into ${base}`;
      return { errored: false, conditionTrue: state === "MERGED", terminalFalse: state === "CLOSED", message, reading };
    } catch (error) {
      return { errored: true, conditionTrue: false, message: `observation failed: ${error instanceof Error ? error.message : String(error)}`, reading: null };
    }
  };
}
