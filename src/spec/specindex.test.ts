import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedSeams } from "../seam/scripted.js";
import { INDEX_MARKER_PREFIX, indexState, renderIndexFile } from "./specindex.js";
import { fixtureCopy, spec } from "./testkit.testkit.js";

const seams = (): ScriptedSeams => new ScriptedSeams([]);
const index = (repo: string): string => join(repo, "specs", "INDEX.md");

describe("nen spec index", () => {
  it("reports an absent index at exit 1, writes it with --write, then reads it current at exit 0", async () => {
    const repo = fixtureCopy();
    mkdirSync(join(repo, "specs", "notes"));
    const before = await spec(["index"], repo, seams(), true);
    expect(before.code).toBe(1);
    const report = before.json();
    expect(Object.keys(report)).toEqual(["contract", "repo", "layout", "path", "rows", "ignored", "state", "action", "reason"]);
    expect(report).toMatchObject({ contract: "nen.spec.index/v0.1", layout: "specs/{nnn}-{slug}", path: "specs/INDEX.md", state: "absent", action: "none", ignored: ["specs/notes"] });
    expect(report["rows"]).toEqual([
      { nnn: "001", slug: "sample-feature", folder: "specs/001-sample-feature", title: "Sample feature", status: "Draft", created: "2026-10-22", openMarkers: 6, error: null },
      { nnn: "002", slug: "other-feature", folder: "specs/002-other-feature", title: "Other | feature", status: "Specified", created: "2026-10-21", openMarkers: 0, error: null },
    ]);
    const dry = await spec(["index", "--write", "--dry-run"], repo, seams(), true);
    expect(dry.json()["action"]).toBe("would-write");
    expect(existsSync(index(repo))).toBe(false);
    const written = await spec(["index", "--write"], repo, seams(), true);
    expect(written.code).toBe(0);
    expect(written.json()["action"]).toBe("written");
    const text = readFileSync(index(repo), "utf8");
    expect(text.startsWith(INDEX_MARKER_PREFIX)).toBe(true);
    expect(text).toContain("| 002 | [`other-feature`](002-other-feature/spec.md) | Other \\| feature | Specified | 2026-10-21 | 0 |");
    const after = await spec(["index"], repo, seams(), true);
    expect(after.code).toBe(0);
    expect(after.json()["state"]).toBe("current");
    expect((await spec(["index", "--write"], repo, seams(), true)).json()["action"]).toBe("none");
  });

  it("regenerates a stale index nen wrote, and refuses one edited by hand", async () => {
    const repo = fixtureCopy();
    await spec(["index", "--write"], repo, seams());
    mkdirSync(join(repo, "specs", "003-new-feature"));
    writeFileSync(join(repo, "specs", "003-new-feature", "spec.md"), "# Feature Specification: New\n\n**Status**: Draft\n");
    expect((await spec(["index"], repo, seams(), true)).json()["state"]).toBe("stale");
    const regenerated = await spec(["index", "--write"], repo, seams(), true);
    expect(regenerated.code).toBe(0);
    expect(readFileSync(index(repo), "utf8")).toContain("| 003 |");
    writeFileSync(index(repo), `${readFileSync(index(repo), "utf8")}\nA hand-written note.\n`);
    const refused = await spec(["index", "--write"], repo, seams());
    expect(refused.code).toBe(1);
    expect(refused.out.join("\n")).toContain("hand-edited · action refused");
    expect(readFileSync(index(repo), "utf8")).toContain("A hand-written note.");
  });

  it("refuses to write over a folder whose spec.md it cannot read, and exits 1 without --write too", async () => {
    const repo = fixtureCopy();
    mkdirSync(join(repo, "specs", "003-empty"));
    const read = await spec(["index"], repo, seams(), true);
    expect(read.code).toBe(1);
    expect((read.json()["rows"] as { error: string | null }[])[2]?.error).toBe("specs/003-empty/spec.md does not exist");
    const write = await spec(["index", "--write"], repo, seams(), true);
    expect(write.code).toBe(1);
    expect(write.json()["action"]).toBe("refused");
    expect(existsSync(index(repo))).toBe(false);
  });

  it("follows a custom --layout and refuses a missing root rather than reading it as empty", async () => {
    const repo = fixtureCopy();
    const custom = await spec(["index", "--layout", "specs/{nnn}_{slug}"], repo, seams(), true);
    expect(custom.json()["rows"]).toEqual([]);
    expect(custom.json()["ignored"]).toEqual(["specs/001-sample-feature", "specs/002-other-feature"]);
    rmSync(join(repo, "specs"), { recursive: true });
    const missing = await spec(["index"], repo, seams());
    expect(missing.code).toBe(1);
    expect(missing.err.join("\n")).toContain("specs/ does not exist");
  });

  it.skipIf(process.platform === "win32")("writes no index through a link: an INDEX.md link is refused, a root linked out of --repo too", async () => {
    const repo = fixtureCopy();
    const elsewhere = join(mkdtempSync(join(tmpdir(), "nen-spec-elsewhere-")), "target.md");
    writeFileSync(elsewhere, "outside\n");
    symlinkSync(elsewhere, index(repo));
    const linked = await spec(["index", "--write"], repo, seams());
    expect(linked.code).toBe(1);
    expect(linked.err.join("\n")).toContain("is not a regular file");
    expect(readFileSync(elsewhere, "utf8")).toBe("outside\n");
    const other = fixtureCopy();
    const outside = mkdtempSync(join(tmpdir(), "nen-spec-outside-"));
    cpSync(join(other, "specs"), join(outside, "specs"), { recursive: true });
    rmSync(join(other, "specs"), { recursive: true });
    symlinkSync(join(outside, "specs"), join(other, "specs"));
    // A root linked out of --repo resolves every folder outside it: refused at exit 2 before anything is read or written.
    const out = await spec(["index", "--write"], other, seams());
    expect(out.code).toBe(2);
    expect(out.err.join("\n")).toMatch(/outside --repo/);
    expect(existsSync(join(outside, "specs", "INDEX.md"))).toBe(false);
  });

  it.each([
    [["index", "--dry-run"], "--dry-run qualifies --write"],
    [["index", "--layout", "/abs/{nnn}-{slug}"], "--layout"],
    [["index", "--folder", "x"], "is not read by 'spec index'"],
  ])("%j exits 2", async (argv, words) => {
    const run = await spec(argv, fixtureCopy(), seams());
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toContain(words);
  });
});

describe("indexState", () => {
  it("tells current, stale, hand-edited and absent apart, CRLF included", () => {
    const generated = renderIndexFile([]);
    expect(indexState(null, generated)).toBe("absent");
    expect(indexState(generated, generated)).toBe("current");
    expect(indexState(generated.replace(/\n/g, "\r\n"), generated)).toBe("current");
    expect(indexState(generated, renderIndexFile([{ nnn: "001", slug: "a", folder: "specs/001-a", title: null, status: null, created: null, openMarkers: 0, error: null }]))).toBe("stale");
    expect(indexState("# Feature index\n", generated)).toBe("hand-edited");
    expect(indexState(`${INDEX_MARKER_PREFIX}${"0".repeat(64)} -->\n# x\n`, generated)).toBe("hand-edited");
  });
});
