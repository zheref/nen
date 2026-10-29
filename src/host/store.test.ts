import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertOwner, describeSlots, initStore, openStore, parseClaim, parseConfig, readSlot, release, reserve, slots, writeClaim, type HostStore } from "./store.js";
const roots: string[] = [];
function fixture(capacity = 1): HostStore {
  const root = mkdtempSync(join(tmpdir(), "nen-host-store-")); roots.push(root);
  return initStore(join(root, "budget"), capacity);
}
const coordinator = { pid: 100, pgid: 100, started: "Mon Oct 26 10:00:00 2026" };
afterEach((): void => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("host-wide atomic capacity claims", (): void => {
  it("defaults to capacity one and refuses a competing repository with the current owner", (): void => {
    const store = fixture(); const first = reserve(store, "session A / repo A", coordinator);
    expect(store.config.capacity).toBe(1);
    expect((): unknown => reserve(openStore(store.root), "session B / repo B", coordinator)).toThrow(/session A.*wait 0ms/);
    expect(slots(store)).toHaveLength(1);
    expect(assertOwner(first).id).toBe(first.claim.id);
  });
  it("honours an explicit larger budget without trading effort counts for capacity", (): void => {
    const store = fixture(2);
    reserve(store, "local", coordinator); reserve(openStore(store.root), "CI", coordinator);
    expect((): unknown => reserve(store, "third", coordinator)).toThrow(/capacity 2 occupied/);
  });
  it("does not free capacity when a coordinator PID is absent or a claim is old", (): void => {
    const store = fixture(); const owner = reserve(store, "dead coordinator", coordinator);
    writeClaim(owner, { ...owner.claim, createdAt: "2000-01-01T00:00:00Z", state: "unresolved", group: { pid: 101, pgid: 101, started: coordinator.started }, reason: "descendant ownership unknown" });
    expect((): unknown => reserve(store, "retry", coordinator)).toThrow(/dead coordinator.*unresolved/);
    expect((): unknown => release(owner)).toThrow(/no completion/);
  });
  it("keeps an unreadable reservation occupied rather than removing it", (): void => {
    const store = fixture(); mkdirSync(join(store.root, "slots", "1.json"));
    expect((): unknown => reserve(store, "next", coordinator)).toThrow(/unresolved/);
    expect(slots(store)[0]?.claim).toBeNull();
  });
  it("refuses corrupt state, a file in place of a directory and slot links", (): void => {
    const store = fixture(); const path = join(store.root, "slots", "1.json"); writeFileSync(path, "{");
    expect((): unknown => reserve(store, "next", coordinator)).toThrow(/unresolved/);
    rmSync(path, { recursive: true }); writeFileSync(path, "not a directory");
    expect((): unknown => reserve(store, "next", coordinator)).toThrow(/unresolved/);
    rmSync(path); symlinkSync(store.root, path, "dir");
    expect((): unknown => reserve(store, "next", coordinator)).toThrow(/unresolved/);
  });
  it("refuses unprovisioned, relative and unreadable configurations without initializing them", (): void => {
    const store = fixture();
    expect((): unknown => openStore("relative")).toThrow(/absolute/);
    expect((): unknown => openStore(join(store.root, "missing"))).toThrow(/cannot read/);
    writeFileSync(join(store.root, "config.json"), "broken");
    expect((): unknown => openStore(store.root)).toThrow(/nothing was launched/);
  });
  it("validates the budget and claim rather than silently defaulting malformed input", (): void => {
    for (const capacity of [0, -1, 1.5, 65, "1", null]) expect((): unknown => parseConfig({ contract: "nen.host/v0.1", hostId: randomUUID(), capacity })).toThrow();
    expect((): unknown => parseConfig({ contract: "nen.host/v0.1", hostId: randomUUID(), capacity: 1, extra: true })).toThrow();
    expect((): unknown => parseClaim({})).toThrow();
    expect((): unknown => initStore("relative")).toThrow(/absolute/);
  });
  it("does not overwrite an existing host configuration", (): void => {
    const store = fixture(); expect((): unknown => initStore(store.root, 2)).toThrow();
    expect(openStore(store.root).config).toEqual(store.config);
  });
  it("releases only a completed owner identity", (): void => {
    const store = fixture(); const owner = reserve(store, "owner", coordinator);
    expect((): unknown => release(owner)).toThrow(/no completion/);
    writeClaim(owner, { ...owner.claim, state: "complete" });
    release(owner); expect(slots(store)).toEqual([]);
  });
  it("refuses changed claim identity and old slots outside a lowered budget", (): void => {
    const store = fixture(2); const owner = reserve(store, "A", coordinator); reserve(store, "B", coordinator);
    writeClaim(owner, { ...owner.claim, id: randomUUID() });
    expect((): unknown => assertOwner(owner)).toThrow(/identity changed/);
    writeFileSync(join(store.root, "config.json"), JSON.stringify({ ...store.config, capacity: 1 }));
    expect((): unknown => reserve(openStore(store.root), "C", coordinator)).toThrow(/unresolved/);
    expect(describeSlots(slots(store))).toContain("slot 2");
  });
  it("validates owner labels and unknown slot entries", (): void => {
    const store = fixture(); expect((): unknown => reserve(store, "\n", coordinator)).toThrow(/printable/);
    writeFileSync(join(store.root, "slots", "unexpected"), "x");
    expect((): unknown => slots(store)).toThrow(/unknown entry/);
    expect((): unknown => readSlot(store, 1)).toThrow();
  });
});
