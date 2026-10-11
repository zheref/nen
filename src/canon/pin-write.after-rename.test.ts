// src/canon/pin-write.after-rename.test.ts -- `canon pin --write` reports a
// failure AFTER the rename as written (Nobunaga N3, zheref/nen#338): the pin
// may have moved, so the refusal is read-back-mismatch with written: true,
// never write-failed. The atomic write is wrapped here to fail after it has
// really replaced the file; the fixture is ./pin-write.integration.test.ts's.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = vi.hoisted((): { fail: "landed" | "gone" } => ({ fail: "landed" }));

vi.mock("../edit/atomic.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../edit/atomic.js")>();
  return {
    ...original,
    writeFileAtomic: (...args: Parameters<typeof original.writeFileAtomic>): void => {
      original.writeFileAtomic(...args);
      if (mode.fail === "gone") {
        rmSync(args[0].path);
        return;
      }
      throw new original.WrittenButUnverifiedError(`the new text landed elsewhere: ${args[0].path} is not the file this run wrote after the rename`);
    },
  };
});

const { runFamily } = await import("../index.js");
const { defaultSeams } = await import("../seam/exec.js");
const { canonCommand } = await import("./command.js");

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-c", "user.name=nen test", "-c", "user.email=nen@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

const HAVE_GIT = spawnSync("git", ["--version"]).status === 0;
const REGISTRY = `{
  "maintained_tools": [ { "repo": "owner/handbooks", "pinned": "v1.2.0", "checkout_env": "NEN_TEST_CANON" } ],
  "consumers": [],
  "product_codes": {}
}
`;

let base = "";
let canon = "";

beforeAll(() => {
  if (!HAVE_GIT) return;
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "nen-canon-pin-after-")));
  canon = join(base, "handbooks");
  mkdirSync(join(canon, "handbooks"), { recursive: true });
  writeFileSync(join(canon, "handbooks", "a.md"), "one\n");
  git(canon, ["init", "--quiet"]);
  git(canon, ["add", "-A"]);
  git(canon, ["commit", "--quiet", "-m", "one"]);
  git(canon, ["tag", "v1.2.0"]);
  git(canon, ["tag", "v1.3.0"]);
  git(canon, ["remote", "add", "origin", "https://github.com/owner/handbooks.git"]);
});

afterAll(() => {
  if (base !== "") rmSync(base, { recursive: true, force: true, maxRetries: 3 });
});

async function attempt(): Promise<{ code: number; doc: Record<string, unknown>; root: string }> {
  const root = mkdtempSync(join(base, "consumer-"));
  mkdirSync(join(root, "nen"));
  writeFileSync(join(root, "nen", "repos.json"), REGISTRY);
  git(root, ["init", "--quiet"]);
  git(root, ["remote", "add", "origin", "git@github.com:owner/consumer.git"]);
  const out: string[] = [];
  const io = { out: (line: string): void => void out.push(line), err: (): void => undefined };
  const code = await runFamily(canonCommand, ["canon", "pin", "--write", "v1.3.0"], root, true, io, { ...defaultSeams(), env: { NEN_TEST_CANON: canon } });
  return { code, doc: JSON.parse(out.join("\n")) as Record<string, unknown>, root };
}

describe.skipIf(!HAVE_GIT)("canon pin --write -- after the rename", () => {
  it("a rename that landed elsewhere is read-back-mismatch with written: true, not write-failed", async () => {
    mode.fail = "landed";
    const { code, doc, root } = await attempt();
    expect(code).toBe(1);
    expect(doc).toMatchObject({ ok: false, written: true, failure: { code: "read-back-mismatch" } });
    expect(readFileSync(join(root, "nen", "repos.json"), "utf8")).toContain('"pinned": "v1.3.0"');
  });

  it("a registry gone on the read-back is read-back-mismatch with written: true", async () => {
    mode.fail = "gone";
    const { code, doc } = await attempt();
    expect(code).toBe(1);
    expect(doc).toMatchObject({ ok: false, written: true, failure: { code: "read-back-mismatch" } });
  });
});
