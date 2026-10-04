// src/classify/fixtures/harness.ts -- test support for the `nen classify` suites.
//
// TEST SUPPORT ONLY. It lives under `fixtures/` so the taxonomy-purity sweep and
// eslint skip it (src/schema/fixtures/paths.ts is the precedent), and nothing
// shipped imports it. It names the fixture vocabulary freely: that is the point
// of a fixture. Paths are built from process.cwd(), never import.meta.url.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../../index.js";
import type { CommandResult } from "../../seam/exec.js";
import { ScriptedSeams, type ScriptedCall } from "../../seam/scripted.js";
import { classifyCommand } from "../command.js";

const FIXTURES = join(process.cwd(), "src", "classify", "fixtures");

/** A two-and-two taxonomy, small enough to script every gh call by hand. */
export const MINI = join(FIXTURES, "mini.taxonomy.json");
/** A snapshot of the governance taxonomy (see its $comment for source and date), copied verbatim. */
export const REAL = join(FIXTURES, "classify.taxonomy.json");
export const PARTIAL_REPO = join(FIXTURES, "repo-partial");
export const EXPECTED_AFTER_WRITE = join(FIXTURES, "repo-partial", "expected-after-write.json");

export const SLUG = "zheref/nen";

/** Loosely typed JSON, so a test can reach into and break a fixture without a cast per access. */
export type Json = Record<string, any>;

export function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

/** The MINI taxonomy, parsed, handed to `edit`, written to a temp file; returns its path. */
export function mutatedTaxonomy(edit: (value: Json) => void): string {
  const value = readJson(MINI);
  edit(value);
  const dir = mkdtempSync(join(tmpdir(), "nen-classify-tax-"));
  const path = join(dir, "taxonomy.json");
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

/** A temp checkout whose nen/labels.json holds `labels` (verbatim JSON when a string). */
export function tmpRepo(labels: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-classify-repo-"));
  mkdirSync(join(dir, "nen"));
  writeFileSync(join(dir, "nen", "labels.json"), typeof labels === "string" ? labels : JSON.stringify(labels, null, 2));
  return dir;
}

/** A writable copy of the partial-declaration fixture repository. */
export function copyPartialRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-classify-partial-"));
  cpSync(join(PARTIAL_REPO, "nen"), join(dir, "nen"), { recursive: true });
  return dir;
}

export interface Declared {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

/** Every MINI label, correctly declared -- the "already landed" consumer. */
export const MINI_LABELS: readonly Declared[] = [
  { name: "lang/alpha", color: "1d76db", description: "Needs alpha" },
  { name: "lang/beta", color: "1d76db", description: "Needs beta" },
  { name: "job/build", color: "5319e7", description: "Building the thing" },
  { name: "job/test", color: "5319e7", description: "Testing the thing" },
];

export function landedRepo(extra: readonly Declared[] = []): string {
  return tmpRepo({ labels: [...MINI_LABELS, ...extra] });
}

export interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly seams: ScriptedSeams;
}

export async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  repoFlag: string | null = null,
  /** Called with every subprocess argv just BEFORE it is answered -- how a test sees ordering. */
  observe: (command: string, args: readonly string[]) => void = (): void => {},
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const seams = new ScriptedSeams(script, { now: (): Date => new Date("2026-10-04T12:00:00Z") });
  const answer = seams.run;
  seams.run = (command, args, options): CommandResult => {
    observe(command, args);
    return answer(command, args, options);
  };
  const code = await runFamily(classifyCommand, argv, repoFlag, false, io, seams);
  return { code, out, err, seams };
}

/** A gh call's key as ScriptedSeams matches it. */
export function gh(...args: readonly string[]): string {
  return `gh ${args.join(" ")}`;
}

/** The scripted answer to `gh api repos/<slug>/issues/<n>`. */
export function issueCall(number: number, labels: readonly string[], extra: Record<string, unknown> = {}): ScriptedCall {
  return {
    match: gh("api", `repos/${SLUG}/issues/${number}`),
    result: {
      stdout: JSON.stringify({
        number,
        id: 1000 + number,
        title: `Issue ${number}`,
        state: "open",
        labels: labels.map((name): { name: string } => ({ name })),
        ...extra,
      }),
    },
  };
}
