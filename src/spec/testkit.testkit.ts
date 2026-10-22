// src/spec/testkit.testkit.ts -- shared capture for the spec family's tests.
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { specCommand } from "./command.js";

export const FIXTURE_REPO = join(process.cwd(), "src", "spec", "fixtures", "spec-repo");
export const VOCABULARY = join(process.cwd(), "src", "spec", "fixtures", "vocabulary.txt");

export interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly json: () => Record<string, unknown>;
}

export async function spec(argv: readonly string[], repo: string | null, seams: Seams, json = false): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => { out.push(line); }, err: (line): void => { err.push(line); } };
  const code = await runFamily(specCommand, ["spec", ...argv], repo, json, io, seams);
  return { code, out, err, json: (): Record<string, unknown> => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

/** A writable copy of the fixture spec repository. */
export function fixtureCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "nen-spec-"));
  cpSync(FIXTURE_REPO, root, { recursive: true });
  return root;
}
