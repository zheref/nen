import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { repoCommand } from "./command.js";

const ORIGIN_BANKAI: CommandResult = { code: 0, stdout: "git@github.com:zheref/bankai-scaffold.git\n", stderr: "", spawnFailed: false };

function seams(origin: CommandResult | null): Seams {
  return {
    run: (bin, args): CommandResult => {
      if (bin === "git" && args[0] === "remote") return origin ?? { code: 128, stdout: "", stderr: "fatal: No such remote 'origin'", spawnFailed: false };
      throw new Error(`unexpected spawn: ${bin} ${args.join(" ")}`);
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("no watched form");
    },
    platform: "linux",
  };
}

async function capture(argv: readonly string[], repo: string, s: Seams, json = false): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l): void => { out.push(l); }, err: (l): void => { err.push(l); } };
  const code = await runFamily(repoCommand, argv, repo, json, io, s);
  return { code, out, err };
}

describe("nen repo classify (zheref/nen#216)", () => {
  it("a maintained tool is canon at G4, even when it is also listed as a consumer", async () => {
    const result = await capture(["repo", "classify", "--target", "zheref/bankai-scaffold"], BANKAI_REPO, seams(ORIGIN_BANKAI), true);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as { role: string; defaultGate: string; kind: string; stack: string; lanes: string[]; sources: { role: string } };
    expect(doc.role).toBe("canon");
    expect(doc.defaultGate).toBe("G4");
    expect(doc.sources.role).toMatch(/maintained_tools/);
    // The fixture's contract declares a nextjs lane and a gradle-android lane.
    expect(doc.kind).toBe("product");
    expect(doc.lanes).toEqual(["web", "android"]);
    expect(doc.stack).toBe("nextjs");
  });

  it("a --target that is NOT this checkout gets role and gate from the registry but NO kind: the contract on disk is not its", async () => {
    const result = await capture(["repo", "classify", "--target", "zheref/KroApple"], BANKAI_REPO, seams(ORIGIN_BANKAI), true);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as { role: string; kind: string; stack: string | null; lanes: string[]; notes: string[] };
    expect(doc.role).toBe("consumer");
    expect(doc.kind).toBe("unknown");
    expect(doc.stack).toBeNull();
    expect(doc.lanes).toEqual([]);
    expect(doc.notes.join("\n")).toMatch(/not this checkout \(origin 'zheref\/bankai-scaffold'\)/);
    // And when the origin cannot be read at all, the same refusal to guess, with the reason.
    const blind = await capture(["repo", "classify", "--target", "zheref/bankai-scaffold"], BANKAI_REPO, seams(null), true);
    expect(blind.code).toBe(0);
    expect((JSON.parse(blind.out.join("\n")) as { kind: string }).kind).toBe("unknown");
  });

  it("a consumer is G2; an unregistered repository is G2 with a note, never rounded to consumer", async () => {
    const consumer = await capture(["repo", "classify", "--target", "zheref/KroApple"], BANKAI_REPO, seams(null), true);
    expect((JSON.parse(consumer.out.join("\n")) as { role: string; defaultGate: string }).role).toBe("consumer");
    const stranger = await capture(["repo", "classify", "--target", "acme/widget"], BANKAI_REPO, seams(null));
    expect(stranger.code).toBe(0);
    expect(stranger.out.join("\n")).toMatch(/role unregistered .* gate not derived/);
    expect(stranger.out.join("\n")).toMatch(/note: 'acme\/widget' is not in this registry/);
  });

  it("with no --target it reads the checkout's origin; an unreadable origin is exit 1", async () => {
    const ok = seams({ code: 0, stdout: "git@github.com:zheref/KroAndroid.git\n", stderr: "", spawnFailed: false });
    const fromOrigin = await capture(["repo", "classify"], BANKAI_REPO, ok);
    expect(fromOrigin.code).toBe(0);
    expect(fromOrigin.out.join("\n")).toMatch(/^zheref\/KroAndroid: role consumer/);
    const broken = seams({ code: 128, stdout: "", stderr: "fatal: no such remote", spawnFailed: false });
    const failed = await capture(["repo", "classify"], BANKAI_REPO, broken);
    expect(failed.code).toBe(1);
    expect(failed.err.join("\n")).toMatch(/no readable 'origin'/);
  });

  it("a registry without a contract reports kind unknown, not defaulted", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-classify-"));
    mkdirSync(join(root, "nen"), { recursive: true });
    copyFileSync(join(BANKAI_REPO, "nen", "repos.json"), join(root, "nen", "repos.json"));
    // The target IS this checkout (origin says so) and there is still no contract: the note says which.
    const kro: CommandResult = { code: 0, stdout: "https://github.com/zheref/KroApple.git\n", stderr: "", spawnFailed: false };
    const result = await capture(["repo", "classify", "--target", "zheref/KroApple"], root, seams(kro), true);
    const doc = JSON.parse(result.out.join("\n")) as { kind: string; notes: string[] };
    expect(doc.kind).toBe("unknown");
    expect(doc.notes.join(" ")).toMatch(/no nen\/contract\.json/);
  });

  it("refuses a malformed --target at 2", async () => {
    expect((await capture(["repo", "classify", "--target", "nope"], BANKAI_REPO, seams(null))).code).toBe(2);
  });
});
