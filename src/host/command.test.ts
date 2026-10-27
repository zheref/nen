import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { UsageError } from "../cli/args.js";
import { VerbUsageError } from "../cli/command.js";
import { standalone, standaloneMain } from "./entry.js";
import type { EntryRuntime } from "./execute.js";
import { HostRefusal, initStore, reserve, slots } from "./store.js";
const roots: string[] = [];
afterEach((): void => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function capture(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const code = await run(["host", ...argv], { out: (text): void => { out.push(text); }, err: (text): void => { err.push(text); } }, new ScriptedSeams([], { env }));
  return { code, out: out.join("\n"), err: err.join("\n") };
}
describe("host CLI contract", (): void => {
  it("provisions only when explicitly asked and returns the same host budget through status", async (): Promise<void> => {
    const directory = mkdtempSync(join(tmpdir(), "nen-host-command-")); roots.push(directory); const store = join(directory, "budget");
    const init = await capture(["init", "--store", store, "--json"]);
    expect(init.code, init.err).toBe(0); expect(JSON.parse(init.out).config.capacity).toBe(1);
    const status = await capture(["status", "--json"], { NEN_HOST_STORE: store });
    expect(status.code, status.err).toBe(0); expect(JSON.parse(status.out).owners).toEqual([]);
    expect(JSON.parse(status.out).config.hostId).toBe(JSON.parse(init.out).config.hostId);
    expect((await capture(["init", "--store", store])).code).toBe(1);
  });
  it("refuses absent state and unsupported flags without running a workload", async (): Promise<void> => {
    expect((await capture(["status"])).err).toMatch(/missing/);
    expect((await capture(["status", "--capacity", "2"])).code).toBe(2);
    expect((await capture(["init", "--store", "/unused", "--capacity", "0"])).code).toBe(2);
    expect((await capture(["run", "command-before-separator"])).code).toBe(2);
    expect((await capture(["run", "--json", "--", "anything"])).code).toBe(2);
    expect((await capture(["run"])).code).toBe(2);
    expect((await capture(["_exec", "--slot", "0", "--claim", "x", "--", "anything"])).code).toBe(2);
    expect((await capture(["status", "--", "anything"])).code).toBe(2);
  });
  it("describes shared provisioning, nested validation, refusal and containment limits", async (): Promise<void> => {
    const result = await capture(["--help"]); expect(result.code).toBe(0);
    for (const text of ["NEN_HOST_STORE", "capacity 1", "wait 0ms", "coordinator", "Windows", "escaping"]) expect(result.out).toContain(text);
  });
});

// These invoke the real dependency-free adapter in this instrumented process.
// They neither pretend to be import.meta.main nor launch a subprocess.
describe("standalone host entry adapter", (): void => {
  beforeEach((): void => {
    vi.stubEnv("NEN_HOST_STORE", undefined); vi.stubEnv("NEN_HOST_CLAIM", undefined); vi.stubEnv("NEN_HOST_SLOT", undefined);
  });
  function fixture(): ReturnType<typeof initStore> {
    const root = mkdtempSync(join(tmpdir(), "nen-host-standalone-")); roots.push(root);
    return initStore(join(root, "budget"));
  }
  const runtime = (): EntryRuntime => ({ executable: join(tmpdir(), "bun"), standalone: false, entrypoint: join(tmpdir(), "host-entry.ts") });
  it("main-mode help returns success without changing the process exit code", (): void => {
    const before = process.exitCode;
    const out = vi.spyOn(console, "log").mockImplementation((): void => {});
    const err = vi.spyOn(console, "error").mockImplementation((): void => {});
    expect(standaloneMain(["--help"], runtime)).toBe(0);
    expect(out).toHaveBeenCalledWith(expect.stringContaining("nen host init"));
    expect(err).not.toHaveBeenCalled(); expect(process.exitCode).toBe(before);
  });
  it("main mode delegates JSON status to the real standalone action", (): void => {
    const store = fixture(); const out = vi.spyOn(console, "log").mockImplementation((): void => {});
    const err = vi.spyOn(console, "error").mockImplementation((): void => {});
    expect(standaloneMain(["status", "--store", store.root, "--json"], runtime)).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({ contract: "nen.host.status/v0.1", root: store.root, owners: [] });
    expect(err).not.toHaveBeenCalled(); expect(slots(store)).toEqual([]);
  });
  it("main mode maps real parser and action usage errors to exit two with the host prefix", (): void => {
    const out = vi.spyOn(console, "log").mockImplementation((): void => {});
    const err = vi.spyOn(console, "error").mockImplementation((): void => {});
    for (const argv of [["status", "--unknown"], ["invented"]]) {
      err.mockClear();
      expect(standaloneMain(argv, runtime)).toBe(2);
      expect(err).toHaveBeenCalledTimes(1);
      expect(err.mock.calls[0]?.[0]).toMatch(/^nen host: (?:unknown option|unknown 'host' subcommand)/);
    }
    expect(out).not.toHaveBeenCalled();
  });
  it("main mode maps an actual missing-store refusal to exit one", (): void => {
    const out = vi.spyOn(console, "log").mockImplementation((): void => {});
    const err = vi.spyOn(console, "error").mockImplementation((): void => {});
    expect(standaloneMain(["status"], runtime)).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/^nen host: .*missing/));
    expect(out).not.toHaveBeenCalled();
  });
  it("keeps runtime descriptor construction and invocation refusal inside the main error boundary", (): void => {
    const out = vi.spyOn(console, "log").mockImplementation((): void => {});
    const err = vi.spyOn(console, "error").mockImplementation((): void => {});
    expect(standaloneMain(["--help"], (): EntryRuntime => { throw new Error("runtime descriptor unavailable"); })).toBe(1);
    expect(err).toHaveBeenLastCalledWith("nen host: runtime descriptor unavailable");
    expect(standaloneMain(["--help"], (): EntryRuntime => ({ ...runtime(), standalone: undefined }))).toBe(1);
    expect(err).toHaveBeenLastCalledWith(expect.stringMatching(/^nen host: current runtime/));
    expect(standaloneMain(["--help"], (): EntryRuntime => ({ ...runtime(), entrypoint: "relative.ts" }))).toBe(1);
    expect(err).toHaveBeenLastCalledWith(expect.stringMatching(/^nen host: source supervisor entrypoint must be absolute/));
    expect(out).not.toHaveBeenCalled();
  });
  it("reports an unexpected output-channel failure without escaping the main boundary", (): void => {
    vi.spyOn(console, "log").mockImplementation((): never => { throw new Error("output channel unavailable"); });
    const err = vi.spyOn(console, "error").mockImplementation((): void => {});
    expect(standaloneMain(["--help"], runtime)).toBe(1);
    expect(err).toHaveBeenCalledWith("nen host: output channel unavailable");
  });
  it("normalizes a non-Error runtime failure through the original error path", (): void => {
    const err = vi.spyOn(console, "error").mockImplementation((): void => {});
    expect(standaloneMain(["--help"], (): EntryRuntime => { throw "runtime failure"; })).toBe(1);
    expect(err).toHaveBeenCalledWith("nen host: runtime failure");
  });
  it("prints help without opening or provisioning the configured missing store", (): void => {
    const root = mkdtempSync(join(tmpdir(), "nen-host-help-")); roots.push(root); const missing = join(root, "absent");
    vi.stubEnv("NEN_HOST_STORE", missing);
    const out = vi.spyOn(console, "log").mockImplementation((): void => {});
    const err = vi.spyOn(console, "error").mockImplementation((): void => {});
    expect(standalone(["--help"])).toBe(0);
    expect(out).toHaveBeenCalledTimes(1);
    expect(out.mock.calls[0]?.[0]).toContain("nen host run");
    expect(err).not.toHaveBeenCalled(); expect(existsSync(missing)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
  it("returns JSON status of its owned store without mutating configuration or occupied claims", (): void => {
    const store = fixture(); const reservation = reserve(store, "standalone status owner", { pid: 100, pgid: 100, started: "synthetic fixture" });
    vi.stubEnv("NEN_HOST_STORE", store.root);
    const configPath = join(store.root, "config.json"); const claimPath = join(store.root, "slots", "1.json");
    const before = { config: readFileSync(configPath, "utf8"), claim: readFileSync(claimPath, "utf8"), files: readdirSync(store.root) };
    const out = vi.spyOn(console, "log").mockImplementation((): void => {});
    const err = vi.spyOn(console, "error").mockImplementation((): void => {});
    const invocation = { exe: join(store.root, "unused-runtime"), argv: ["host", "_exec"] };
    expect(standalone(["status", "--json"], invocation)).toBe(0);
    expect(out).toHaveBeenCalledTimes(1);
    const report = JSON.parse(String(out.mock.calls[0]?.[0]));
    expect(report.contract).toBe("nen.host.status/v0.1"); expect(report.config).toEqual(store.config);
    expect(report.owners).toEqual([{ slot: 1, claim: reservation.claim, problem: null }]);
    expect(readFileSync(configPath, "utf8")).toBe(before.config); expect(readFileSync(claimPath, "utf8")).toBe(before.claim);
    expect(readdirSync(store.root)).toEqual(before.files); expect(err).not.toHaveBeenCalled();
  });
  it("exposes real parser and action refusals to the entry caller without printing a successful result", (): void => {
    const out = vi.spyOn(console, "log").mockImplementation((): void => {});
    for (const argv of [["status", "--unknown"], ["status", "--store"]]) {
      expect((): number => standalone(argv)).toThrow(UsageError);
    }
    for (const argv of [[], ["invented"], ["status", "--capacity", "2"], ["run", "before-separator"], ["status", "--", "payload"]]) {
      expect((): number => standalone(argv)).toThrow(VerbUsageError);
    }
    expect(out).not.toHaveBeenCalled();
  });
  it("refuses an absent supervisor adapter before capacity acquisition or payload execution", (): void => {
    const store = fixture(); const out = vi.spyOn(console, "log").mockImplementation((): void => {});
    expect((): number => standalone(["run", "--store", store.root, "--", "must-never-be-launched"]))
      .toThrow(HostRefusal);
    expect((): number => standalone(["run", "--store", store.root, "--", "must-never-be-launched"]))
      .toThrow(/entry adapter.*no capacity was acquired/);
    expect(slots(store)).toEqual([]); expect(out).not.toHaveBeenCalled();
  });
});
