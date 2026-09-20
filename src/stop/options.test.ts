import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { MARKER_FILE, STOP_MARK_CONTRACT, STOP_MARK_CONTRACT_V2, stopCommand } from "./command.js";

const SEAMS: Seams = {
  run: (): never => {
    throw new Error("must not be called");
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

async function capture(argv: readonly string[], repo: string | null): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l): void => { out.push(l); }, err: (l): void => { err.push(l); } };
  const code = await runFamily(stopCommand, argv, repo, false, io, SEAMS);
  return { code, out, err };
}

const OPTIONS = [
  { key: "A", label: "carry the tree", command: "nen shu warmup --carry --branch x", consequence: "nothing discarded", recommended: true },
  { key: "B", label: "exclude the paths", command: "printf '%s\\n' path >> .git/info/exclude" },
  { key: "C", label: "stop here", command: "exit 0" },
];

function repoWith(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "nen-stop-opts-"));
  for (const [name, doc] of Object.entries(files)) writeFileSync(join(root, name), JSON.stringify(doc));
  return root;
}

describe("nen stop --options / --propose-issue / --report-url -- Crazy Slots (zheref/nen#216)", () => {
  it("renders lettered options with one star, links the report, and writes a v0.2 marker", async () => {
    const root = repoWith({ "options.json": OPTIONS, "issue.json": { title: "breath: carry by default", body: "why", labels: ["enhancement"] } });
    const result = await capture(
      ["stop", "--who", "k", "--gate", "G5", "--title", "dirty tree", "--body", "which door?", "--report-url", "https://x/report", "--options", "options.json", "--propose-issue", "issue.json", "--mark"],
      root,
    );
    expect(result.code).toBe(0);
    const text = result.out.join("\n");
    expect(text).toMatch(/report: https:\/\/x\/report/);
    expect(text).toMatch(/⭐ A -- carry the tree/);
    expect(text).toMatch(/ {3}B -- exclude the paths/);
    expect(text).toMatch(/proposed process issue: breath: carry by default/);
    const marker = JSON.parse(readFileSync(join(root, MARKER_FILE), "utf8")) as Record<string, unknown>;
    expect(marker["contract"]).toBe(STOP_MARK_CONTRACT_V2);
    expect(marker["reportUrl"]).toBe("https://x/report");
    expect((marker["options"] as unknown[]).length).toBe(3);
    expect((marker["proposedIssue"] as { title: string }).title).toBe("breath: carry by default");
    const proposed = readdirSync(join(root, ".nen", "proposed"));
    expect(proposed).toHaveLength(1);
    expect(text).toMatch(/proposed issue written:/);
  });

  it("a plain --mark still writes the v0.1 shape, byte-compatible", async () => {
    const root = repoWith({});
    const result = await capture(["stop", "--who", "k", "--gate", "G2", "--mark"], root);
    expect(result.code).toBe(0);
    const marker = JSON.parse(readFileSync(join(root, MARKER_FILE), "utf8")) as Record<string, unknown>;
    expect(marker["contract"]).toBe(STOP_MARK_CONTRACT);
    expect(Object.keys(marker)).toEqual(["contract", "who", "gate", "notified", "at"]);
  });

  it("refuses an option that names the report, an option with no command, and no star", async () => {
    const report = repoWith({ "o.json": [{ ...OPTIONS[0], label: "open the report" }] });
    expect((await capture(["stop", "--options", "o.json"], report)).err.join("\n")).toMatch(/never one of the decisions/);
    const empty = repoWith({ "o.json": [{ key: "A", label: "do", command: "", recommended: true }] });
    expect((await capture(["stop", "--options", "o.json"], empty)).err.join("\n")).toMatch(/non-empty command line/);
    const nostar = repoWith({ "o.json": OPTIONS.map((o): unknown => ({ ...o, recommended: false })) });
    const result = await capture(["stop", "--options", "o.json"], nostar);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/exactly one option must be 'recommended'/);
  });

  it("says aloud when fewer than three options are offered", async () => {
    const root = repoWith({ "o.json": OPTIONS.slice(0, 2) });
    const result = await capture(["stop", "--options", "o.json"], root);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/2 options -- fewer than the three/);
  });

  it("nen stop clear removes the marker, and says so when there is none", async () => {
    const root = repoWith({});
    await capture(["stop", "--mark"], root);
    expect(existsSync(join(root, MARKER_FILE))).toBe(true);
    const cleared = await capture(["stop", "clear"], root);
    expect(cleared.code).toBe(0);
    expect(cleared.out.join("\n")).toMatch(/cleared/);
    expect(existsSync(join(root, MARKER_FILE))).toBe(false);
    const again = await capture(["stop", "clear"], root);
    expect(again.code).toBe(0);
    expect(again.out.join("\n")).toMatch(/nothing to clear/);
  });

  it("nen stop show validates the marker: a v0.2 marker reads back, a corrupted one exits 1", async () => {
    const root = repoWith({ "o.json": OPTIONS });
    await capture(["stop", "--who", "k", "--gate", "G5", "--title", "t", "--report-url", "https://x", "--options", "o.json", "--mark"], root);
    const shown = await capture(["stop", "show"], root);
    expect(shown.code).toBe(0);
    expect(shown.out.join("\n")).toMatch(/nen\.stop\.mark\/v0\.2/);
    expect(shown.out.join("\n")).toMatch(/options: 3/);
    writeFileSync(join(root, MARKER_FILE), JSON.stringify({ contract: STOP_MARK_CONTRACT, who: "k", gate: "G9", notified: true, at: "2026-01-01T00:00:00Z" }));
    const bad = await capture(["stop", "show"], root);
    expect(bad.code).toBe(1);
    expect(bad.err.join("\n")).toMatch(/gate 'G9' is not one of/);
    // An absent key is not a null: a v0.2 marker missing 'options' is refused, and so is a key no contract names.
    writeFileSync(join(root, MARKER_FILE), JSON.stringify({ contract: STOP_MARK_CONTRACT_V2, who: "k", gate: "G5", notified: true, at: "2026-01-01T00:00:00Z", title: null, body: null, reportUrl: null, proposedIssue: null }));
    expect((await capture(["stop", "show"], root)).err.join("\n")).toMatch(/options is missing/);
    writeFileSync(join(root, MARKER_FILE), JSON.stringify({ contract: STOP_MARK_CONTRACT, who: "k", gate: "G5", notified: true, at: "2026-01-01T00:00:00Z", extra: 1 }));
    expect((await capture(["stop", "show"], root)).err.join("\n")).toMatch(/unexpected key\(s\) extra/);
    const none = await capture(["stop", "show"], repoWith({}));
    expect(none.code).toBe(0);
    expect(none.out.join("\n")).toMatch(/no marker/);
  });

  it("nen stop efforts.md --help is the family's help, not an unknown-subcommand refusal", async () => {
    const result = await capture(["stop", "efforts.md", "--help"], null);
    expect(result.code).toBe(0);
  });
});
