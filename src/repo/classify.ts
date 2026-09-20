// src/repo/classify.ts -- `nen repo classify`: one verdict about what kind of
// repository this is (zheref/nen#216).
//
// FOUR FACTS, EACH FROM ONE SOURCE, NEVER GUESSED.
//   role   -- canon | consumer | unregistered, from `nen/repos.json`: a
//             repository listed under `maintained_tools` is canon (its product
//             is the process; a merge there changes how OTHER repositories
//             behave); one listed under `consumers` or `pending_onboarding`
//             is a consumer; one the registry does not know is unregistered,
//             and that is reported, not rounded to consumer.
//   kind   -- product | process | unknown, from `nen/contract.json`'s lanes:
//             a lane on an application stack makes the repository a product;
//             lanes only on tooling stacks make it a process repository; no
//             `project` block is unknown.
//   stack  -- the default lane's stack, or null.
//   gate   -- G4 for canon, G2 otherwise (the maintainer's ruling of
//             2026-09-18: the gate is the repository's ROLE, not the file's
//             kind), with an unregistered repository reported at G2 and
//             flagged so the caller can ask rather than assume.
//
// THE REGISTRY IS THE CALLER'S. `--repo` names the checkout whose
// `nen/repos.json` is read; the repository being classified is `--target
// <owner/name>`, or the checkout's own `origin` when no target is given.

import { loadContract, type RepositoryContract } from "../schema/contract.js";
import { SchemaError } from "../schema/errors.js";
import { loadRepoRegistry, type RepoRegistry } from "../schema/repos.js";
import type { Seams } from "../seam/exec.js";
import { ownerNameFromRemote } from "./resolve.js";

export const CLASSIFY_CONTRACT = "nen.repo.classify/v0.1";

export type RepoRole = "canon" | "consumer" | "unregistered";
export type RepoKind = "product" | "process" | "unknown";

export interface RepoClassification {
  readonly contract: string;
  readonly target: string;
  readonly role: RepoRole;
  readonly kind: RepoKind;
  readonly stack: string | null;
  readonly lanes: readonly string[];
  /** G4 for canon, G2 for a consumer, null for an unregistered repository -- never a guess. */
  readonly defaultGate: "G2" | "G4" | null;
  readonly sources: {
    readonly role: string;
    readonly kind: string;
  };
  readonly notes: readonly string[];
}

/** Stacks whose presence makes a repository a PRODUCT. The list is nen's own profile pack vocabulary. */
const PRODUCT_STACKS = new Set([
  "xcode-ios",
  "xcode-macos",
  "gradle-android",
  "compose-desktop",
  "dotnet-winui",
  "nextjs",
  "expo",
  "gatsby",
  "react",
  "electron",
]);

export class ClassifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifyError";
  }
}

export function readOrigin(seams: Seams, cwd: string): string {
  const result = seams.run("git", ["remote", "get-url", "origin"], { cwd });
  if (result.spawnFailed || result.code !== 0) {
    throw new ClassifyError(
      `no --target was given and '${cwd}' has no readable 'origin' remote (${result.spawnFailed ? "git could not be started" : result.stderr.trim()}). Name the repository with --target <owner/name>.`,
    );
  }
  const slug = ownerNameFromRemote(result.stdout.trim());
  if (slug === null) throw new ClassifyError(`'${cwd}' has an origin nen cannot read as owner/name: ${result.stdout.trim()}`);
  return slug;
}

function roleOf(registry: RepoRegistry, target: string): { role: RepoRole; source: string } {
  const lower = target.toLowerCase();
  if (registry.maintainedTools.some((repo): boolean => repo.toLowerCase() === lower)) {
    return { role: "canon", source: `${registry.path}: maintained_tools` };
  }
  if (registry.consumers.some((entry): boolean => entry.repo.toLowerCase() === lower)) {
    return { role: "consumer", source: `${registry.path}: consumers` };
  }
  if (registry.pendingOnboarding.some((repo): boolean => repo.toLowerCase() === lower)) {
    return { role: "consumer", source: `${registry.path}: pending_onboarding` };
  }
  return { role: "unregistered", source: `${registry.path}: not listed` };
}

function kindOf(contract: RepositoryContract | null, contractPath: string): { kind: RepoKind; stack: string | null; lanes: string[]; source: string } {
  const project = contract?.project ?? null;
  if (project === null) return { kind: "unknown", stack: null, lanes: [], source: `${contractPath}: no project block` };
  const lanes = Object.keys(project.lanes);
  const stacks = lanes.map((lane): string => project.lanes[lane]?.stack ?? "");
  const defaultLane = project.defaultLane ?? lanes[0] ?? null;
  const stack = defaultLane === null ? null : (project.lanes[defaultLane]?.stack ?? null);
  const product = stacks.some((s): boolean => PRODUCT_STACKS.has(s));
  return {
    kind: lanes.length === 0 ? "unknown" : product ? "product" : "process",
    stack,
    lanes,
    source: `${contractPath}: project.lanes (${stacks.join(", ") || "none"})`,
  };
}

export interface ClassifyOptions {
  readonly seams: Seams;
  /** The checkout whose registry and contract are read. */
  readonly root: string;
  readonly target: string | null;
}

export function classifyRepo(options: ClassifyOptions): RepoClassification {
  const registry = loadRepoRegistry(options.root);
  // WHOSE CONTRACT. The registry answers for any target it lists, but the
  // contract on disk describes THIS checkout and nobody else: reading it for
  // a --target that is not this checkout's origin would report the canon
  // registry's own lanes as a consumer's (Copilot review on zheref/nen#217).
  // So the kind is derived only when the target IS the checkout, which is
  // proved by the origin remote; otherwise it is unknown and the note says
  // where to run the verb instead.
  const notes: string[] = [];
  let origin: string | null = null;
  let originWhy: string | null = null;
  try {
    origin = readOrigin(options.seams, options.root);
  } catch (error) {
    if (options.target === null || !(error instanceof ClassifyError)) throw error;
    originWhy = error.message;
  }
  const target = options.target ?? (origin as string);
  const { role, source: roleSource } = roleOf(registry, target);

  let contract: RepositoryContract | null = null;
  const contractPath = `${options.root}/nen/contract.json`;
  const local = origin !== null && origin === target;
  if (local) {
    try {
      contract = loadContract(options.root);
    } catch (error) {
      if (error instanceof SchemaError && error.message.includes("no such file.")) {
        notes.push("no nen/contract.json: kind and stack are unknown, not defaulted");
      } else {
        throw error;
      }
    }
  } else {
    notes.push(
      origin === null
        ? `kind and stack not derived: this checkout's origin could not be read (${originWhy ?? "unknown"}), so '${target}' cannot be proved to be this checkout and its nen/contract.json is not read for it`
        : `kind and stack not derived: '${target}' is not this checkout (origin '${origin}'), and a contract describes only the checkout it sits in -- run 'nen repo classify' from a checkout of '${target}' for its lanes`,
    );
  }
  const { kind, stack, lanes, source: kindSource } = local
    ? kindOf(contract, contractPath)
    : { kind: "unknown" as const, stack: null, lanes: [], source: "not this checkout: contract not read" };

  if (role === "unregistered") {
    notes.push(
      `'${target}' is not in this registry, so its gate is not derived (null): register it under maintained_tools if its product is the process, or under consumers otherwise, rather than inferring`,
    );
  }
  return {
    contract: CLASSIFY_CONTRACT,
    target,
    role,
    kind,
    stack,
    lanes,
    defaultGate: role === "canon" ? "G4" : role === "consumer" ? "G2" : null,
    sources: { role: roleSource, kind: kindSource },
    notes,
  };
}

export function renderClassification(c: RepoClassification): string[] {
  return [
    `${c.target}: role ${c.role} · kind ${c.kind} · stack ${c.stack ?? "none"} · gate ${c.defaultGate ?? "not derived"}`,
    `  lanes: ${c.lanes.length === 0 ? "none" : c.lanes.join(", ")}`,
    `  role from: ${c.sources.role}`,
    `  kind from: ${c.sources.kind}`,
    ...c.notes.map((note): string => `  note: ${note}`),
  ];
}
