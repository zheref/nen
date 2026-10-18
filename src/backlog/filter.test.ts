// zheref/nen#410: `nen backlog fetch --label/--severity`, the effort filter.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { backlogCommand } from "./command.js";

const LABELS = ["lang/typescript", "model/gpt", "enhancement", "R&D", "acme:sev/critical", "acme:sev/high", "acme:sev/low"];

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-filter-"));
  mkdirSync(join(dir, "nen"));
  writeFileSync(
    join(dir, "nen", "labels.json"),
    JSON.stringify({ labels: LABELS.map((name): unknown => ({ name, color: "ededed", description: `the ${name} label` })) }),
  );
  return dir;
}

const label = (name: string): { name: string } => ({ name });
// #1: lang/typescript on the issue; its PR #5 carries model/gpt.
// #2: lang/typescript + high.  #3: low only.  PR #9 references nothing, model/gpt.
const OPEN = JSON.stringify([
  { number: 1, title: "one", labels: [label("lang/typescript")], created_at: "2026-01-01T00:00:00Z" },
  { number: 2, title: "two", labels: [label("lang/typescript"), label("acme:sev/high")], created_at: "2026-01-02T00:00:00Z" },
  { number: 3, title: "three", labels: [label("acme:sev/low")], created_at: "2026-01-03T00:00:00Z" },
  { number: 5, title: "fix", labels: [label("model/gpt")], created_at: "2026-01-04T00:00:00Z", pull_request: {} },
  { number: 9, title: "lone", labels: [label("model/gpt")], created_at: "2026-01-05T00:00:00Z", pull_request: {} },
]);
const PULLS = JSON.stringify([
  { number: 5, title: "fix", body: "closes #1", created_at: "2026-01-04T00:00:00Z" },
  { number: 9, title: "lone", body: "", created_at: "2026-01-05T00:00:00Z" },
]);

async function fetch(extra: readonly string[], root = checkout()): Promise<{ code: number; out: string[]; err: string[]; calls: number }> {
  const out: string[] = [];
  const err: string[] = [];
  let calls = 0;
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const seams: Seams = {
    run: (_command, args): CommandResult => {
      calls += 1;
      const joined = args.join(" ");
      if (joined.includes("/issues?")) return { code: 0, stdout: OPEN, stderr: "", spawnFailed: false };
      if (joined.includes("/pulls?")) return { code: 0, stdout: PULLS, stderr: "", spawnFailed: false };
      return { code: 0, stdout: "[]", stderr: "", spawnFailed: false };
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
  const code = await runFamily(backlogCommand, ["backlog", "fetch", "--repo-slug", "o/r", "--repo", root, ...extra], null, false, io, seams);
  return { code, out, err, calls };
}

const kept = (out: readonly string[]): number[] => {
  const document = JSON.parse(out.join("\n")) as { rows: { issueNumber: number | null; prNumbers: number[] }[] };
  return document.rows.map((row): number => row.issueNumber ?? (row.prNumbers[0] as number));
};

describe("nen backlog fetch --label", () => {
  it("keeps the efforts carrying EVERY label, over the issue's and its PRs' labels unioned", async () => {
    const result = await fetch(["--label", "lang/typescript", "--label", "model/gpt", "--json"]);
    expect(result.code).toBe(0);
    expect(kept(result.out)).toEqual([1]); // #2 lacks model/gpt; #1 gets it from PR #5
  });

  it("a single label keeps every effort carrying it, a lone PR included", async () => {
    const result = await fetch(["--label", "model/gpt", "--json"]);
    expect(kept(result.out)).toEqual([1, 9]);
    const document = JSON.parse(result.out.join("\n")) as { filter: { labels: string[]; kept: number; of: number } };
    expect(document.filter).toMatchObject({ labels: ["model/gpt"], severity: null, kept: 2, of: 4 });
  });

  it("names the filter and the count in the human output, and an empty match is an explicit 0 at exit 0", async () => {
    const result = await fetch(["--label", "enhancement"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/^0 row\(s\) after the filter -- 3 issue\(s\), 2 PR\(s\) fetched/);
    expect(result.out.join("\n")).toMatch(/filter: label enhancement -- kept 0 of 4 effort\(s\)/);
  });

  it("refuses an undeclared label at exit 2, before any GitHub read", async () => {
    const result = await fetch(["--label", "lang/typscript"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/'lang\/typscript' is not declared/);
    expect(result.calls).toBe(0);
  });

  it("refuses a piece of a declared '&' label naming the limit", async () => {
    const result = await fetch(["--label", "R"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/'R' is a piece of 'R&D': labels containing '&' are not supported in selectors/);
  });

  it("an unfiltered fetch carries no 'filter' key and needs no labels file", async () => {
    const result = await fetch(["--json"]);
    expect(Object.keys(JSON.parse(result.out.join("\n")) as object)).not.toContain("filter");
  });
});

describe("nen backlog fetch --severity", () => {
  const band = ["--severity-family", "acme:sev", "--severity-order", "critical,high,low"];

  it("a bare band keeps that severity alone", async () => {
    expect(kept((await fetch(["--severity", "low", ...band, "--json"])).out)).toEqual([3]);
  });

  it("a trailing '+' keeps that band and every band above it", async () => {
    expect(kept((await fetch(["--severity", "low+", ...band, "--json"])).out)).toEqual([2, 3]);
    expect(kept((await fetch(["--severity", "HIGH+", ...band, "--json"])).out)).toEqual([2]);
  });

  it("ANDs with --label", async () => {
    expect(kept((await fetch(["--severity", "low+", ...band, "--label", "lang/typescript", "--json"])).out)).toEqual([2]);
  });

  it.each([
    [["--severity", "high"], /--severity needs --severity-family/],
    [["--severity", "high", "--severity-family", "acme", "--severity-order", "high"], /takes '<namespace>:<family>'/],
    [["--severity", "high", "--severity-family", "acme:nope", "--severity-order", "high"], /declares no 'acme:nope\/\*' labels/],
    [["--severity", "high", "--severity-family", "acme:sev", "--severity-order", "high,urgent"], /names 'urgent'/],
    [["--severity", "medium", ...band], /'medium' is none of/],
    [["--severity", "high++", ...band], /ONE severity with at most one trailing/],
    [["--severity", "high+low", ...band], /ONE severity with at most one trailing/],
    [["--severity-order", "high"], /no --severity was given/],
    [["--severity", "high", "--severity-family", "acme:sev", "--severity-order", ","], /names no severity/],
  ])("refuses %j at exit 2", async (flags, message) => {
    const result = await fetch(flags);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(message);
  });
});

describe("nen backlog order refuses the fetch's filter flags", () => {
  it("--label on order is refused, not ignored", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const dir = checkout();
    writeFileSync(join(dir, "rows.json"), "[]");
    const code = await runFamily(
      backlogCommand,
      ["backlog", "order", "--rows-from", "rows.json", "--severity-order", "high", "--label", "model/gpt", "--repo", dir],
      null,
      false,
      io,
      {
        run: (): CommandResult => ({ code: 0, stdout: "[]", stderr: "", spawnFailed: false }),
        now: (): Date => new Date(0),
        env: {},
        probePort: noPortProbe,
        runInteractive: (): never => {
          throw new Error("x");
        },
        runStreamed: (): never => {
          throw new Error("x");
        },
        platform: "linux",
      },
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--label filters 'backlog fetch'/);
  });
});

describe("declared severity and strict positional boundaries (#427)", () => {
  it.each([{ extra: ["fix"] }, { extra: ["--", "fix"] }])("refuses a stray argument before any network read: %s", async ({ extra }) => {
    const result = await fetch(["--label", "enhancement", ...extra]);
    expect(result.code).toBe(2); expect(result.calls).toBe(0);
    expect(result.err.join("\n")).toContain('"fix"');
    expect(result.err.join("\n")).toContain("a value with spaces is one quoted argument");
  });
  it("uses the declared family and highest-first order, with independent flag overrides", async () => {
    const root = checkout();
    writeFileSync(join(root, "nen/workflow.json"), JSON.stringify({ severity: { family: "acme:sev", order: ["critical", "high", "low"] } }));
    expect(kept((await fetch(["--severity", "low+", "--json"], root)).out)).toEqual([2, 3]);
    expect(kept((await fetch(["--severity", "high+", "--severity-order", "low,high", "--json"], root)).out)).toEqual([2, 3]);
    writeFileSync(join(root, "nen/labels.json"), JSON.stringify({ labels: [...LABELS, "other:sev/critical", "other:sev/high", "other:sev/low"].map((name) => ({ name, color: "aaaaaa", description: "severity" })) }));
    const familyOnly = await fetch(["--severity", "high+", "--severity-family", "other:sev", "--json"], root);
    expect(familyOnly.code).toBe(0);
    expect(JSON.parse(familyOnly.out.join("\n")).filter.severity.labels).toEqual(["other:sev/critical", "other:sev/high"]);
    const override = await fetch(["--severity", "high", "--severity-family", "unknown:sev"], root);
    expect(override.code).toBe(2); expect(override.err.join("\n")).toContain("unknown:sev/*");
  });
  it("maps a flat, spaced taxonomy to short severity names without creating labels", async () => {
    const root = checkout();
    writeFileSync(join(root, "nen/labels.json"), JSON.stringify({ labels: ["priority: p1 (patch)", "priority: p2 (minor)"].map((name) => ({ name, color: "aaaaaa", description: "priority" })) }));
    writeFileSync(join(root, "nen/workflow.json"), JSON.stringify({ severity: { family: "priority", order: ["p1", "p2"], labels: { p1: "priority: p1 (patch)", p2: "priority: p2 (minor)" } } }));
    const result = await fetch(["--severity", "p2+", "--json"], root);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n")).filter.severity.labels).toEqual(["priority: p1 (patch)", "priority: p2 (minor)"]);
    const explicit = await fetch(["--severity", "p1", "--severity-family", "priority", "--severity-order", "p2,p1", "--json"], root);
    expect(JSON.parse(explicit.out.join("\n")).filter.severity.labels).toEqual(["priority: p1 (patch)"]);
    const bad = await fetch(["--severity", "p3"], root);
    expect(bad.code).toBe(2); expect(bad.calls).toBe(0);
  });
});
