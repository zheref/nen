import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ci } from "./ci.js";
import { standalone } from "./entry.js";
import { spawnInteractiveRunner } from "../seam/exec.js";
import { initStore, openStore, reserve, slots } from "./store.js";
vi.mock("./entry.js", (): object => ({ standalone: vi.fn((): number => 0) }));
vi.mock("../seam/exec.js", (): object => ({ spawnInteractiveRunner: vi.fn((): object => ({ code: 0, signal: null, spawnFailed: false })) }));
const roots: string[] = [];
beforeEach((): void => { vi.stubEnv("NEN_HOST_CLAIM", undefined); vi.stubEnv("NEN_HOST_SLOT", undefined); });
afterEach((): void => { vi.unstubAllEnvs(); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("CI uses the same host boundary before dependency install", (): void => {
  it("inactive POSIX CI visibly reports unavailable admission and keeps the legacy command", (): void => {
    vi.stubEnv("RUNNER_ENVIRONMENT", "self-hosted"); vi.stubEnv("NEN_HOST_ADMISSION", "");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((): boolean => true);
    try {
      expect(ci(["placeholder-test", "argument"])).toBe(0);
      expect(spawnInteractiveRunner).toHaveBeenCalledWith("placeholder-test", ["argument"]);
      expect(standalone).not.toHaveBeenCalled();
      expect(stderr.mock.calls.flat().join(" ")).toMatch(/admission unavailable.*serialized fallback required.*unprotected/);
    } finally { stderr.mockRestore(); }
  });
  it("keeps inherited active CI ownership enforced even when rollout activation is cleared", (): void => {
    vi.stubEnv("NEN_HOST_ADMISSION", ""); vi.stubEnv("NEN_HOST_CLAIM", "inherited"); vi.stubEnv("NEN_HOST_SLOT", "1");
    expect(ci(["placeholder-test"])).toBe(0);
    expect(standalone).toHaveBeenCalledWith(["run", "--", "placeholder-test"]);
    expect(spawnInteractiveRunner).not.toHaveBeenCalled();
  });
  it("refuses invalid activation before either a guarded or legacy child starts", (): void => {
    vi.stubEnv("NEN_HOST_ADMISSION", "enable");
    expect((): unknown => ci(["placeholder-test"])).toThrow(/invalid activation/);
    expect(standalone).not.toHaveBeenCalled(); expect(spawnInteractiveRunner).not.toHaveBeenCalled();
  });
  it("an active guard failure never falls back to an unprotected command", (): void => {
    vi.stubEnv("NEN_HOST_ADMISSION", "enabled"); vi.stubEnv("RUNNER_ENVIRONMENT", "self-hosted");
    vi.mocked(standalone).mockImplementationOnce((): never => { throw new Error("unreadable activated store"); });
    expect((): unknown => ci(["placeholder-test"])).toThrow(/unreadable activated store/);
    expect(spawnInteractiveRunner).not.toHaveBeenCalled();
  });
  it("never invents a fallback host store for a self-hosted runner", (): void => {
    vi.stubEnv("RUNNER_ENVIRONMENT", "self-hosted"); vi.stubEnv("NEN_HOST_STORE", ""); vi.stubEnv("NEN_HOST_ADMISSION", "enabled");
    expect(ci(["placeholder-command"])).toBe(0);
    expect(standalone).toHaveBeenCalledWith(["run", "--", "placeholder-command"]);
    expect(process.env.NEN_HOST_STORE).toBe("");
  });
  it("provisions one disposable hosted budget and preserves unresolved prior-step ownership", (): void => {
    const root = mkdtempSync(join(tmpdir(), "nen-host-ci-")); roots.push(root);
    vi.stubEnv("RUNNER_ENVIRONMENT", "github-hosted"); vi.stubEnv("RUNNER_TEMP", root); vi.stubEnv("NEN_HOST_ADMISSION", "enabled");
    expect(ci(["placeholder-install"])).toBe(0);
    const store = openStore(join(root, "nen-host-budget")); reserve(store, "unresolved prior CI step", { pid: 10, pgid: 10, started: "synthetic" });
    expect(ci(["placeholder-test"])).toBe(0); expect(slots(openStore(store.root))).toHaveLength(1);
    expect(process.env.NEN_HOST_STORE).toBe(store.root);
  });
  it("refuses a missing command or a hosted job with no absolute temp root", (): void => {
    expect((): unknown => ci([])).toThrow(/executable/);
    vi.stubEnv("RUNNER_ENVIRONMENT", "github-hosted"); vi.stubEnv("RUNNER_TEMP", "relative"); vi.stubEnv("NEN_HOST_ADMISSION", "enabled");
    expect((): unknown => ci(["placeholder-command"])).toThrow(/absolute/);
  });
  it("keeps the live CI install, verification and compile commands behind the host boundary", (): void => {
    const document = parse(readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8")) as { env: Record<string, string>; jobs: Record<string, { steps: { run?: string }[] }> };
    expect(document.env.NEN_HOST_STORE).toBe("${{ vars.NEN_HOST_STORE }}");
    expect(document.env.NEN_HOST_ADMISSION).toBe("${{ vars.NEN_HOST_ADMISSION }}");
    for (const name of ["check", "compile"]) {
      const scripts = document.jobs[name]!.steps.map((step): string => step.run ?? "").join("\n");
      expect(scripts).toContain("bun src/host/ci.ts bun install --ignore-scripts --frozen-lockfile");
      for (const line of scripts.split("\n")) {
        if (/bun (?:run (?:typecheck|lint|test|build:)|install)|bunx vitest/.test(line)) expect(line).toContain("bun src/host/ci.ts");
      }
    }
  });
  it("keeps init separate from self-hosted execution and leaves configuration unchanged", (): void => {
    const root = mkdtempSync(join(tmpdir(), "nen-host-ci-config-")); roots.push(root); const store = initStore(join(root, "operator-budget"));
    vi.stubEnv("RUNNER_ENVIRONMENT", "self-hosted"); vi.stubEnv("NEN_HOST_STORE", store.root); vi.stubEnv("NEN_HOST_ADMISSION", "enabled");
    ci(["placeholder-command"]); expect(openStore(store.root).config).toEqual(store.config);
  });
});
