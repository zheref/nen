import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily } from "../index.js";
import { shuCommand } from "../shu/command.js";
import { ScriptedSeams } from "../seam/scripted.js";
import type { HostAdmission } from "./execute.js";
import { HostRefusal, initStore, slots } from "./store.js";
const roots: string[] = [];
afterEach((): void => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(stall = false): string {
  const directory = mkdtempSync(join(tmpdir(), "nen-host-shu-")); roots.push(directory); mkdirSync(join(directory, "nen"));
  const tool = { exe: "placeholder-tool", argv: ["run"] };
  const archive = { ...tool, ...(stall ? { stall: { elapsedMs: 1, quietMs: 1, maxStrikes: 1, onStall: { exe: "placeholder-remedy", argv: ["repair"] } } } : {}) };
  writeFileSync(join(directory, "nen", "contract.json"), JSON.stringify({ $schema: "nen.contract/v0.1", project: { lanes: { fixture: { stack: "fixture", cwd: "." } }, defaultLane: "fixture", verbs: { fixture: { test: tool, lint: tool, archive } } } }));
  return directory;
}

describe("Shu host admission boundary", (): void => {
  it("takes one claim before the declared heavy command and finishes it after execution", async (): Promise<void> => {
    const directory = fixture(); const scripted = new ScriptedSeams([{ match: "placeholder-tool run", result: { code: 0 } }]); const events: string[] = [];
    const hostAdmission: HostAdmission = (seams, owner) => { events.push(owner); expect(scripted.calls).toHaveLength(0); return { seams, finish(): void { events.push("finished"); expect(scripted.calls).toHaveLength(1); } }; };
    const code = await runFamily(shuCommand, ["shu", "test", "--heartbeat", "0"], directory, false, { out(): void {}, err(): void {} }, { ...scripted, hostAdmission });
    expect(code).toBe(0); expect(events).toEqual(["shu test (fixture)", "finished"]);
  });
  it("never admits or launches a dry run", async (): Promise<void> => {
    const directory = fixture(); const scripted = new ScriptedSeams([]);
    const hostAdmission: HostAdmission = () => { throw new Error("dry run must never acquire a claim"); };
    const code = await runFamily(shuCommand, ["shu", "test", "--dry-run"], directory, false, { out(): void {}, err(): void {} }, { ...scripted, hostAdmission });
    expect(code).toBe(0); expect(scripted.calls).toEqual([]);
  });
  it("refuses unreadable host capacity before any declared executable starts", async (): Promise<void> => {
    const directory = fixture(); const scripted = new ScriptedSeams([]); const errors: string[] = [];
    const hostAdmission: HostAdmission = () => { throw new HostRefusal("cannot read host state; nothing was launched"); };
    const code = await runFamily(shuCommand, ["shu", "test"], directory, false, { out(): void {}, err(line): void { errors.push(line); } }, { ...scripted, hostAdmission });
    expect(code).toBe(1); expect(scripted.calls).toEqual([]); expect(errors.join("\n")).toContain("cannot read host state");
  });
  it("leaves a light lint outside the heavy budget", async (): Promise<void> => {
    const directory = fixture(); const scripted = new ScriptedSeams([{ match: "placeholder-tool run", result: { code: 0 } }]);
    const hostAdmission: HostAdmission = () => { throw new Error("light lint must not acquire capacity"); };
    const code = await runFamily(shuCommand, ["shu", "lint", "--heartbeat", "0"], directory, false, { out(): void {}, err(): void {} }, { ...scripted, hostAdmission });
    expect(code).toBe(0);
  });
  it.each([{ NEN_HOST_ADMISSION: "enabled" }, { NEN_HOST_CLAIM: "inherited", NEN_HOST_SLOT: "1" }])("F2: refuses active or inherited stalled remedies before capacity or any heavy spawn (%j)", async (env): Promise<void> => {
    const directory = fixture(true); const store = initStore(join(directory, "budget")); const scripted = new ScriptedSeams([], { env: { ...env, NEN_HOST_STORE: store.root } }); const out: string[] = []; const errors: string[] = [];
    let capacityRequests = 0;
    const hostAdmission: HostAdmission = () => { capacityRequests += 1; throw new Error("must refuse before acquiring capacity"); };
    const code = await runFamily(shuCommand, ["shu", "archive", "--json", "--heartbeat", "0"], directory, true, { out(line): void { out.push(line); }, err(line): void { errors.push(line); } }, { ...scripted, hostAdmission });
    expect(code).toBe(2); expect(capacityRequests).toBe(0); expect(scripted.calls).toEqual([]); expect(slots(store)).toEqual([]);
    expect(errors.join("\n")).toMatch(/onStall.*NN538.*Nothing was launched.*no capacity/);
    const report = JSON.parse(out.join("\n")); expect(report.exitCode).toBe(2);
    expect(report.log.mode).toBe("dry-run"); expect(report.steps[0].exitCode).toBeNull();
  });
  it("F2: a dry run of an activated remedy row remains read-only and renderable", async (): Promise<void> => {
    const directory = fixture(true); const scripted = new ScriptedSeams([], { env: { NEN_HOST_ADMISSION: "enabled" } });
    const hostAdmission: HostAdmission = () => { throw new Error("dry run must not acquire capacity"); };
    expect(await runFamily(shuCommand, ["shu", "archive", "--dry-run"], directory, false, { out(): void {}, err(): void {} }, { ...scripted, hostAdmission })).toBe(0);
    expect(scripted.calls).toEqual([]);
  });
  it("F2: inactive streamed execution retains its declared remedy and ordinary result", async (): Promise<void> => {
    const directory = fixture(true);
    const scripted = new ScriptedSeams([
      { match: "placeholder-tool run", result: { code: 0, stream: { events: [{ atMs: 5 }], exitAtMs: 6 } } },
      { match: "placeholder-remedy repair", result: { code: 0 } },
    ], { env: {} });
    expect(await runFamily(shuCommand, ["shu", "archive", "--heartbeat", "0"], directory, false, { out(): void {}, err(): void {} }, scripted)).toBe(0);
    expect(scripted.calls.map((call): string => call.command)).toEqual(["placeholder-tool", "placeholder-remedy"]);
  });

});
