// src/runner/testkit.ts -- the fixtures every runner test shares:
// the recorded API answers, the declared pools, and a scripted gh.
//
// TEST-ONLY: vitest collects `*.test.ts` only, and no shipped module
// imports this one (./command.ts and its siblings never do).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Target } from "../github/target.js";
import { parseRunners, type RunnerPool } from "../schema/workflow.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { downloadsArgv, fetchDownloads, fetchRunners, runnersArgv } from "./inventory.js";
import { windowsServicesArgv } from "./neighbours.js";
import { computePlan, type RunnerPlan } from "./plan.js";

export const FIXTURES = join(process.cwd(), "src", "runner", "fixtures");
export const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

export const RUNNERS_JSON = readFileSync(join(FIXTURES, "runners.json"), "utf8");
export const DOWNLOADS_JSON = readFileSync(join(FIXTURES, "downloads.json"), "utf8");

const ROOT = { windows: "C:\\GithubRunners", linux: "/opt/actions-runners", darwin: "~/actions-runners" };

export const POLICY_BODY = {
  naming: "{machine}-{consumer}R{slot}",
  pools: [
    {
      id: "windows-x64",
      os: "Windows",
      arch: "X64",
      labels: ["self-hosted", "Windows", "X64"],
      enableVariable: "NEN_WINDOWS_RUNNER",
      tools: ["git", "bash", "gh"],
      preflightWorkflow: "runner-preflight-windows-x64.yml",
      root: ROOT,
    },
    {
      id: "macos-arm64",
      os: "macOS",
      arch: "ARM64",
      labels: ["self-hosted", "macOS", "ARM64"],
      tools: ["git", "bash", "gh"],
      preflightWorkflow: "runner-preflight-macos-arm64.yml",
      root: ROOT,
    },
    {
      id: "linux-x64",
      os: "Linux",
      arch: "X64",
      labels: ["self-hosted", "Linux", "X64"],
      enableVariable: "NEN_LINUX_RUNNER",
      tools: ["git", "bash", "gh", "curl"],
      preflightWorkflow: "runner-preflight-linux-x64.yml",
      root: ROOT,
    },
  ],
};

export const POLICY = parseRunners("<fixture>", POLICY_BODY);

/** An interactive Windows pool (#333), kept out of POLICY so the recorded inventory's pool rows stay as they are. */
export const DESKTOP_POOL_BODY = {
  id: "windows-x64-desktop",
  os: "Windows",
  arch: "X64",
  mode: "interactive",
  labels: ["self-hosted", "Windows", "X64", "desktop"],
  enableVariable: "KWI_DESKTOP_RUNNER",
  tools: ["git", "bash", "gh"],
  preflightWorkflow: "runner-preflight-windows-x64-desktop.yml",
  root: ROOT,
};
const DESKTOP_POLICY = parseRunners("<fixture>", { pools: [DESKTOP_POOL_BODY] });

export function pool(id: string): RunnerPool {
  const found = [...(POLICY?.pools ?? []), ...(DESKTOP_POLICY?.pools ?? [])].find((candidate): boolean => candidate.id === id);
  if (found === undefined) throw new Error(`no fixture pool ${id}`);
  return found;
}

/** The two inventory reads, answered from the recorded fixtures. */
export function inventoryCalls(runnersJson = RUNNERS_JSON, downloadsJson = DOWNLOADS_JSON): ScriptedCall[] {
  return [
    { match: `gh ${runnersArgv(TARGET, 1).join(" ")}`, result: { stdout: runnersJson } },
    { match: `gh ${downloadsArgv(TARGET).join(" ")}`, result: { stdout: downloadsJson } },
  ];
}

/** This host's runner services as `runner plan` reads them on Windows (#330); none by default. */
export function windowsServicesCall(services: readonly { Name: string; StartName: string; Sid?: string }[] = []): ScriptedCall {
  return {
    match: `powershell ${windowsServicesArgv().join(" ")}`,
    result: { stdout: services.length === 0 ? "" : JSON.stringify(services.length === 1 ? services[0] : services) },
  };
}

/** A runners answer built from rows, for the cases the recording does not cover. */
export function runnersAnswer(rows: readonly { name: string; status?: string; busy?: boolean; labels?: readonly string[] }[]): string {
  return JSON.stringify({
    total_count: rows.length,
    runners: rows.map((row, index) => ({
      id: 100 + index,
      name: row.name,
      os: "Windows",
      status: row.status ?? "online",
      busy: row.busy ?? false,
      labels: (row.labels ?? ["self-hosted", "Windows", "X64"]).map((name) => ({ id: 0, name, type: "read-only" })),
    })),
  });
}

/** Normalize a golden file's line endings: a `text=auto` Windows checkout hands back CRLF. */
export function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** A plan computed from the recorded inventory: NZ, NN, 3 runners, per pool. */
export function planFor(
  poolId: string,
  overrides: { serviceAccount?: string | null; count?: number; env?: Readonly<Record<string, string>> } = {},
): RunnerPlan {
  const seams = new ScriptedSeams(inventoryCalls());
  const chosen = pool(poolId);
  return computePlan({
    target: TARGET,
    pool: chosen,
    machineCode: "NZ",
    consumerCode: "NN",
    count: overrides.count ?? 3,
    root: null,
    serviceAccount: overrides.serviceAccount === undefined ? (chosen.os === "macOS" ? null : chosen.os === "Windows" ? "lordzheref" : "runner") : overrides.serviceAccount,
    runners: fetchRunners(seams, TARGET),
    downloads: fetchDownloads(seams, TARGET),
    platform: chosen.os === "macOS" ? "darwin" : "win32",
    env: overrides.env ?? { HOME: "/Users/runner-host" },
  });
}
