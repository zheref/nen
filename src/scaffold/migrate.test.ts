// src/scaffold/migrate.test.ts -- `nen scaffold migrate` and the `schema check`
// rows that name it (zheref/nen#592).
//
// AC-1: the check output names the command that creates each missing file.
// AC-2: that command is idempotent and leaves the existing config untouched.

import { describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  chmodSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { parseColorsText } from "../schema/colors.js";
import { parseGateIdentities, parseGatesText } from "../schema/gates.js";
import { pendingRounds } from "../gates/predicates.js";
import { checkTaxonomy } from "../schema/taxonomy.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { scaffoldCommand } from "./command.js";
import { scaffoldMigrate } from "./migrate.js";
import { migrateCommand, SEEDS, shellWord } from "./seeds.js";

const COLORS_SEED = SEEDS[0]?.text ?? "";
const GATES_SEED = SEEDS[1]?.text ?? "";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "nen-scaffold-migrate-"));
  mkdirSync(join(root, ".git"));
  return root;
}

async function capture(argv: readonly string[], repoFlag: string | null, json = false): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const seams: Seams = {
    run: (): CommandResult => {
      throw new Error("scaffold migrate makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("this verb has no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("this verb has no watched form");
    },
    platform: "linux",
  };
  const code = await runFamily(scaffoldCommand, argv, repoFlag, json, io, seams);
  return { code, out, err };
}

describe("the seeds", () => {
  it("load through schema check's own loaders and widen nothing", () => {
    expect(parseColorsText("nen/colors.yml", COLORS_SEED).categories).toEqual([]);
    const gates = parseGateIdentities("nen/gates.json", parseGatesText("nen/gates.json", GATES_SEED));
    expect(gates.reviewers.map((reviewer): string => reviewer.name)).toEqual(["copilot"]);
    expect(gates.baseReviewers).toEqual(["copilot"]);
    expect(gates.defaultApprovers).toEqual([]);
    // FAILS CLOSED (Feitan F1): not bounded-exempt, so its round is owed.
    expect(gates.reviewer("copilot")?.boundedPolicyExempt).not.toBe(true);
    // The delivery carve-out matches no GitHub login: logins carry no space.
    for (const login of ["zheref", "copilot", "dependabot[bot]", "a-b"]) {
      expect(gates.delivery.authorPattern.test(login)).toBe(false);
    }
  });

  it("the seeded gate owes Copilot a round on a PR nobody reviewed or requested, under both policies", () => {
    const gates = parseGateIdentities("nen/gates.json", parseGatesText("nen/gates.json", GATES_SEED));
    const inputs = { reviewRequests: [], checks: [], reviews: [] };
    for (const policy of ["bounded", "strict"] as const) {
      const owed = pendingRounds(gates, inputs, "headsha", gates.baseReviewers, policy);
      expect(owed.map((round) => round.reviewer), policy).toEqual(["copilot"]);
    }
  });

  it("seed exactly colors.yml and gates.json -- never labels.json or repos.json", () => {
    expect(SEEDS.map((seed): string => seed.file)).toEqual(["nen/colors.yml", "nen/gates.json"]);
  });
});

describe("scaffoldMigrate", () => {
  it("creates both absent files and reads each one back", () => {
    const root = repo();
    const result = scaffoldMigrate({ root, dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(result.files.map((row): string => `${row.file}:${row.action}`)).toEqual([
      "nen/colors.yml:created",
      "nen/gates.json:created",
    ]);
    expect(result.files[0]?.why).toContain("read back: 0 categories");
    expect(result.files[1]?.why).toContain("read back: 1 reviewer(s)");
    expect(readFileSync(join(root, "nen", "colors.yml"), "utf8")).toBe(COLORS_SEED);
    expect(readFileSync(join(root, "nen", "gates.json"), "utf8")).toBe(GATES_SEED);
    const check = checkTaxonomy({ repoFlag: root }).checks;
    expect(check.find((row) => row.file === "nen/colors.yml")).toMatchObject({ ok: true, detail: "0 categories, 0 values" });
    expect(check.find((row) => row.file === "nen/gates.json")).toMatchObject({ ok: true });
  });

  it("is idempotent: a second run keeps every file and changes no byte (AC-2)", () => {
    const root = repo();
    scaffoldMigrate({ root, dryRun: false });
    const before = SEEDS.map((seed): string => readFileSync(join(root, seed.file), "utf8"));
    const again = scaffoldMigrate({ root, dryRun: false });
    expect(again.exitCode).toBe(0);
    expect(again.files.map((row) => row.action)).toEqual(["kept", "kept"]);
    expect(SEEDS.map((seed): string => readFileSync(join(root, seed.file), "utf8"))).toEqual(before);
  });

  it("leaves existing config untouched -- even a file that would not load (AC-2)", () => {
    const root = repo();
    mkdirSync(join(root, "nen"));
    const existing = '{"version": 1, "this is": "the repository\'s own, broken or not"}\n';
    writeFileSync(join(root, "nen", "gates.json"), existing);
    const result = scaffoldMigrate({ root, dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(result.files.map((row): string => `${row.file}:${row.action}`)).toEqual([
      "nen/colors.yml:created",
      "nen/gates.json:kept",
    ]);
    expect(readFileSync(join(root, "nen", "gates.json"), "utf8")).toBe(existing);
  });

  it("keeps a dangling symlink rather than writing through it", () => {
    const root = repo();
    mkdirSync(join(root, "nen"));
    symlinkSync("../nowhere.yml", join(root, "nen", "colors.yml"));
    const result = scaffoldMigrate({ root, dryRun: false });
    expect(result.files[0]).toMatchObject({ file: "nen/colors.yml", action: "kept" });
    expect(lstatSync(join(root, "nen", "colors.yml")).isSymbolicLink()).toBe(true);
    // Windows reads the link back with its own separator.
    expect(readlinkSync(join(root, "nen", "colors.yml")).replace(/\\/g, "/")).toBe("../nowhere.yml");
    expect(existsSync(join(root, "nowhere.yml"))).toBe(false);
  });

  it("refuses a nen/ that is a symlink, writing nothing through it", () => {
    const root = repo();
    const outside = mkdtempSync(join(tmpdir(), "nen-scaffold-migrate-outside-"));
    symlinkSync(outside, join(root, "nen"));
    const result = scaffoldMigrate({ root, dryRun: false });
    expect(result.exitCode).toBe(1);
    expect(result.files.map((row) => row.action)).toEqual(["refused", "refused"]);
    expect(result.files[0]?.why).toContain("symlink");
    expect(existsSync(join(outside, "colors.yml"))).toBe(false);
    expect(existsSync(join(outside, "gates.json"))).toBe(false);
  });

  it("refuses to seed over a legacy schemas/ copy, naming init's migration", () => {
    const root = repo();
    mkdirSync(join(root, "schemas"));
    writeFileSync(join(root, "schemas", "gates.json"), "{}\n");
    const result = scaffoldMigrate({ root, dryRun: false });
    expect(result.exitCode).toBe(1);
    expect(result.files[1]).toMatchObject({ file: "nen/gates.json", action: "refused" });
    expect(result.files[1]?.why).toContain("nen scaffold init --accept-detected");
    expect(existsSync(join(root, "nen", "gates.json"))).toBe(false);
  });

  it("writes nothing on --dry-run", () => {
    const root = repo();
    const result = scaffoldMigrate({ root, dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.files.map((row) => row.action)).toEqual(["would-create", "would-create"]);
    expect(existsSync(join(root, "nen"))).toBe(false);
  });

  it("refuses a seed that does not load, after writing it", () => {
    const root = repo();
    const result = scaffoldMigrate({
      root,
      dryRun: false,
      seeds: [{ file: "nen/gates.json", text: '{"version": 1}\n', what: "a broken seed" }],
    });
    expect(result.exitCode).toBe(1);
    expect(result.files[0]?.action).toBe("refused");
    expect(result.files[0]?.why).toContain("written, but does not load, so it was removed again");
    // Removed, so the refusal survives a re-run instead of turning into `kept`.
    expect(existsSync(join(root, "nen", "gates.json"))).toBe(false);
  });

  it("refuses, rather than calling it kept, a path it cannot inspect", () => {
    if (process.getuid?.() === 0 || process.platform === "win32") return;
    const root = repo();
    mkdirSync(join(root, "nen"));
    chmodSync(join(root, "nen"), 0o000);
    try {
      const result = scaffoldMigrate({ root, dryRun: false });
      expect(result.exitCode).toBe(1);
      expect(result.files[0]).toMatchObject({ action: "refused" });
      expect(result.files[0]?.why).toContain("could not be inspected (EACCES)");
    } finally {
      chmodSync(join(root, "nen"), 0o755);
    }
  });
});

describe("nen scaffold migrate -- CLI wiring", () => {
  it("reports each row and exits 0", async () => {
    const root = repo();
    const result = await capture(["scaffold", "migrate"], root);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/^created: nen\/colors\.yml -- /m);
    expect(result.out.join("\n")).toMatch(/^created: nen\/gates\.json -- /m);
    // The next step names THIS repository, not whatever the shell stands in.
    expect(result.out.at(-1)).toBe(`next: review the seeded file(s), commit them, then run: nen schema check --repo ${shellWord(root)}`);
    const again = await capture(["scaffold", "migrate"], root);
    expect(again.code).toBe(0);
    expect(again.out).toEqual([
      "kept: nen/colors.yml -- already there; left untouched and unread",
      "kept: nen/gates.json -- already there; left untouched and unread",
    ]);
  });

  it("publishes nen.scaffold.migrate/v0.1 under --json", async () => {
    const root = repo();
    const result = await capture(["scaffold", "migrate", "--dry-run"], root, true);
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(document).toMatchObject({ contract: "nen.scaffold.migrate/v0.1", dryRun: true, exitCode: 0 });
    expect(document["files"]).toHaveLength(2);
  });

  it("requires --repo", async () => {
    const result = await capture(["scaffold", "migrate"], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("--repo");
  });

  it("refuses an init flag by name rather than ignoring it", async () => {
    const root = repo();
    const result = await capture(["scaffold", "migrate", "--stack", "nextjs", "--force"], root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("does not take --force, --stack");
    expect(existsSync(join(root, "nen"))).toBe(false);
  });
});

describe("schema check names the command for each missing seeded file (AC-1)", () => {
  it("on the colors.yml row and the gates.json row, and on neither once both exist", () => {
    const root = repo();
    const rows = checkTaxonomy({ repoFlag: root }).checks;
    const colors = rows.find((row) => row.file === "nen/colors.yml");
    const gates = rows.find((row) => row.file === "nen/gates.json");
    expect(colors).toMatchObject({ ok: true, required: false });
    expect(colors?.detail).toMatch(/^absent \(optional\) -- /);
    expect(colors?.detail).toContain(`run: ${migrateCommand(root)}`);
    expect(gates).toMatchObject({ ok: false, required: false });
    expect(gates?.detail).toContain("no such file.");
    expect(gates?.detail).toContain(`run: ${migrateCommand(root)}`);
    // labels.json and repos.json have no seed, so no command is named for them.
    for (const file of ["nen/labels.json", "nen/repos.json"]) {
      expect(rows.find((row) => row.file === file)?.detail).not.toContain("scaffold migrate");
    }

    scaffoldMigrate({ root, dryRun: false });
    const after = checkTaxonomy({ repoFlag: root }).checks;
    for (const file of ["nen/colors.yml", "nen/gates.json"]) {
      const row = after.find((check) => check.file === file);
      expect(row?.ok).toBe(true);
      expect(row?.detail).not.toContain("scaffold migrate");
    }
  });

  it("names no command for a present-but-broken file -- that config is the repository's to fix", () => {
    const root = repo();
    mkdirSync(join(root, "nen"));
    writeFileSync(join(root, "nen", "gates.json"), "{}\n");
    const gates = checkTaxonomy({ repoFlag: root }).checks.find((row) => row.file === "nen/gates.json");
    expect(gates?.ok).toBe(false);
    expect(gates?.detail).not.toContain("scaffold migrate");
  });

  it("names no command for a dangling symlink -- migrate would keep it, not create it", () => {
    const root = repo();
    mkdirSync(join(root, "nen"));
    symlinkSync("missing-target", join(root, "nen", "gates.json"));
    symlinkSync("missing-target", join(root, "nen", "colors.yml"));
    const rows = checkTaxonomy({ repoFlag: root }).checks;
    expect(rows.find((row) => row.file === "nen/gates.json")?.detail).not.toContain("scaffold migrate");
    expect(rows.find((row) => row.file === "nen/colors.yml")?.detail).not.toContain("scaffold migrate");
    expect(scaffoldMigrate({ root, dryRun: true }).files.map((row) => row.action)).toEqual(["kept", "kept"]);
  });

  it("names no command on a repository that carries both files", () => {
    const rows = checkTaxonomy({ repoFlag: BANKAI_REPO }).checks;
    expect(rows.find((row) => row.file === "nen/gates.json")?.detail).not.toContain("scaffold migrate");
  });

  it("quotes a root a shell would split, so the named command pastes as one word", () => {
    expect(migrateCommand("/tmp/plain-repo")).toBe("nen scaffold migrate --repo /tmp/plain-repo");
    expect(migrateCommand("/tmp/it's here")).toBe("nen scaffold migrate --repo '/tmp/it'\\''s here'");
  });
});
