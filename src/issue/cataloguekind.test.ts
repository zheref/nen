// A --catalogue of the other kind is named as that, in both directions
// (zheref/nen#607): `pr body-check` and its siblings read the issue-sections
// catalogue, `pr sections resolve` / `family` the PR-sections one, and each,
// handed the other, used to fail on an inner field. No exit code moves. Covers AC-1 (the
// issue-sections reader), AC-2 (the PR-sections reader, both actions), AC-3
// (no contract, or one naming neither kind: field-level validation unchanged)
// and the half of AC-4 that is tests.
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { prCommand } from "../pr/command.js";
import { parseSectionCatalogue } from "../pr/sections.js";
import { SchemaError } from "../schema/errors.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { makeTempDir } from "../testing/tempdir.js";
import { declaredCatalogueKind, wrongCatalogueKind } from "./cataloguekind.js";
import { IssueShapeError, parseCatalogue } from "./shape.js";

/** A PR-sections catalogue as `pr sections resolve` reads it; `contract` is added per case. */
const PR_SECTIONS = {
  sections: [
    { id: "changes", title: "What changes", level: 1 },
    { id: "verify", title: { process: "What the guards prove", library: "How a consumer verifies" } },
  ],
  footer: [{ id: "attribution", title: "Agent attribution" }],
  families: { maintain: ["build"], canon: ["test"] },
  precedence: ["maintain", "canon"],
  variants: { "process.canon": ["changes", "verify"] },
  max: 7,
};

/** An issue-sections catalogue in the v1 shape (`sections` an object); `contract` is added per case. */
const ISSUE_SECTIONS = {
  sections: { problem: { heading: "Problem" }, acceptance: { heading: "Acceptance criteria", rows: "acceptance" } },
  kinds: { bug: { template: "bug.md", required: ["problem", "acceptance"], optional: [] } },
  common: ["problem"],
  rows: { acceptance: { pattern: "^- AC-(\\d+): .+$", prefix: "^- AC-" } },
};

const dir = makeTempDir("nen-catalogue-kind-");
let n = 0;
function file(value: unknown): string {
  const path = join(dir, `f-${++n}.json`);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

async function run(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(prCommand, [...argv], dir, false, io, new ScriptedSeams([]));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function thrown(act: () => unknown): Error {
  try {
    act();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected a refusal, and nothing was thrown");
}

describe("the kind a catalogue declares through its contract", () => {
  it("reads the name segment of the contract id, whoever the namespace is", () => {
    expect(declaredCatalogueKind({ contract: "hatsu.pr-sections/v1" })).toEqual({ contract: "hatsu.pr-sections/v1", kind: "pr-sections" });
    expect(declaredCatalogueKind({ contract: "hatsu.issue-sections/v1" })).toEqual({ contract: "hatsu.issue-sections/v1", kind: "issue-sections" });
    expect(declaredCatalogueKind({ contract: "acme.tools.issue-sections/v3" })?.kind).toBe("issue-sections");
    expect(declaredCatalogueKind({ contract: "pr-sections" })?.kind).toBe("pr-sections");
    expect(declaredCatalogueKind({ contract: "pr-sections@2" })?.kind).toBe("pr-sections");
  });

  it("declares nothing for an absent, non-string or unrelated contract, or a name that only contains a kind", () => {
    for (const raw of [{}, { contract: 1 }, { contract: null }, { contract: "" }, { contract: "acme.labels/v1" }, null, [], "pr-sections", 7]) {
      expect(declaredCatalogueKind(raw)).toBeNull();
    }
    // Bounded on both sides: a longer name is another contract, never a guess.
    expect(declaredCatalogueKind({ contract: "acme.pr-sections-extra/v1" })).toBeNull();
    expect(declaredCatalogueKind({ contract: "acme.my-issue-sections/v1" })).toBeNull();
    expect(declaredCatalogueKind({ contract: "acme.pr-sectionsv1" })).toBeNull();
  });

  it("answers null for the expected kind and for no declaration, and one line for the other kind", () => {
    expect(wrongCatalogueKind({ contract: "x.issue-sections/v1" }, "issue-sections")).toBeNull();
    expect(wrongCatalogueKind({ contract: "x.pr-sections/v1" }, "pr-sections")).toBeNull();
    expect(wrongCatalogueKind({}, "issue-sections")).toBeNull();
    expect(wrongCatalogueKind({}, "pr-sections")).toBeNull();
    expect(wrongCatalogueKind({ contract: "x.pr-sections/v1" }, "issue-sections")).not.toContain("\n");
    expect(wrongCatalogueKind({ contract: "x.issue-sections/v1" }, "pr-sections")).not.toContain("\n");
  });
});

describe("AC-1: an issue-sections reader handed a PR-sections catalogue", () => {
  const swapped = { contract: "hatsu.pr-sections/v1", ...PR_SECTIONS };

  it("the loader names the contract read, the kind it expects, and the verbs that take the file", () => {
    const error = thrown(() => parseCatalogue(swapped));
    expect(error).toBeInstanceOf(IssueShapeError);
    expect(error.message).toContain("the wrong kind of catalogue was passed");
    expect(error.message).toContain("'hatsu.pr-sections/v1'");
    expect(error.message).toContain("this verb reads an issue-sections catalogue");
    expect(error.message).toContain("'nen pr sections resolve' and 'nen pr sections family'");
    // The field-level message it replaces is gone: that was the misleading one.
    expect(error.message).not.toContain("needs 'title'");
  });

  it("pr body-check refuses it as a usage error, exit 2, naming the file", async () => {
    const catalogue = file(swapped);
    const result = await run(["pr", "body-check", "--body-from", file("## How to verify\n"), "--requirements-from", file([{ name: "verify", pattern: "^## How to verify$" }]), "--criteria", "AC-1", "--catalogue", catalogue]);
    expect(result.code).toBe(2);
    expect(result.err).toContain(catalogue);
    expect(result.err).toContain("the wrong kind of catalogue was passed");
    expect(result.err).toContain("'hatsu.pr-sections/v1'");
    expect(result.err).toContain("an issue-sections catalogue");
    expect(result.err).toContain("'nen pr sections resolve'");
    expect(result.out).toBe("");
  });
});

describe("AC-2: a PR-sections reader handed an issue-sections catalogue", () => {
  const swapped = { contract: "hatsu.issue-sections/v1", ...ISSUE_SECTIONS };

  it("the loader names the contract read, the kind it expects, and the verbs that take the file", () => {
    const error = thrown(() => parseSectionCatalogue("catalogue.json", swapped));
    expect(error).toBeInstanceOf(SchemaError);
    expect((error as SchemaError).pointer).toBeNull();
    expect(error.message.startsWith("catalogue.json: the wrong kind of catalogue was passed")).toBe(true);
    expect(error.message).toContain("the wrong kind of catalogue was passed");
    expect(error.message).toContain("'hatsu.issue-sections/v1'");
    expect(error.message).toContain("this verb reads a PR-sections catalogue");
    expect(error.message).toContain("the --catalogue of 'nen pr body-check', 'nen pr converge' and 'nen pr merge'");
    expect(error.message).not.toContain("expected an array");
  });

  it("pr sections resolve and pr sections family both refuse it, at the exit an invalid catalogue already has", async () => {
    const catalogue = file(swapped);
    const resolve = await run(["pr", "sections", "resolve", "--catalogue", catalogue, "--kind", "library", "--family", "machinery"]);
    const family = await run(["pr", "sections", "family", "--catalogue", catalogue, "--taxonomy", join(process.cwd(), "src/classify/fixtures/mini.taxonomy.json"), "--jobs", "build"]);
    for (const result of [resolve, family]) {
      expect(result.code).toBe(1);
      expect(result.err).toContain(catalogue);
      expect(result.err).toContain("the wrong kind of catalogue was passed");
      expect(result.err).toContain("'hatsu.issue-sections/v1'");
      expect(result.err).toContain("a PR-sections catalogue");
      expect(result.err).toContain("'nen pr body-check'");
      expect(result.out).toBe("");
    }
  });
});

describe("AC-3: a catalogue that declares no contract keeps today's field-level validation", () => {
  it("the issue-sections reader still names the inner field of an undeclared PR-sections file", async () => {
    const error = thrown(() => parseCatalogue(PR_SECTIONS));
    expect(error).toBeInstanceOf(IssueShapeError);
    expect(error.message).toBe("section 'verify' needs 'title': a heading's words, or a non-empty array of them.");
    const result = await run(["pr", "body-check", "--body-from", file("## How to verify\n"), "--requirements-from", file([{ name: "verify", pattern: "^## How to verify$" }]), "--criteria", "AC-1", "--catalogue", file(PR_SECTIONS)]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("section 'verify' needs 'title'");
    expect(result.err).not.toContain("wrong kind of catalogue");
  });

  it("the PR-sections reader still names the inner field of an undeclared issue-sections file, at exit 1", async () => {
    const error = thrown(() => parseSectionCatalogue("catalogue.json", ISSUE_SECTIONS));
    expect(error).toBeInstanceOf(SchemaError);
    expect(error.message).toContain("at sections, expected an array");
    const result = await run(["pr", "sections", "resolve", "--catalogue", file(ISSUE_SECTIONS), "--kind", "library", "--family", "machinery"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("at sections, expected an array");
    expect(result.err).not.toContain("wrong kind of catalogue");
  });

  it("a contract naming neither kind is left to field-level validation too", () => {
    expect(thrown(() => parseCatalogue({ contract: "acme.labels/v1", ...PR_SECTIONS })).message).toContain("needs 'title'");
    expect(thrown(() => parseSectionCatalogue("catalogue.json", { contract: "acme.labels/v1", ...ISSUE_SECTIONS })).message).toContain("at sections, expected an array");
  });

  it("a catalogue of the expected kind loads as before, with or without its contract", () => {
    expect(parseCatalogue({ contract: "hatsu.issue-sections/v1", ...ISSUE_SECTIONS }).contract).toBe("hatsu.issue-sections/v1");
    expect(parseCatalogue(ISSUE_SECTIONS).contract).toBeNull();
    expect(parseSectionCatalogue("catalogue.json", { contract: "hatsu.pr-sections/v1", ...PR_SECTIONS }).max).toBe(7);
    expect(parseSectionCatalogue("catalogue.json", PR_SECTIONS).max).toBe(7);
  });

  it("a malformed PR-sections catalogue that declares its own kind stays a schema refusal at exit 1", async () => {
    const result = await run(["pr", "sections", "resolve", "--catalogue", file({ contract: "hatsu.pr-sections/v1", ...PR_SECTIONS, max: 0 }), "--kind", "process", "--family", "canon"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("at max, expected a positive safe integer");
  });
});

describe("AC-4: the usage reference documents both refusals", () => {
  const usage = readFileSync(join(process.cwd(), "docs/USAGE.md"), "utf8");

  it("names the refusal under both verbs and at the catalogue's own entry", () => {
    const occurrences = usage.split("the wrong kind of catalogue was passed").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3);
    expect(usage).toContain('<a id="a-catalogue-of-the-other-kind"></a>');
  });
});
