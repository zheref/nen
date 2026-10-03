// The preflight workflow, rendered from the candidate template Hatsu ships,
// held to a golden file and to the facts this repository's own runner policy
// (../ci/runner-policy.test.ts) demands of every workflow in
// .github/workflows: the allowed events, the canonical-repository job guard,
// one exact self-hosted label set, and no persisted checkout credentials.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { differingLines, PLACEHOLDERS, renderWorkflow, workflowValues } from "./workflow.js";
import { FIXTURES, lf, pool, TARGET } from "./testkit.js";

const TEMPLATE = lf(readFileSync(join(FIXTURES, "runner-preflight.template.yml"), "utf8"));

function golden(name: string, text: string): void {
  const path = join(FIXTURES, name);
  if (process.env["NEN_UPDATE_GOLDEN"] === "1") writeFileSync(path, text);
  expect(text).toBe(lf(readFileSync(path, "utf8")));
}

type Row = Record<string, unknown>;

describe("renderWorkflow -- the template's eight placeholders, filled from the declaration", () => {
  const rendered = renderWorkflow(TEMPLATE, workflowValues(pool("windows-x64"), TARGET, "0.0.0-test"));

  it("uses every placeholder the renderer fills, and nothing else", () => {
    const used = [...new Set([...TEMPLATE.matchAll(/@@([A-Z_]+)@@/g)].map((match) => match[1]))].sort();
    expect(used).toEqual([...PLACEHOLDERS].sort());
  });

  it("renders zheref/nen's windows-x64 preflight byte-for-byte", () => {
    expect(rendered.leftovers).toEqual([]);
    expect(rendered.yamlError).toBeNull();
    golden("runner-preflight-windows-x64.golden.yml", rendered.text);
  });

  it("satisfies the runner policy's rules: events, guard, runs-on, credentials", () => {
    const document = parse(rendered.text) as Row;
    expect(Object.keys(document["on"] as Row).sort()).toEqual(["push", "workflow_dispatch"]);
    expect((document["on"] as Row)["workflow_dispatch"]).toBeNull();
    expect((document["on"] as Row)["push"]).toEqual({ paths: [".github/workflows/runner-preflight-windows-x64.yml"] });
    expect(document["permissions"]).toEqual({ contents: "read" });
    expect(document["concurrency"]).toEqual({ group: "runner-preflight-windows-x64-${{ github.ref }}", "cancel-in-progress": true });
    const jobs = document["jobs"] as Row;
    expect(Object.keys(jobs)).toEqual(["preflight"]);
    const job = jobs["preflight"] as Row;
    expect(job["if"]).toBe("github.repository == 'zheref/nen'");
    expect(job["runs-on"]).toEqual(["self-hosted", "Windows", "X64"]);
    expect(job["timeout-minutes"]).toBe(5);
    const steps = job["steps"] as Row[];
    const checkout = steps.find((step) => typeof step["uses"] === "string" && (step["uses"] as string).startsWith("actions/checkout@"));
    expect(checkout?.["uses"]).toBe("actions/checkout@v4");
    expect((checkout?.["with"] as Row)["persist-credentials"]).toBe(false);
    // Every run step pins bash: Actions defaults to pwsh on Windows.
    for (const step of steps.filter((candidate) => candidate["run"] !== undefined)) expect(step["shell"]).toBe("bash");
    const env = steps.map((step) => step["env"] as Row | undefined).filter((value): value is Row => value !== undefined);
    expect(env).toContainEqual({ TOOLS: "git bash gh", MODE: "service" });
    expect(env).toContainEqual({ EXPECTED_OS: "Windows" });
  });

  it("renders a macOS pool with its own labels and file, and keeps the Windows-only step gated", () => {
    const mac = renderWorkflow(TEMPLATE, workflowValues(pool("macos-arm64"), TARGET, "0.0.0-test"));
    const job = ((parse(mac.text) as Row)["jobs"] as Row)["preflight"] as Row;
    expect(job["runs-on"]).toEqual(["self-hosted", "macOS", "ARM64"]);
    expect(mac.text).toContain("'.github/workflows/runner-preflight-macos-arm64.yml'");
    const gated = (job["steps"] as Row[]).filter((step) => step["if"] !== undefined).map((step) => step["if"]);
    expect(gated).toEqual(["runner.os == 'Windows'", "runner.os == 'Windows' && 'interactive' == 'interactive'", "runner.os != 'Windows'"]);
  });

  it("renders an interactive Windows pool's four labels and switches its desktop-session probe on (#333)", () => {
    const desktop = renderWorkflow(TEMPLATE, workflowValues(pool("windows-x64-desktop"), TARGET, "0.0.0-test"));
    expect(desktop.leftovers).toEqual([]);
    expect(desktop.yamlError).toBeNull();
    golden("runner-preflight-windows-x64-desktop.golden.yml", desktop.text);
    const job = ((parse(desktop.text) as Row)["jobs"] as Row)["preflight"] as Row;
    expect(job["runs-on"]).toEqual(["self-hosted", "Windows", "X64", "desktop"]);
    const probe = (job["steps"] as Row[]).find((step) => step["name"] === "Desktop session present (interactive Windows pool)");
    expect(probe?.["if"]).toBe("runner.os == 'Windows' && 'interactive' == 'interactive'");
    expect(probe?.["shell"]).toBe("bash");
    expect(probe?.["run"]).toMatch(/GetCurrentProcess\(\)\.SessionId/);
    expect(probe?.["run"]).toMatch(/if \[ -z "\$session" \] \|\| \[ "\$session" = "0" \]; then/);
    // Remediation is mode-aware: a logon task is restarted by signing in again, and
    // an AppData hit is a warning for the account the runner runs as.
    const steps = job["steps"] as Row[];
    const toolchain = steps.find((step) => step["name"] === "Host toolchain -- every tool a job on this pool invokes");
    expect(toolchain?.["env"]).toEqual({ TOOLS: "git bash gh", MODE: "interactive" });
    expect(toolchain?.["run"]).toMatch(/sign the runner's account \(\$acct\) out and back in, which restarts its logon task/);
    const appdata = steps.find((step) => step["name"] === "Resolution must be machine-wide (Windows)");
    expect(appdata?.["run"]).toMatch(/if \[ "\$MODE" = interactive \]; then\n\s+echo "::warning::/);
  });

  it("keeps the probe off for a service pool: its condition is false once rendered", () => {
    const service = renderWorkflow(TEMPLATE, workflowValues(pool("windows-x64"), TARGET, "0.0.0-test"));
    const job = ((parse(service.text) as Row)["jobs"] as Row)["preflight"] as Row;
    const probe = (job["steps"] as Row[]).find((step) => step["name"] === "Desktop session present (interactive Windows pool)");
    expect(probe?.["if"]).toBe("runner.os == 'Windows' && 'service' == 'interactive'");
  });

  it("still renders a template that predates @@MODE@@", () => {
    const old = renderWorkflow(TEMPLATE.replace(/@@MODE@@/g, "service"), workflowValues(pool("windows-x64"), TARGET, "v"));
    expect(old.leftovers).toEqual([]);
    expect(old.yamlError).toBeNull();
  });

  it("reports an unknown placeholder once, and a document that is not YAML", () => {
    const leftover = renderWorkflow("name: @@POOL_ID@@\nx: @@NOPE@@\ny: @@NOPE@@\n", workflowValues(pool("windows-x64"), TARGET, "v"));
    expect(leftover.leftovers).toEqual(["@@NOPE@@"]);
    const broken = renderWorkflow("a: [unclosed\n", {});
    expect(broken.yamlError).not.toBeNull();
  });

  it("counts differing lines as a multiset", () => {
    expect(differingLines("a\nb\nc", "a\nb\nc")).toBe(0);
    expect(differingLines("a\nb\nc", "a\nx\nc")).toBe(2);
    expect(differingLines("a\r\nb", "a\nb")).toBe(0);
  });
});
