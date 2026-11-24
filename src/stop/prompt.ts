import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { GIT, type Seams } from "../seam/exec.js";
import { realContainment } from "../repo/contain.js";
import { assertEffortId, encodeEffortId } from "../ledger/effort.js";
import { VerbUsageError } from "../cli/command.js";

const PROMPT_CONTRACT = "nen.stop.prompt/v0.1";

export interface PromptIdentity { readonly effort: string; readonly pr: number; readonly head: string; readonly gate: string }
export type PromptRead = { readonly ok: true; readonly present: boolean; readonly where: string | null } | { readonly ok: false; readonly reason: string };
function state(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function location(seams: Seams, root: string, identity: PromptIdentity): string {
  assertEffortId(identity.effort);
  if (!Number.isSafeInteger(identity.pr) || identity.pr <= 0 || !/^[a-f0-9]{40}$/i.test(identity.head) || !["G2", "G4"].includes(identity.gate)) throw new VerbUsageError("prompt identity needs effort, positive PR, full judged head and G2/G4 gate");
  const read = seams.run(GIT, ["rev-parse", "--git-common-dir"], {
    cwd: root,
    env: { GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined },
  });
  if (read.code !== 0 || read.spawnFailed || !read.stdout.trim() || read.stdout.trim().includes("\n")) throw new Error("git common directory unreadable");
  const common = isAbsolute(read.stdout.trim()) ? read.stdout.trim() : resolve(root, read.stdout.trim());
  const path = join(common, ".nen", "prompts", encodeEffortId(identity.effort), `${identity.pr}-${identity.head.toLowerCase()}-${identity.gate}.json`);
  const containment = realContainment(common, path);
  if (!containment.contained || containment.link !== null || (state(path)?.isSymbolicLink())) throw new Error(`prompt receipt redirected: ${path}`);
  return path;
}
export function readPrompt(seams: Seams, root: string, identity: PromptIdentity): PromptRead {
  try {
    const path = location(seams, root, identity);
    if (state(path) === null) return { ok: false, reason: `prompt receipt missing: ${path}` };
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!raw || raw["contract"] !== PROMPT_CONTRACT || raw["effort"] !== identity.effort || raw["pr"] !== identity.pr || raw["head"] !== identity.head.toLowerCase() || raw["gate"] !== identity.gate || raw["shown"] !== true || typeof raw["at"] !== "string" || Number.isNaN(Date.parse(raw["at"]))) throw new Error(`prompt receipt malformed or mismatched: ${path}`);
    return { ok: true, present: true, where: path };
  } catch (error) { return { ok: false, reason: String(error) }; }
}
export function recordPrompt(seams: Seams, root: string, identity: PromptIdentity): string {
  const path = location(seams, root, identity);
  if (state(path) !== null) {
    const read = readPrompt(seams, root, identity);
    if (!read.ok) throw new Error(read.reason);
    return path;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ contract: PROMPT_CONTRACT, ...identity, head: identity.head.toLowerCase(), shown: true, at: seams.now().toISOString() }) + "\n", { flag: "wx" });
  return path;
}
