// src/runner/command.ts -- `nen runner inventory | plan | script | verify |
// workflow | preflight | enable`: the self-hosted runner family hatsu:jusshin
// executes, one deterministic step per verb.
//
// THE HOST ACT IS NEVER NEN'S. Registering a service, granting a folder right
// and typing a service account's password happen on the maintainer's machine,
// with the maintainer's consent (a UAC prompt, their own sudo). So the family
// stops at RENDERING that act (`script`) and at the one line that launches it;
// every verb before it reads, every verb after it proves, and the only two
// that write to GitHub -- `preflight` (a workflow dispatch) and `enable` (a
// repository variable) -- each carry a `--dry-run`, and `enable` refuses to
// write without a green preflight run it re-reads itself.
//
// NO TOKEN, NO PASSWORD, EVER. Nen never mints the registration token (the
// host script does, inside the elevated process), never sees the password
// (typed into the script's own SecureString prompt), and never prints a `gh`
// token: every subprocess line that reaches a message goes through
// ../seam/exec.ts's `outputLines` redaction first (./github.ts).
//
// EXIT CODES ARE USAGE.md's: 0 success, 1 the verb's own failure -- a GitHub
// refusal or an unreadable answer included, because this CLI reserves no code
// for a network failure (`pr ready`'s "GitHub could not be read" is 1 too) --
// 2 usage, wiring or a missing declaration, and 5 `gh` could not be started
// (the `shu` family's "the declared program could not be started").
//
// ONE FLAG SPEC FOR THE FAMILY, CHECKED PER VERB. ../cli/command.ts's rule is
// that a family owns its flags; within this family a flag another verb owns
// (`--force` on `plan`) is refused at exit 2 naming the verb it belongs to,
// the way the issue family does, rather than accepted and ignored.
//
// `--target` DEFAULTS TO THE CHECKOUT'S ORIGIN for the four verbs that only
// read or render (inventory, plan, verify, workflow); the two that WRITE to
// GitHub (preflight, enable) require it by name. ../github/target.ts's header
// is the reason for the split: a write that silently took the working
// directory's remote is how a mutating run lands on the wrong repository.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import {
  emit,
  parseCallerToken,
  readInteger,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { resolveAgainstRepo } from "../cli/inputs.js";
import { parseTarget, TargetError, targetFromRemote, type Target } from "../github/target.js";
import { assertRepoRoot, resolveRepoRoot } from "../repo/root.js";
import { SchemaError } from "../schema/errors.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { loadWorkflow, WORKFLOW_FILE, type RunnerPool, type RunnersPolicy } from "../schema/workflow.js";
import { VERSION } from "../version.js";
import { CertificationRefusal, enablePool, renderEnable, VARIABLE_VALUE, type EnableReport } from "./enable.js";
import { realSleep, RunnerFailure, type Sleep } from "./github.js";
import { assembleInventory, fetchDownloads, fetchRunners, renderInventory } from "./inventory.js";
import { checkNeighbours, renderNeighbours } from "./neighbours.js";
import { computePlan, normalizeMachineCode, renderPlan, resolveConsumerCode, validatePlan, type RunnerPlan } from "./plan.js";
import { renderPreflight, runPreflight } from "./preflight.js";
import { launchLine, renderScript, summaryGlob } from "./script.js";
import { renderVerify, verifyRunners } from "./verify.js";
import { differingLines, renderWorkflow, workflowValues } from "./workflow.js";

export const RUNNER_SUBCOMMANDS = ["inventory", "plan", "script", "verify", "workflow", "preflight", "enable"] as const;
type Subcommand = (typeof RUNNER_SUBCOMMANDS)[number];

/** Each verb's own flags, on top of the globals (`--repo`, `--json`, `--help`). */
export const RUNNER_SUBCOMMAND_FLAGS: Readonly<Record<Subcommand, readonly string[]>> = {
  inventory: ["target", "pool"],
  plan: ["target", "pool", "machine-code", "count", "root", "service-account", "consumer-code", "out"],
  script: ["plan", "out", "dry-run"],
  verify: ["target", "expect", "labels", "wait"],
  workflow: ["target", "pool", "template", "out", "force", "dry-run"],
  preflight: ["target", "workflow", "ref", "wait", "dry-run"],
  enable: ["target", "pool", "after-run", "value", "dry-run"],
};

const VALUE_FLAGS = [
  "target",
  "pool",
  "machine-code",
  "count",
  "root",
  "service-account",
  "consumer-code",
  "out",
  "plan",
  "expect",
  "labels",
  "wait",
  "template",
  "workflow",
  "ref",
  "after-run",
  "value",
];
const BOOLEAN_FLAGS = ["dry-run", "force"];

const USAGE = `nen runner inventory [--target <owner/name>] [--repo <path>] [--pool <id>] [--json]
nen runner plan --pool <id> --machine-code <CODE> --count <n> [--target <owner/name>] [--repo <path>] [--root <dir>] [--service-account <name>] [--consumer-code <CODE>] [--out <file>] [--json]
nen runner script --plan <plan.json> --out <file> [--repo <path>] [--dry-run] [--json]
nen runner verify --expect <name>[,<name>...] [--target <owner/name>] [--labels <a,b,c>] [--wait <seconds>] [--json]
nen runner workflow --pool <id> --template <path> [--target <owner/name>] [--repo <path>] [--out <path>] [--force] [--dry-run] [--json]
nen runner preflight --target <owner/name> --workflow <basename> [--ref <branch>] [--wait <seconds>] [--dry-run] [--json]
nen runner enable --target <owner/name> --pool <id> --after-run <run-id> [--repo <path>] [--value online] [--dry-run] [--json]

The self-hosted runner family a provisioning skill executes: read what a repository
has, plan what to add, render the host script that adds it (the maintainer
runs it, elevated), verify the runners came up, render and dispatch the pool's
preflight workflow, and -- only on a green preflight -- switch the pool on.
Pools come from the 'runners' block of --repo's ${WORKFLOW_FILE}. Nen never
mints a registration token, never sees a password and never runs the host
script. --target defaults to --repo's origin for inventory, plan, verify and
workflow; preflight and enable write to GitHub and require it.

inventory  GET .../actions/runners (every page) and .../runners/downloads.
           Each runner with its parsed <machine>-<consumer>R<slot> name (or
           'runner 0'); with --repo or --pool, grouped into the declared pools
           (online, free) plus the unpooled ones. Exit 0 when GitHub answered;
           1 when it refused (403: needs admin on the target).
plan       Which runners to add: the lowest free slots for --machine-code and
           the consumer code (--consumer-code, else nen/repos.json's
           product_codes key naming the target), the install dirs under the
           root (--root, else the pool's root.<os>, else the built-in default),
           the service identity (--service-account; 'network-service' only by
           that explicit word on Windows; macOS takes none), and the runner
           package with its SHA-256. --count 1..16. --out writes the plan JSON
           (contract nen.runner.plan/v0.1). On the pool's own host it reads
           the existing runner services, read-only, and warns on stderr (exit
           0) when the account already serves a repository of different
           visibility, recommending a per-repository account (#330).
script     Render the plan's host script: PowerShell 5.1 (Windows), bash
           (Linux, run with sudo; macOS, run as yourself). --json names the one
           launch line, the script's scriptSha256 and the summary file glob.
           Refuses a plan whose identity is still 'ask', and an --out under
           the plan's root: write it to %LOCALAPPDATA%\\nen\\jusshin\\ (Windows)
           or ~/.local/state/nen/jusshin/ (Linux, macOS).
verify     Poll the runners list every 10s for up to --wait seconds (default
           0: once) until every --expect name is present, online and carries
           every --labels label. Never exits 0 on a partial pass.
workflow   Render the pool's preflight workflow from --template's @@NAME@@
           placeholders into --out (default .github/workflows/<the pool's
           preflightWorkflow>). An @@X@@ left over is exit 1; an existing file
           that differs is overwritten only with --force.
preflight  gh workflow run <workflow> on --ref (default: the default branch),
           find the run it created, and wait up to --wait (default 600) for
           its conclusion. Exit 0 only on success; a job still queued at the
           deadline is named: no free runner picked it up. A workflow not on
           the ref is exit 2: merge it first. Only a run on the default
           branch can certify a pool; another --ref is a rehearsal.
enable     Re-read --after-run and require it to be a completed, successful run
           of the pool's own preflight workflow whose jobs asked for the pool's
           labels, dispatched (workflow_dispatch) on the default branch, with
           the workflow's blob at its head_sha equal to the default branch's;
           then gh variable set <enableVariable> --body <--value, default
           online> and read it back. A run that fails any check is exit 1, and
           --json names each check that refused it (event, branch, blob, ...).
           A pool with no enableVariable is exit 2: nothing to enable.

Exit codes: 0 success; 1 the verb's own failure (GitHub refused or answered
something unreadable, a planned name taken, a leftover placeholder, a run that
is not a green preflight); 2 usage, or no/malformed 'runners' block; 5 gh
could not be started.`;

function refuseForeignFlags(context: CommandContext, subcommand: Subcommand): void {
  const allowed = new Set(RUNNER_SUBCOMMAND_FLAGS[subcommand]);
  const given = [...Object.keys(context.args.values).filter((flag): boolean => flag !== "repo"), ...[...context.args.booleans].filter((flag): boolean => flag !== "json" && flag !== "help")];
  for (const flag of given) {
    if (allowed.has(flag)) continue;
    const owners = RUNNER_SUBCOMMANDS.filter((verb): boolean => RUNNER_SUBCOMMAND_FLAGS[verb].includes(flag));
    throw new VerbUsageError(`--${flag} is not a 'runner ${subcommand}' flag${owners.length === 0 ? "" : ` (it belongs to runner ${owners.join(", runner ")})`}.`);
  }
}

function parseTargetFlag(raw: string): Target {
  return parseCallerToken(
    (): Target => parseTarget(raw),
    (error: unknown): boolean => error instanceof TargetError,
  );
}

/** `--target`, or (for the read-and-render verbs) the checkout's origin. */
function resolveTarget(context: CommandContext, required: boolean): Target {
  const raw = context.args.values["target"];
  if (raw !== undefined && raw.trim() !== "") return parseTargetFlag(raw);
  if (required) {
    throw new VerbUsageError("--target owner/name is required: this verb writes to GitHub, and a write never falls back to the working directory's remote.");
  }
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  return parseCallerToken(
    (): Target => targetFromRemote(context.seams, root),
    (error: unknown): boolean => error instanceof TargetError,
  );
}

/** The `runners` block of --repo's policy, or a refusal at exit 2 naming the key. */
function loadRunners(root: string): RunnersPolicy {
  let loaded: ReturnType<typeof loadWorkflow>;
  try {
    loaded = loadWorkflow(root);
  } catch (error) {
    if (error instanceof SchemaError) throw new VerbUsageError(error.message);
    /* c8 ignore next -- the loader raises nothing else */
    throw error;
  }
  if (loaded.workflow.runners === null) {
    throw new VerbUsageError(
      `${loaded.path} declares no 'runners' block${loaded.present ? "" : " (the file is absent)"}, so there is no pool to act on. Declare one: "runners": { "naming": "{machine}-{consumer}R{slot}", "pools": [ { "id": "<id>", "os": "Windows|Linux|macOS", "arch": "X64|ARM64", "labels": ["self-hosted", "<os>", "<arch>"], "enableVariable": "<VAR>", "tools": ["git", ...], "preflightWorkflow": "<file>.yml" } ] }.`,
    );
  }
  return loaded.workflow.runners;
}

function requirePool(policy: RunnersPolicy, id: string): RunnerPool {
  const pool = policy.pools.find((candidate): boolean => candidate.id === id);
  if (pool === undefined) {
    throw new VerbUsageError(`no pool '${id}' in the runners block. Declared: ${policy.pools.map((candidate): string => candidate.id).join(", ")}.`);
  }
  return pool;
}

function readSeconds(context: CommandContext, flag: string, fallback: number): number {
  return readInteger(context.args, flag, fallback);
}

function commaValues(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry): string => entry.trim())
    .filter((entry): boolean => entry !== "");
}

function writeOut(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/** Where a host script belongs: the maintainer's own profile, never the runner root (#312). */
const OUT_HOME: Readonly<Record<RunnerPlan["os"], string>> = {
  Windows: "%LOCALAPPDATA%\\nen\\jusshin\\",
  Linux: "~/.local/state/nen/jusshin/",
  macOS: "~/.local/state/nen/jusshin/",
};

/**
 * Whether `path` is `dir` or lies under it, compared the way the runner host's
 * file system compares: case-blind on Windows and macOS, `\` and `/` alike.
 */
export function isUnder(path: string, dir: string, os: RunnerPlan["os"]): boolean {
  const fold = (value: string): string => {
    const slashed = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return os === "Linux" ? slashed : slashed.toLowerCase();
  };
  const child = fold(path);
  const parent = fold(dir);
  return child === parent || child.startsWith(`${parent}/`);
}

export interface RunnerDeps {
  readonly sleep: Sleep;
  readonly version: string;
}

function inventory(context: CommandContext): number {
  const poolFilter = context.args.values["pool"] ?? null;
  const grouped = context.repoFlag !== null || poolFilter !== null;
  const policy = grouped ? loadRunners(assertRepoRoot({ repoFlag: context.repoFlag })) : null;
  if (policy !== null && poolFilter !== null) requirePool(policy, poolFilter);
  const target = resolveTarget(context, false);
  const report = assembleInventory(target, fetchRunners(context.seams, target), fetchDownloads(context.seams, target), policy, poolFilter);
  emit(context.io, context.json, report, renderInventory(report));
  return 0;
}

function plan(context: CommandContext): number {
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const pool = requirePool(loadRunners(root), requireValue(context.args, "pool", "It names one pool of the runners block."));
  const machineCode = normalizeMachineCode(requireValue(context.args, "machine-code", "It is the host's code in every runner name (<machine>-<consumer>R<slot>) -- the maintainer's word, never derived."));
  const countRaw = requireValue(context.args, "count", "How many runners to add; there is no default.");
  if (!/^\d+$/.test(countRaw)) throw new VerbUsageError(`--count takes a whole number from 1 to 16, got '${countRaw}'.`);
  const target = resolveTarget(context, false);
  const consumerFlag = context.args.values["consumer-code"] ?? null;
  const consumerCode = resolveConsumerCode(consumerFlag, consumerFlag === null ? loadProductCodes(root) : {}, target);
  const result = computePlan({
    target,
    pool,
    machineCode,
    consumerCode,
    count: Number.parseInt(countRaw, 10),
    root: context.args.values["root"] ?? null,
    serviceAccount: context.args.values["service-account"] ?? null,
    runners: fetchRunners(context.seams, target),
    downloads: fetchDownloads(context.seams, target),
    platform: context.seams.platform,
    env: context.seams.env,
  });
  const out = context.args.values["out"];
  if (out !== undefined) writeOut(resolveAgainstRepo(root, out), `${JSON.stringify(result, null, 2)}\n`);
  emit(context.io, context.json, result, [...renderPlan(result), ...(out === undefined ? [] : [`wrote ${resolveAgainstRepo(root, out)}`])]);
  // #330: on stderr, at exit 0, so the plan's own contract (stdout, --out) is unchanged.
  for (const line of renderNeighbours(checkNeighbours(context.seams, target, result.os, result.identity), target, result.identity)) {
    context.io.err(`nen runner plan: ${line}`);
  }
  return 0;
}

function loadProductCodes(root: string): Readonly<Record<string, string>> {
  try {
    return loadRepoRegistry(root).productCodes;
  } catch (error) {
    throw new VerbUsageError(`${error instanceof Error ? error.message : String(error)} Pass --consumer-code <CODE> instead.`);
  }
}

function script(context: CommandContext, deps: RunnerDeps): number {
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const planPath = resolveAgainstRepo(root, requireValue(context.args, "plan", "It is the file 'nen runner plan --out' wrote."));
  const outFlag = requireValue(context.args, "out", "It is where the host script is written; the launch line names it.");
  // NORMALIZED, not merely resolved: an absolute --out is used as given, and on
  // a Windows host the launch line must name it with the separators the
  // elevated PowerShell reads.
  const out = resolvePath(resolveAgainstRepo(root, outFlag));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (error) {
    throw new VerbUsageError(`--plan '${planPath}' could not be read as JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  const planned = validatePlan(raw, `--plan '${planPath}'`);
  if (planned.identity === "ask") {
    throw new VerbUsageError(
      `the plan's identity is 'ask': nobody named the account the ${planned.os} services run as. Re-run 'nen runner plan' with --service-account <name>${planned.os === "Windows" ? " (a LOCAL account; 'network-service' only by explicit choice)" : ""}.`,
    );
  }
  if (planned.os === "Windows" && (!/\.ps1$/i.test(out) || /[\s'"]/.test(out))) {
    throw new VerbUsageError(`--out '${out}' must end in .ps1 and carry no space or quote: 'powershell -File' runs only a .ps1, and the launch line passes the path inside a quoted Start-Process argument list.`);
  }
  if (isUnder(out, planned.root, planned.os) || isUnder(outFlag, planned.root, planned.os)) {
    throw new VerbUsageError(
      `--out '${out}' is under the plan's runner root '${planned.root}'. Write the script where only you can change it before it runs elevated -- ${OUT_HOME[planned.os]} -- never inside the root the runners' own service account can reach.`,
    );
  }
  const rendered = renderScript(planned, deps.version);
  if (context.args.booleans.has("dry-run") !== true) writeOut(out, rendered.text);
  const result = {
    os: planned.os,
    out,
    runners: planned.runners.map((runner): string => runner.name),
    identity: planned.identity,
    needsElevation: rendered.needsElevation,
    launch: launchLine(planned.os, out),
    written: !context.args.booleans.has("dry-run"),
    scriptSha256: createHash("sha256").update(rendered.text, "utf8").digest("hex"),
    summary: summaryGlob(planned),
  };
  emit(context.io, context.json, result, [
    `${result.written ? "wrote" : "(dry run) would write"} ${out} -- ${planned.os} host script for ${result.runners.join(", ")} as ${planned.identity}`,
    `sha256 ${result.scriptSha256}; the run leaves its one summary line in ${result.summary}`,
    `launch${result.needsElevation ? " (elevated)" : ""}: ${result.launch}`,
  ]);
  return 0;
}

function verify(context: CommandContext, deps: RunnerDeps): number {
  const expect = commaValues(requireValue(context.args, "expect", "It lists the runner names that must be online."));
  if (expect.length === 0) throw new VerbUsageError("--expect names no runner.");
  const target = resolveTarget(context, false);
  const report = verifyRunners(context.seams, target, expect, commaValues(context.args.values["labels"]), readSeconds(context, "wait", 0), deps.sleep);
  emit(context.io, context.json, report, renderVerify(report));
  return report.ok ? 0 : 1;
}

function workflow(context: CommandContext, deps: RunnerDeps): number {
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const pool = requirePool(loadRunners(root), requireValue(context.args, "pool", "It names the pool the workflow proves."));
  const templatePath = resolveAgainstRepo(root, requireValue(context.args, "template", "Nen carries the renderer, not the template: name the caller's runner-preflight template."));
  let template: string;
  try {
    template = readFileSync(templatePath, "utf8");
  } catch (error) {
    throw new VerbUsageError(`--template '${templatePath}' could not be read (${error instanceof Error ? error.message : String(error)}).`);
  }
  const target = resolveTarget(context, false);
  const rendered = renderWorkflow(template, workflowValues(pool, target, deps.version));
  if (rendered.leftovers.length > 0) {
    throw new RunnerFailure(1, `the rendered workflow still carries ${rendered.leftovers.join(", ")} -- a placeholder this renderer does not fill. The seven it fills are @@REPO_SLUG@@, @@RUNS_ON@@, @@OS@@, @@TOOLS@@, @@POOL_ID@@, @@WORKFLOW_FILE@@, @@RENDERED_BY@@. Nothing was written.`);
  }
  if (rendered.yamlError !== null) {
    throw new RunnerFailure(1, `the rendered workflow is not valid YAML (${rendered.yamlError}). Nothing was written.`);
  }
  const outFlag = context.args.values["out"];
  const out = outFlag === undefined ? resolveAgainstRepo(root, `.github/workflows/${pool.preflightWorkflow}`) : resolveAgainstRepo(root, outFlag);
  const existing = existsSync(out) ? readFileSync(out, "utf8") : null;
  const unchanged = existing !== null && existing.replace(/\r\n/g, "\n") === rendered.text.replace(/\r\n/g, "\n");
  if (existing !== null && !unchanged && !context.args.booleans.has("force")) {
    throw new RunnerFailure(1, `${out} exists and differs from the rendering in ${differingLines(existing, rendered.text)} line(s). Nothing was written; pass --force to overwrite it.`);
  }
  const dryRun = context.args.booleans.has("dry-run");
  if (!dryRun && !unchanged) writeOut(out, rendered.text);
  const result = { out, pool: pool.id, target: target.slug, runsOn: pool.labels, written: !dryRun && !unchanged, unchanged };
  emit(context.io, context.json, result, [
    unchanged
      ? `${out} already matches the rendering -- nothing written.`
      : `${dryRun ? "(dry run) would write" : "wrote"} ${out} -- preflight for pool ${pool.id} [${pool.labels.join(", ")}] on ${target.slug}`,
  ]);
  return 0;
}

function preflight(context: CommandContext, deps: RunnerDeps): number {
  const target = resolveTarget(context, true);
  const workflowName = requireValue(context.args, "workflow", "It is the preflight workflow's basename, e.g. runner-preflight-windows-x64.yml.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(workflowName)) {
    throw new VerbUsageError(`--workflow '${workflowName}' is not a workflow basename (no directory, ending .yml).`);
  }
  const report = runPreflight(context.seams, target, {
    workflow: workflowName,
    ref: context.args.values["ref"] ?? null,
    waitSeconds: readSeconds(context, "wait", 600),
    dryRun: context.args.booleans.has("dry-run"),
    sleep: deps.sleep,
  });
  emit(context.io, context.json, report, renderPreflight(report));
  return report.verdict === "success" || report.verdict === "dry-run" ? 0 : 1;
}

function enable(context: CommandContext): number {
  const target = resolveTarget(context, true);
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const pool = requirePool(loadRunners(root), requireValue(context.args, "pool", "It names the pool to switch on."));
  if (pool.enableVariable === null) {
    throw new VerbUsageError(`pool '${pool.id}' declares no enableVariable: its jobs are not variable-gated, so there is nothing to enable.`);
  }
  const runRaw = requireValue(context.args, "after-run", "It is the green preflight run 'nen runner preflight' reported; nothing is switched on without one.");
  if (!/^[1-9][0-9]*$/.test(runRaw)) throw new VerbUsageError(`--after-run takes a workflow run id, got '${runRaw}'.`);
  const value = context.args.values["value"] ?? "online";
  if (!VARIABLE_VALUE.test(value)) throw new VerbUsageError(`--value '${value}' is not a value this verb sets: 1 to 32 of a-z, 0-9 and '-'.`);
  const runId = Number.parseInt(runRaw, 10);
  let report: EnableReport;
  try {
    report = enablePool(context.seams, target, { ...pool, enableVariable: pool.enableVariable }, runId, value, context.args.booleans.has("dry-run"));
  } catch (error) {
    // --json names WHICH checks refused the run (#319); the message still goes to stderr at exit 1.
    if (error instanceof CertificationRefusal && context.json) {
      emit(context.io, true, { target: target.slug, pool: pool.id, runId, refused: true, problems: error.problems }, []);
    }
    throw error;
  }
  emit(context.io, context.json, report, renderEnable(report));
  return 0;
}

/** The family, with its wait and version injectable so no test sleeps or pins a release. */
export function makeRunnerCommand(deps: RunnerDeps): Command {
  return {
    name: "runner",
    subcommands: RUNNER_SUBCOMMANDS,
    summary: "Self-hosted runners: inventory, plan, host script, verify, preflight workflow, enable.",
    usage: USAGE,
    flags: { values: VALUE_FLAGS, booleans: BOOLEAN_FLAGS },
    run(context: CommandContext): number {
      const subcommand = requireSubcommand("runner", context.args, RUNNER_SUBCOMMANDS) as Subcommand;
      refuseForeignFlags(context, subcommand);
      try {
        switch (subcommand) {
          case "inventory":
            return inventory(context);
          case "plan":
            return plan(context);
          case "script":
            return script(context, deps);
          case "verify":
            return verify(context, deps);
          case "workflow":
            return workflow(context, deps);
          case "preflight":
            return preflight(context, deps);
          case "enable":
            return enable(context);
        }
      } catch (error) {
        if (error instanceof RunnerFailure) {
          context.io.err(`nen runner ${subcommand}: ${error.message}`);
          return error.exitCode;
        }
        throw error;
      }
    },
  };
}

export const runnerCommand: Command = makeRunnerCommand({ sleep: realSleep, version: VERSION });
