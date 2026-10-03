// src/runner/plan.ts -- `nen runner plan`: which runners to register, where,
// as whom, from which package -- computed, never guessed, and written down
// before anything on the host changes.
//
// PURE OVER TWO INPUTS. The inventory (what GitHub already has, and the
// package it offers today) and the declaration (the pool's labels and root
// defaults). Everything a HUMAN must decide -- the machine code, how many, the
// service identity -- arrives as a flag, and an identity nobody named is
// written `"ask"` rather than defaulted: `runner script` refuses to render a
// plan that still says it.
//
// SLOTS ARE THE LOWEST FREE POSITIVE INTEGERS for this machine and consumer,
// regardless of pool (a runner name is unique per repository, and GitHub
// compares names without regard to case, so this does too). `NZ-NNR1` stays
// `NZ-NNR1` forever; a second run on the same host takes `R4`, never renames.
//
// PATHS ARE WRITTEN IN THE TARGET HOST'S SEPARATORS, not this process's. A
// plan for a Windows pool reads `C:\GithubRunners\nen-runners\Runner1` even
// when it is computed on a Mac -- the script that reads it runs on Windows.
//
// THE PLAN IS A CONTRACT (`nen.runner.plan/v0.2`; a v0.1 plan still reads), because a PROGRAM reads it
// back: `runner script` renders a script that runs elevated on a real machine
// from it. `validatePlan` below is the refusal that contract earns -- every
// field that reaches the script is re-checked against the same shape the
// computation produced, so a hand-edited plan cannot smuggle a quote into a
// PowerShell string.
//
// AN INTERACTIVE PLAN SAYS WHAT IT COSTS (#333). A runner in a desktop session
// is online only while its identity is signed in, and every job it takes runs
// with that account's profile and credentials. The plan states the first in
// every rendering, and when the identity IS the account computing the plan --
// the maintainer's own daily account -- it says so and records
// `dailyAccount: true`, which `runner script` refuses to render without
// `--accept-daily-account`.

import { posix } from "node:path";
import type { Target } from "../github/target.js";
import { renderPipeTable } from "../cli/table.js";
import { VerbUsageError } from "../cli/command.js";
import {
  DEFAULT_RUNNER_MODE,
  poolLabels,
  RUNNER_ARCHES,
  RUNNER_MODES,
  RUNNER_OSES,
  RUNNER_ROOT,
  type RunnerArch,
  type RunnerMode,
  type RunnerOs,
  type RunnerPool,
} from "../schema/workflow.js";
import { RunnerFailure } from "./github.js";
import type { DownloadRow, RunnerRow } from "./inventory.js";

/** v0.2 adds `mode` and `dailyAccount` (#333); a v0.1 plan still reads, as a service plan. */
export const PLAN_CONTRACT = "nen.runner.plan/v0.2";
const PLAN_CONTRACT_V01 = "nen.runner.plan/v0.1";

/** `--machine-code`: one to eight upper-case letters or digits, after upper-casing. */
export const MACHINE_CODE = /^[A-Z0-9]{1,8}$/;
/** A consumer code as the name template can carry it. */
export const CONSUMER_CODE = /^[A-Za-z0-9]+$/;
/** A local Windows account name, bare (no `.\`, no domain, no e-mail). */
export const WINDOWS_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
/** A Linux user `svc.sh install <user>` takes. */
export const LINUX_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
/** The Windows identity that is a built-in account rather than a local user. */
export const NETWORK_SERVICE = "network-service";
export const MAX_COUNT = 16;
/**
 * Built-in Windows identities with no interactive logon, lower-cased. Whether a
 * named local account exists, is enabled, or holds "Allow log on locally" is
 * the host's to answer: the rendered script checks the first two.
 */
export const BUILT_IN_IDENTITIES: readonly string[] = ["system", "localsystem", "localservice", "networkservice", NETWORK_SERVICE];

/** The built-in root per runner-host OS, when neither --root nor the pool names one. */
export const DEFAULT_ROOTS: Readonly<Record<RunnerOs, string>> = {
  Windows: "C:\\GithubRunners",
  Linux: "/opt/actions-runners",
  macOS: "~/actions-runners",
};

/** The pool's `root` key for a runner-host OS, and the `process.platform` that is that OS. */
const HOST_KEY: Readonly<Record<RunnerOs, "windows" | "linux" | "darwin">> = {
  Windows: "windows",
  Linux: "linux",
  macOS: "darwin",
};
const PLATFORM_OF: Readonly<Record<RunnerOs, NodeJS.Platform>> = {
  Windows: "win32",
  Linux: "linux",
  macOS: "darwin",
};

/** The downloads API's own spellings for a pool's os and arch. */
export const DOWNLOAD_OS: Readonly<Record<RunnerOs, string>> = { Windows: "win", Linux: "linux", macOS: "osx" };
export const DOWNLOAD_ARCH: Readonly<Record<RunnerArch, string>> = { X64: "x64", ARM64: "arm64" };

export interface PlannedRunner {
  readonly slot: number;
  readonly name: string;
  readonly installDir: string;
  readonly serviceName: string;
}

export interface RunnerPlan {
  readonly contract: typeof PLAN_CONTRACT;
  readonly target: string;
  readonly pool: string;
  readonly os: RunnerOs;
  readonly arch: RunnerArch;
  /** The pool's mode: `interactive` on Windows renders a logon task, never a service. */
  readonly mode: RunnerMode;
  readonly labels: readonly string[];
  readonly machineCode: string;
  readonly consumerCode: string;
  readonly root: string;
  readonly projectDir: string;
  /**
   * Windows: `.\<account>` or `network-service`; Linux: the user `svc.sh
   * install` takes; macOS: `invoking-user` (a LaunchAgent runs as whoever
   * installs it). `ask` when nobody named one -- `runner script` refuses it.
   */
  readonly identity: string;
  /**
   * True when an interactive Windows plan's identity is the account that
   * computed it -- the maintainer's own daily account. `runner script` refuses
   * such a plan without `--accept-daily-account`.
   */
  readonly dailyAccount: boolean;
  readonly runnerVersion: string;
  readonly download: DownloadRow;
  readonly runners: readonly PlannedRunner[];
  /** Names already registered for this machine and consumer, in slot order. */
  readonly existing: readonly string[];
}

export interface PlanInputs {
  readonly target: Target;
  readonly pool: RunnerPool;
  readonly machineCode: string;
  readonly consumerCode: string;
  readonly count: number;
  readonly root: string | null;
  readonly serviceAccount: string | null;
  readonly runners: readonly RunnerRow[];
  readonly downloads: readonly DownloadRow[];
  /** For `~` expansion: which host this process is, and its environment. */
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The consumer code: the flag, else the one `product_codes` key naming --target. */
export function resolveConsumerCode(
  flag: string | null,
  productCodes: Readonly<Record<string, string>>,
  target: Target,
): string {
  if (flag !== null) {
    if (!CONSUMER_CODE.test(flag)) {
      throw new VerbUsageError(`--consumer-code '${flag}' is not a code a runner name can carry: letters and digits only.`);
    }
    return flag;
  }
  const matches = Object.entries(productCodes)
    .filter(([, slug]): boolean => slug.toLowerCase() === target.slug.toLowerCase())
    .map(([code]): string => code);
  if (matches.length === 1 && CONSUMER_CODE.test(matches[0] as string)) return matches[0] as string;
  throw new VerbUsageError(
    matches.length === 0
      ? `no key of nen/repos.json's product_codes names ${target.slug}, so there is no consumer code to name its runners by. Pass --consumer-code <CODE>.`
      : `${matches.length} product_codes keys name ${target.slug} (${matches.join(", ")}), and nen does not pick one. Pass --consumer-code <CODE>.`,
  );
}

export function normalizeMachineCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!MACHINE_CODE.test(code)) {
    throw new VerbUsageError(`--machine-code '${raw}' is not a machine code: one to eight letters or digits (it is upper-cased), e.g. NZ.`);
  }
  return code;
}

/** The identity a plan stores, from `--service-account`, the pool's OS and its mode. */
export function resolveIdentity(os: RunnerOs, flag: string | null, mode: RunnerMode = DEFAULT_RUNNER_MODE[os]): string {
  if (os === "macOS") {
    if (flag !== null) {
      throw new VerbUsageError(
        "--service-account does not apply to a macOS pool: a macOS runner is a launchd LaunchAgent that runs as the user who installs it, so there is no account to name. Drop the flag.",
      );
    }
    return "invoking-user";
  }
  if (flag === null) return "ask";
  if (os === "Windows") {
    const interactive = mode === "interactive";
    if (flag === NETWORK_SERVICE) {
      if (interactive) {
        throw new VerbUsageError(
          `--service-account ${NETWORK_SERVICE} cannot log on interactively: it is a built-in service identity with no desktop session, so an interactive pool's logon task would never fire. Name the LOCAL account whose desktop session the runner should run in (e.g. kwi-desktop).`,
        );
      }
      return NETWORK_SERVICE;
    }
    const bare = flag.startsWith(".\\") ? flag.slice(2) : flag;
    if (interactive && BUILT_IN_IDENTITIES.includes(bare.toLowerCase())) {
      throw new VerbUsageError(
        `--service-account '${flag}' is a built-in service identity, and it cannot log on interactively: it has no desktop session, so an interactive pool's logon task would never fire. Name the LOCAL account whose desktop session the runner should run in.`,
      );
    }
    if (bare.includes("@") || bare.includes("\\")) {
      throw new VerbUsageError(
        interactive
          ? `--service-account '${flag}' is not a local account name. An interactive pool's logon task is registered for a local account on the runner host; for a Microsoft (e-mail) account, name the local account Windows created for it (the part after the backslash in 'whoami'), without '.\\'.`
          : `--service-account '${flag}' is not a local account. A Windows runner service logs on with a LOCAL account's password; a Microsoft (e-mail) account or a domain account cannot be that logon. Name a local account without '.\\' (e.g. lordzheref), or '${NETWORK_SERVICE}' by explicit choice.`,
      );
    }
    if (!WINDOWS_ACCOUNT.test(bare)) {
      throw new VerbUsageError(`--service-account '${flag}' is not a local account name: letters, digits, '.', '_' and '-', at most 20 characters.`);
    }
    return `.\\${bare}`;
  }
  if (!LINUX_USER.test(flag) || flag === "root") {
    throw new VerbUsageError(
      flag === "root"
        ? "--service-account root is refused: the runner's config.sh refuses to run as root, and a runner service running as root runs every job as root. Name an unprivileged user."
        : `--service-account '${flag}' is not a Linux user name svc.sh can install a service for.`,
    );
  }
  return flag;
}

/** The root, with `~` expanded on the host it will be used on, in that host's separators. */
export function resolveRoot(inputs: Pick<PlanInputs, "pool" | "root" | "platform" | "env">): string {
  const { pool } = inputs;
  const source = inputs.root !== null ? "--root" : pool.root[HOST_KEY[pool.os]] !== null ? `the pool's root.${HOST_KEY[pool.os]}` : "the built-in default";
  let root = inputs.root ?? pool.root[HOST_KEY[pool.os]] ?? DEFAULT_ROOTS[pool.os];
  if (!RUNNER_ROOT.test(root)) {
    throw new VerbUsageError(
      `${source} '${root}' is not a root nen can render into a host script: letters, digits, spaces, and . _ : \\ / ~ ( ) - only.`,
    );
  }
  if (root === "~" || root.startsWith("~/") || root.startsWith("~\\")) {
    const home = inputs.platform === PLATFORM_OF[pool.os] ? (inputs.env["HOME"] ?? inputs.env["USERPROFILE"] ?? null) : null;
    if (home === null || home === "" || !RUNNER_ROOT.test(home)) {
      throw new VerbUsageError(
        `${source} '${root}' starts with '~', and this process cannot expand it for a ${pool.os} host${
          inputs.platform === PLATFORM_OF[pool.os] ? " (no usable HOME)" : ` from ${inputs.platform}`
        }. Pass --root with an absolute path on the runner host.`,
      );
    }
    root = `${home}${root.slice(1)}`;
  }
  if (pool.os === "Windows") {
    root = root.replace(/\//g, "\\").replace(/\\+$/, "");
    if (!/^[A-Za-z]:\\/.test(`${root}\\`)) {
      throw new VerbUsageError(`${source} '${root}' is not an absolute Windows path (e.g. C:\\GithubRunners).`);
    }
  } else {
    root = root.replace(/\/+$/, "") || "/";
    if (!posix.isAbsolute(root)) {
      throw new VerbUsageError(`${source} '${root}' is not an absolute path on a ${pool.os} host (e.g. ${DEFAULT_ROOTS.Linux}).`);
    }
  }
  return root;
}

function join(os: RunnerOs, ...parts: string[]): string {
  const separator = os === "Windows" ? "\\" : "/";
  return parts.join(separator).replace(os === "Windows" ? /\\{2,}/g : /\/{2,}/g, separator);
}

/** `actions-runner-win-x64-2.337.0.zip` -> `2.337.0`. */
export function runnerVersionOf(filename: string): string | null {
  return /-(\d+\.\d+\.\d+)\.(?:zip|tar\.gz)$/.exec(filename)?.[1] ?? null;
}

/**
 * Whether an interactive Windows identity is the account computing this plan.
 * Only a Windows process can tell (USERNAME is that host's sign-in name); a plan
 * computed elsewhere for a Windows host says false, and the rendered plan says
 * the check was not possible.
 */
export function isDailyAccount(
  os: RunnerOs,
  mode: RunnerMode,
  identity: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (os !== "Windows" || mode !== "interactive" || platform !== "win32" || !identity.startsWith(".\\")) return false;
  const me = env["USERNAME"];
  return me !== undefined && me !== "" && me.toLowerCase() === identity.slice(2).toLowerCase();
}

export function computePlan(inputs: PlanInputs): RunnerPlan {
  const { target, pool, machineCode, consumerCode, count } = inputs;
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new VerbUsageError(`--count must be a whole number from 1 to ${MAX_COUNT}; got ${count}.`);
  }
  const download = inputs.downloads.find(
    (row): boolean => row.os === DOWNLOAD_OS[pool.os] && row.architecture === DOWNLOAD_ARCH[pool.arch],
  );
  if (download === undefined) {
    throw new RunnerFailure(
      1,
      `GitHub offers ${target.slug} no runner package for ${pool.os} ${pool.arch} (os '${DOWNLOAD_OS[pool.os]}', architecture '${DOWNLOAD_ARCH[pool.arch]}' in the downloads list), so pool '${pool.id}' cannot be provisioned from it.`,
    );
  }
  const runnerVersion = runnerVersionOf(download.filename);
  if (runnerVersion === null || !/^[0-9a-f]{64}$/i.test(download.sha256_checksum) || !download.download_url.startsWith("https://")) {
    throw new RunnerFailure(1, `the ${pool.os} ${pool.arch} download row on ${target.slug} is not one this verb can plan from: ${JSON.stringify(download)}.`);
  }

  const mine = inputs.runners.filter(
    (runner): boolean =>
      runner.machine !== null &&
      runner.consumer !== null &&
      runner.machine.toUpperCase() === machineCode &&
      runner.consumer.toLowerCase() === consumerCode.toLowerCase(),
  );
  const used = new Set(mine.map((runner): number => runner.slot as number));
  const slots: number[] = [];
  for (let slot = 1; slots.length < count; slot += 1) if (!used.has(slot)) slots.push(slot);

  const root = resolveRoot(inputs);
  const projectDir = join(pool.os, root, `${target.repo}-runners`);
  const taken = new Set(inputs.runners.map((runner): string => runner.name.toLowerCase()));
  const runners = slots.map((slot): PlannedRunner => {
    const name = `${machineCode}-${consumerCode}R${slot}`;
    if (taken.has(name.toLowerCase())) {
      throw new RunnerFailure(1, `'${name}' is already registered on ${target.slug}; a runner name is unique per repository and nen never plans over one.`);
    }
    return {
      slot,
      name,
      installDir: join(pool.os, projectDir, `Runner${slot}`),
      serviceName: `actions.runner.${target.owner}-${target.repo}.${name}`,
    };
  });

  const identity = resolveIdentity(pool.os, inputs.serviceAccount, pool.mode);
  return {
    contract: PLAN_CONTRACT,
    target: target.slug,
    pool: pool.id,
    os: pool.os,
    arch: pool.arch,
    mode: pool.mode,
    labels: pool.labels,
    machineCode,
    consumerCode,
    root,
    projectDir,
    identity,
    dailyAccount: isDailyAccount(pool.os, pool.mode, identity, inputs.platform, inputs.env),
    runnerVersion,
    download,
    runners,
    existing: [...mine].sort((a, b): number => (a.slot as number) - (b.slot as number)).map((runner): string => runner.name),
  };
}

/** Whether the plan renders a Windows logon task rather than a service. */
export function isLogonTask(plan: Pick<RunnerPlan, "os" | "mode">): boolean {
  return plan.os === "Windows" && plan.mode === "interactive";
}

/** What an interactive plan costs, said in every rendering of it. Empty for a service plan. */
export function interactiveNotes(plan: RunnerPlan): string[] {
  if (!isLogonTask(plan)) return [];
  const who = plan.identity === "ask" ? "the identity" : plan.identity;
  return [
    `note: an interactive runner is online only while ${who} is signed in to the desktop (or auto-logged on); nen never configures auto-logon.`,
    `note: a UI job needs that session active and unlocked, and the run.cmd console window open; a locked screen or a disconnected session still reports a non-zero session id.`,
    `note: every job it takes runs in ${who}'s desktop session, with that account's profile and credentials -- not only the jobs asking for 'desktop': a runner carrying [self-hosted, ${plan.os}, ${plan.arch}, desktop] also matches every job aimed at [self-hosted, ${plan.os}, ${plan.arch}] on ${plan.target}.`,
    plan.dailyAccount
      ? `warning: ${plan.identity} is the account computing this plan -- your own daily account. Its jobs would run with your profile and your credentials. Prefer a dedicated local account; 'nen runner script' renders this plan only with --accept-daily-account.`
      : "note: use a dedicated local account, never your daily one. nen can only tell them apart when the plan is computed on Windows (it compares USERNAME).",
  ];
}

export function renderPlan(plan: RunnerPlan): string[] {
  return [
    `plan: ${plan.runners.length} runner(s) for ${plan.target}, pool ${plan.pool}`,
    `labels: ${plan.labels.join(",")}`,
    `mode: ${plan.mode}${isLogonTask(plan) ? " -- a Scheduled Task at the identity's logon starts run.cmd in its desktop session; no service is installed" : ""}`,
    `identity: ${plan.identity}${plan.identity === "ask" ? ` -- pass --service-account before rendering a script` : ""}`,
    ...interactiveNotes(plan),
    `download: ${plan.download.filename} (runner ${plan.runnerVersion}, sha256 ${plan.download.sha256_checksum})`,
    `project dir: ${plan.projectDir}`,
    ...renderPipeTable([
      ["slot", "name", "install dir", isLogonTask(plan) ? "logon task" : plan.os === "macOS" ? "launch agent" : "service"],
      ...plan.runners.map((runner): string[] => [String(runner.slot), runner.name, runner.installDir, runner.serviceName]),
    ]),
    `already registered for ${plan.machineCode}/${plan.consumerCode}: ${plan.existing.length === 0 ? "(none)" : plan.existing.join(", ")}`,
  ];
}

// ── reading a plan back (the contract's refusal) ────────────────────────────

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const POOL_ID = /^[a-z][a-z0-9-]*$/;

/**
 * A plan file, re-checked field by field against the shape `computePlan`
 * produces. Every refusal is a usage error (exit 2): the caller pointed the
 * verb at a file that is not a plan this build wrote, and no retry fixes that.
 */
export function validatePlan(value: unknown, source: string): RunnerPlan {
  const bad = (what: string): never => {
    throw new VerbUsageError(`${source} is not a runner plan this build can render (${what}). Re-run 'nen runner plan --out' rather than editing one by hand.`);
  };
  const plan = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : bad("not a JSON object");
  const v01 = plan["contract"] === PLAN_CONTRACT_V01;
  if (plan["contract"] !== PLAN_CONTRACT && !v01) bad(`contract is ${JSON.stringify(plan["contract"])}, expected '${PLAN_CONTRACT}'`);
  const str = (key: string, pattern: RegExp): string => {
    const field = plan[key];
    if (typeof field !== "string" || !pattern.test(field)) bad(`'${key}' is ${JSON.stringify(field)}`);
    return field as string;
  };
  const target = str("target", SLUG);
  const pool = str("pool", POOL_ID);
  const os = plan["os"];
  const arch = plan["arch"];
  if (!(RUNNER_OSES as readonly unknown[]).includes(os)) bad(`'os' is ${JSON.stringify(os)}`);
  if (!(RUNNER_ARCHES as readonly unknown[]).includes(arch)) bad(`'arch' is ${JSON.stringify(arch)}`);
  const runnerOs = os as RunnerOs;
  const runnerArch = arch as RunnerArch;
  // A v0.1 plan predates `mode`: it was a service plan (a LaunchAgent on macOS).
  const modeRaw = v01 ? DEFAULT_RUNNER_MODE[runnerOs] : plan["mode"];
  if (!(RUNNER_MODES as readonly unknown[]).includes(modeRaw)) bad(`'mode' is ${JSON.stringify(modeRaw)}`);
  const mode = modeRaw as RunnerMode;
  if (mode !== DEFAULT_RUNNER_MODE[runnerOs] && runnerOs !== "Windows") bad(`'mode' is '${mode}' for a ${runnerOs} pool`);
  const expectedLabels = poolLabels(runnerOs, runnerArch, mode);
  const labels = plan["labels"];
  if (!Array.isArray(labels) || labels.join(",") !== expectedLabels.join(",")) {
    bad(`'labels' is ${JSON.stringify(labels)}, expected ${JSON.stringify(expectedLabels)}`);
  }
  const dailyRaw = v01 ? false : plan["dailyAccount"];
  if (typeof dailyRaw !== "boolean" || (dailyRaw && !isLogonTask({ os: runnerOs, mode }))) {
    bad(`'dailyAccount' is ${JSON.stringify(dailyRaw)} for a ${mode} ${runnerOs} pool`);
  }
  const machineCode = str("machineCode", MACHINE_CODE);
  const consumerCode = str("consumerCode", CONSUMER_CODE);
  const root = str("root", RUNNER_ROOT);
  const projectDir = str("projectDir", RUNNER_ROOT);
  const identity = plan["identity"];
  const identityOk =
    typeof identity === "string" &&
    (identity === "ask" ||
      (runnerOs === "Windows" &&
        ((identity === NETWORK_SERVICE && mode === "service") || (identity.startsWith(".\\") && WINDOWS_ACCOUNT.test(identity.slice(2))))) ||
      (runnerOs === "Linux" && LINUX_USER.test(identity) && identity !== "root") ||
      (runnerOs === "macOS" && identity === "invoking-user"));
  if (!identityOk) bad(`'identity' is ${JSON.stringify(identity)} for a ${runnerOs} pool`);
  const runnerVersion = str("runnerVersion", /^\d+\.\d+\.\d+$/);
  const downloadRaw = plan["download"];
  const download = downloadRaw !== null && typeof downloadRaw === "object" ? (downloadRaw as Record<string, unknown>) : bad("'download' is not an object");
  const expectedName = new RegExp(
    `^actions-runner-${DOWNLOAD_OS[runnerOs]}-${DOWNLOAD_ARCH[runnerArch]}-${runnerVersion.replace(/\./g, "\\.")}\\.${runnerOs === "Windows" ? "zip" : "tar\\.gz"}$`,
  );
  const filename = download["filename"];
  if (typeof filename !== "string" || !expectedName.test(filename)) bad(`'download.filename' is ${JSON.stringify(filename)}`);
  const url = download["download_url"];
  if (typeof url !== "string" || url !== `https://github.com/actions/runner/releases/download/v${runnerVersion}/${filename as string}`) {
    bad(`'download.download_url' is ${JSON.stringify(url)}, not the actions/runner release asset for ${String(filename)}`);
  }
  const sha = download["sha256_checksum"];
  if (typeof sha !== "string" || !/^[0-9a-f]{64}$/i.test(sha)) bad(`'download.sha256_checksum' is ${JSON.stringify(sha)}`);
  const runnersRaw = plan["runners"];
  if (!Array.isArray(runnersRaw) || runnersRaw.length === 0 || runnersRaw.length > MAX_COUNT) bad("'runners' is not a list of 1 to 16 runners");
  const [owner, repo] = target.split("/") as [string, string];
  const separator = runnerOs === "Windows" ? "\\" : "/";
  const runners = (runnersRaw as unknown[]).map((entry, index): PlannedRunner => {
    const row = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : bad(`runners[${index}] is not an object`);
    const slot = row["slot"];
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1) bad(`runners[${index}].slot is ${JSON.stringify(slot)}`);
    const name = `${machineCode}-${consumerCode}R${slot as number}`;
    if (row["name"] !== name) bad(`runners[${index}].name is ${JSON.stringify(row["name"])}, expected '${name}'`);
    const installDir = `${projectDir}${separator}Runner${slot as number}`;
    if (row["installDir"] !== installDir) bad(`runners[${index}].installDir is ${JSON.stringify(row["installDir"])}, expected '${installDir}'`);
    const serviceName = `actions.runner.${owner}-${repo}.${name}`;
    if (row["serviceName"] !== serviceName) bad(`runners[${index}].serviceName is ${JSON.stringify(row["serviceName"])}`);
    return { slot: slot as number, name, installDir, serviceName };
  });
  if (projectDir !== `${root}${separator}${repo}-runners`) bad(`'projectDir' is not '<root>${separator}${repo}-runners'`);
  const existing = Array.isArray(plan["existing"]) ? plan["existing"].filter((name): name is string => typeof name === "string") : [];
  return {
    contract: PLAN_CONTRACT,
    target,
    pool,
    os: runnerOs,
    arch: runnerArch,
    mode,
    labels: expectedLabels,
    machineCode,
    consumerCode,
    root,
    projectDir,
    identity: identity as string,
    dailyAccount: dailyRaw as boolean,
    runnerVersion,
    download: {
      os: DOWNLOAD_OS[runnerOs],
      architecture: DOWNLOAD_ARCH[runnerArch],
      filename: filename as string,
      download_url: url as string,
      sha256_checksum: (sha as string).toLowerCase(),
    },
    runners,
    existing,
  };
}
