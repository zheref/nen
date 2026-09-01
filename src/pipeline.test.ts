// src/pipeline.test.ts -- the guards for the facts that are deliberately
// restated in more than one place.
//
// THE RESTATEMENTS ARE ON PURPOSE, AND SO IS THIS FILE. The release pipeline's
// completeness check spells the three artifact filenames as literals rather than
// deriving them from package.json, for a stated reason: "a check that reads its
// expectations from the table it is checking is a tautology and would pass
// unchanged if a target were deleted from that table". The same argument makes
// the bootstrap script restate them a third time.
//
// That argument is right, and it leaves a gap: three independent copies can
// DRIFT, and nothing in the pipeline notices until a consumer's platform 404s at
// bootstrap time. This file is the fourth party — it derives nothing and checks
// nothing at build time; it simply compares the copies and fails the build when
// they disagree. It does not make any of them a tautology, because it is not one
// of them.
//
// Likewise the bun pin. Two workflows carry it, and the comment in each says
// "bump them in the same pull request or not at all" — which is a comment, and a
// comment is not a guard. If the pins drift, the code CI checked and the binary
// a consumer downloads were built by different compilers while both workflows
// stay green. That is precisely the failure a comment cannot prevent.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml, type YamlValue } from "./schema/yaml.js";

const ROOT = process.cwd();

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), "utf8");
}

function yaml(...parts: string[]): Record<string, YamlValue> {
  const value = parseYaml(read(...parts));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${parts.join("/")} is not a mapping`);
  }
  return value as Record<string, YamlValue>;
}

const CI = ".github/workflows/ci.yml";
const RELEASE = ".github/workflows/release-assets.yml";

// The published filename contract, stated HERE for a fourth time -- which is the
// point: a comparison needs something to compare against, and a list derived
// from one of the three copies would silently bless that copy.
const ARTIFACTS = [
  "nen-darwin-arm64",
  "nen-linux-x64",
  "nen-windows-x64.exe",
] as const;

describe("the published filename contract", () => {
  it("is spelled identically by package.json's build scripts", () => {
    const pkg: unknown = JSON.parse(read("package.json"));
    const scripts = (pkg as { scripts: Record<string, string> }).scripts;
    expect(scripts["build:darwin-arm64"]).toContain("dist/nen-darwin-arm64");
    expect(scripts["build:linux-x64"]).toContain("dist/nen-linux-x64");
    expect(scripts["build:windows-x64"]).toContain("dist/nen-windows-x64.exe");
  });

  it("is spelled identically by the release pipeline's manifest and upload", () => {
    const source = read(RELEASE);
    for (const artifact of ARTIFACTS) {
      // Three times each: the sha256sum list, the completeness `printf`, and the
      // upload. Fewer than three means one of them lost a target.
      const occurrences = source.split(`'${artifact}'`).length - 1;
      expect(occurrences, artifact).toBeGreaterThanOrEqual(3);
    }
  });

  it("is spelled identically by the bootstrap script", () => {
    const source = read("bootstrap", "nen.sh");
    for (const artifact of ARTIFACTS) {
      expect(source, artifact).toContain(`"${artifact}"`);
    }
  });

  it("names no artifact any of the three copies does not", () => {
    // The other direction: a name that appears in the pipeline but nowhere else
    // would ship an asset the bootstrap can never ask for.
    const pipeline = read(RELEASE);
    const named = new Set(
      [...pipeline.matchAll(/'(nen-[a-z0-9.-]+)'/g)].map((match): string => match[1] ?? ""),
    );
    expect([...named].sort()).toEqual([...ARTIFACTS].sort());
  });
});

describe("the bun pin", () => {
  it("is identical in both workflows", () => {
    // If these drift, the code CI checked and the binary a consumer downloads
    // were compiled by different compilers, and both workflows stay green.
    const ci = yaml(CI);
    const release = yaml(RELEASE);
    const ciPin = (ci["env"] as Record<string, YamlValue>)["BUN_VERSION"];
    const publish = (release["jobs"] as Record<string, YamlValue>)["publish"];
    const releasePin = ((publish as Record<string, YamlValue>)["env"] as Record<string, YamlValue>)[
      "BUN_VERSION"
    ];
    expect(ciPin).toBe(releasePin);
    expect(typeof ciPin).toBe("string");
  });

  it("matches what package.json says the runtime must be", () => {
    const pkg: unknown = JSON.parse(read("package.json"));
    const engines = (pkg as { engines?: Record<string, string> }).engines;
    expect(engines?.["bun"]).toBeDefined();
    const ci = yaml(CI);
    const pin = String((ci["env"] as Record<string, YamlValue>)["BUN_VERSION"]);
    // `>=X` and a pin of exactly X is the intended relationship; this catches a
    // pin BELOW the declared floor, which would mean CI verifies on a runtime
    // the package says it does not support.
    expect(engines?.["bun"]).toBe(`>=${pin}`);
  });
});

describe("the release pipeline never authors a release decision", () => {
  const source = read(RELEASE);

  it("creates no release", () => {
    // The go/no-go is the human's, and a marker tag is a deliberate
    // non-release. A workflow that created one would silently promote every
    // marker into the thing it is not.
    expect(source).not.toMatch(/gh release create/);
    expect(source).not.toMatch(/softprops\/action-gh-release/);
    expect(source).not.toMatch(/actions\/create-release/);
  });

  it("warns rather than failing when there is no release for the tag", () => {
    expect(source).toMatch(/::warning title=No release for/);
  });

  it("uploads only when the probe found a release", () => {
    expect(source).toMatch(/if: steps\.release_probe\.outcome == 'success'/);
    expect(source).toMatch(/if: steps\.release_probe\.outcome != 'success'/);
  });

  it("builds the manifest from a literal list, never a glob", () => {
    // A glob would silently produce a shorter manifest if a target were
    // missing -- and a manifest derived from whatever is on disk cannot catch
    // that, because it would agree with itself.
    expect(source).not.toMatch(/sha256sum\s+(-\S+\s+)*\*/);
    expect(source).toMatch(/sha256sum -c --strict SHA256SUMS/);
    expect(source).toMatch(/diff -u/);
  });

  it("keeps the permission floor at contents: read with one elevation", () => {
    const release = yaml(RELEASE);
    expect(release["permissions"]).toEqual({ contents: "read" });
    const jobs = release["jobs"] as Record<string, YamlValue>;
    const publish = jobs["publish"] as Record<string, YamlValue>;
    expect(publish["permissions"]).toEqual({ contents: "write" });
    expect(Object.keys(jobs)).toEqual(["publish"]);
  });

  it("serializes per tag and never cancels an upload in flight", () => {
    // Cancelling mid-upload leaves a release carrying two binaries and no
    // SHA256SUMS -- the "silently ships two of three" state, arrived at from the
    // other direction.
    const release = yaml(RELEASE);
    const concurrency = release["concurrency"] as Record<string, YamlValue>;
    expect(concurrency["cancel-in-progress"]).toBe(false);
  });

  it("has no workflow_call trigger, so no consumer can be coupled to it", () => {
    const on = yaml(RELEASE)["on"] as Record<string, YamlValue>;
    expect(Object.keys(on).sort()).toEqual(["push", "release", "workflow_dispatch"]);
  });
});

describe("ci runs the same three commands a developer runs", () => {
  const ci = yaml(CI);

  it("invokes the package scripts by name rather than re-spelling them", () => {
    const source = read(CI);
    for (const command of ["bun run typecheck", "bun run lint", "bun run test"]) {
      expect(source).toContain(command);
    }
  });

  it("runs on pull requests and on pushes to main", () => {
    const on = ci["on"] as Record<string, YamlValue>;
    expect(Object.keys(on).sort()).toEqual(["pull_request", "push"]);
    expect((on["push"] as Record<string, YamlValue>)["branches"]).toEqual(["main"]);
  });

  it("covers both a POSIX and a Windows host", () => {
    const jobs = ci["jobs"] as Record<string, YamlValue>;
    const check = jobs["check"] as Record<string, YamlValue>;
    const strategy = check["strategy"] as Record<string, YamlValue>;
    const matrix = strategy["matrix"] as Record<string, YamlValue>;
    expect(matrix["os"]).toEqual(["ubuntu-latest", "windows-latest"]);
  });

  it("grants nothing above contents: read", () => {
    expect(ci["permissions"]).toEqual({ contents: "read" });
  });
});

describe("AK-11: the shell allowlist", () => {
  it("has exactly one shell file in the repository", () => {
    // "Only bootstrap-class shell may exist at all." A second .sh appearing is a
    // review finding by construction, not by anybody remembering to look.
    const tracked = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
    const files = (tracked.stdout ?? "")
      .split("\n")
      .filter((line): boolean => line.trim() !== "");
    expect(files.length).toBeGreaterThan(10);
    const shell = files.filter((file): boolean => /\.(sh|bash|zsh)$/.test(file));
    expect(shell).toEqual(["bootstrap/nen.sh"]);
  });

  it("keeps the one shell file executable in the index", () => {
    // `chmod +x` is a no-op on a Windows checkout, so the mode has to be
    // asserted from the INDEX. A 100644 bootstrap is a bootstrap a consumer
    // cannot run.
    const listed = spawnSync("git", ["ls-files", "-s", "bootstrap/nen.sh"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(listed.stdout ?? "").toMatch(/^100755 /);
  });
});
