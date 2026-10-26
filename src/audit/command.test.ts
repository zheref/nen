// src/audit/command.test.ts -- `nen audit deps`, driven through the real CLI
// dispatch against throwaway trees and a loopback OSV stub this process
// serves (zheref/nen#508).
//
// HERMETIC AND OFFLINE. Every contract the cases use is a copy of a row whose
// endpoints point at 127.0.0.1 (the row loader admits http only on loopback,
// for exactly this), one route per stub mode. Nothing leaves the machine.
//
// SC-1: THE INTERIM FIXTURE, PORTED. Hatsu's
// scripts/dependency_audit_resolve_fixture.mts (zheref/hatsu, HA-PR-#442) is
// the oracle: every lockfile case it carries is a case here with the same exit
// code and the same verdicts (the audit-config lines reworded from "evidence
// for Feitan" to "evidence for review"). The cases it ran against Hatsu's OWN tree
// (its 60-entry package-lock.json, and the stack catalogue of its
// contracts/scans.json) are Hatsu's facts, not this verb's, and stay with
// Hatsu; the row shape itself is held here through ./fixtures/hatsu-scans.json,
// a verbatim copy of the row this verb must accept unchanged.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { AUDIT_DEPS_CONTRACT, auditCommand, type AuditReport } from "./command.js";
import { swiftUrlName } from "./swift.js";

const HATSU = JSON.parse(readFileSync(join(process.cwd(), "src", "audit", "fixtures", "hatsu-scans.json"), "utf8")) as {
  dependencyAudit: Record<string, Record<string, unknown>>;
};

// --- the stub OSV: /m/<mode>/querybatch and /m/<mode>/vulns/<id> ---------------------
const VULNS: Record<string, string[]> = {
  "lodash@4.17.15": ["GHSA-test-high", "GHSA-test-moderate"],
  "left-pad@1.0.0": ["MAL-test-unrated"],
  "minimist@0.0.8": ["GHSA-test-severe"],
  "ms@0.0.1": ["GHSA-test-unknown"],
  "github.com/apple/swift-nio-http2@1.19.1": ["GHSA-swift-high"],
  "github.com/vapor/vapor@4.0.0": ["GHSA-swift-low"],
};
const SEVERITY: Record<string, string | undefined> = {
  "GHSA-test-high": "HIGH",
  "GHSA-test-moderate": "MODERATE",
  "MAL-test-unrated": undefined,
  "GHSA-test-severe": "SEVERE",
  "GHSA-test-unknown": "UNKNOWN",
  "GHSA-swift-high": "HIGH",
  "GHSA-swift-low": "LOW",
};
interface Seen {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
const seen: Seen[] = [];
let server: Server;
let port = 0;
let scratch = "";
const CANARY = `audit-canary-${String(process.pid)}-${String(Date.now())}`;

beforeAll(async (): Promise<void> => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "nen-audit-")));
  server = createServer((req, res): void => {
    let body = "";
    req.on("data", (chunk: Buffer): void => {
      body += chunk.toString("utf8");
    });
    req.on("end", (): void => {
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      const route = /^\/m\/([a-z-]+)\/(querybatch|vulns\/(.+))$/.exec(req.url ?? "");
      const mode = route?.[1] ?? "missing";
      if (mode === "hang") return; // never answers
      if (route === null || mode === "down") {
        res.writeHead(503).end();
        return;
      }
      if (mode === "big") {
        res.writeHead(200, { "content-type": "application/json" }).end(`{"results":[${"{},".repeat(200)}{}]}`);
        return;
      }
      if (mode === "notjson") {
        res.writeHead(200, { "content-type": "application/json" }).end("<html>");
        return;
      }
      if (mode === "redirect") {
        res.writeHead(302, { location: `http://127.0.0.1:${String(port)}/m/ok/querybatch` }).end();
        return;
      }
      if (route[2] === "querybatch") {
        const { queries } = JSON.parse(body) as { queries: Array<{ package: { name: string; ecosystem: string }; version: string; page_token?: string }> };
        const results = queries.map((query): unknown => {
          if (mode === "null-result") return null;
          if (mode === "string-result") return "x";
          if (mode === "null-vulns") return { vulns: null };
          if (mode === "bad-id") return { vulns: [{ id: "../../etc/passwd" }] };
          const key = `${query.package.name}@${query.version}`;
          if (mode === "paged" && query.page_token === undefined) return { next_page_token: "page-2" };
          const ids = VULNS[key] ?? (query.package.name.startsWith("bulk") ? [`GHSA-${query.package.name}`] : undefined);
          return ids !== undefined ? { vulns: ids.map((id: string): Record<string, string> => ({ id, modified: "2026-10-22T00:00:00Z" })) } : {};
        });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(mode === "short" ? { results: results.slice(1) } : { results }));
        return;
      }
      const id = decodeURIComponent(route[3] ?? "");
      const severity = id.startsWith("GHSA-bulk") ? "HIGH" : SEVERITY[id];
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id, ...(severity !== undefined ? { database_specific: { severity } } : {}) }));
    });
  });
  await new Promise<void>((done): void => {
    server.listen(0, "127.0.0.1", (): void => done());
  });
  port = (server.address() as { port: number }).port;
});

afterAll((): void => {
  server.closeAllConnections();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

// --- contracts --------------------------------------------------------------------
const SWIFT_QUERYABLE = {
  ...HATSU.dependencyAudit["swift"],
  vulnEndpoint: "https://api.osv.dev/v1/vulns/",
  severityLevels: ["LOW", "MODERATE", "HIGH", "CRITICAL"],
  severityFloor: ["HIGH", "CRITICAL"],
  timeoutSeconds: 120,
};
let contracts = 0;
type Edit = (row: Record<string, unknown>) => void;
/** A copy of Hatsu's node row and a queryable swift row, both pointed at stub `mode`. */
function contract(edit: Edit = (): void => undefined, mode = "ok", row = "node"): string {
  const rows: Record<string, Record<string, unknown>> = {
    node: structuredClone(HATSU.dependencyAudit["node"] as Record<string, unknown>),
    swift: structuredClone(SWIFT_QUERYABLE),
  };
  for (const value of Object.values(rows)) {
    value["endpoint"] = `http://127.0.0.1:${String(port)}/m/${mode}/querybatch`;
    value["vulnEndpoint"] = `http://127.0.0.1:${String(port)}/m/${mode}/vulns/`;
  }
  edit(rows[row] as Record<string, unknown>);
  contracts += 1;
  const path = join(scratch, `contract-${String(contracts)}.json`);
  writeFileSync(path, JSON.stringify({ contract: "hatsu.scans/v0.2", dependencyAudit: rows }));
  return path;
}

// --- trees ----------------------------------------------------------------------------
let trees = 0;
function tree(files: Record<string, string>): string {
  trees += 1;
  const dir = join(scratch, `tree-${String(trees)}`);
  mkdirSync(dir);
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), body);
  }
  return dir;
}
const pkg = (packageManager?: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: "fixture", ...(packageManager !== undefined ? { packageManager } : {}), ...extra });
const pnpm = (entries: string, version = "'9.0'"): string => `lockfileVersion: ${version}\n\npackages:\n\n${entries}`;
const PNPM9 = pnpm("  lodash@4.17.15:\n    resolution: {integrity: sha512-a}\n\n  '@scope/ok@2.0.0':\n    resolution: {integrity: sha512-b}\n\n") + "snapshots:\n\n  lodash@4.17.15: {}\n";
const PNPM6 = pnpm("  /lodash@4.17.15:\n    resolution: {integrity: sha512-a}\n\n  /react-dom@18.2.0(react@18.2.0):\n    resolution: {integrity: sha512-b}\n", "'6.0'");
const PNPM5 = pnpm("  /lodash/4.17.15:\n    resolution: {integrity: sha512-a}\n\n  /@scope/ok/2.0.0_react@18.2.0:\n    resolution: {integrity: sha512-b}\n", "5.4");
const BERRY = '__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"lodash@npm:^4.17.15":\n  version: 4.17.15\n  resolution: "lodash@npm:4.17.15"\n\n"app@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "app@workspace:."\n';
const CLASSIC_HEAD = "# THIS IS AN AUTOGENERATED FILE.\n# yarn lockfile v1\n\n\n";
const REG = "https://registry.yarnpkg.com";
const CLASSIC = `${CLASSIC_HEAD}"lodash@^4.17.15", lodash@^4.17.21:\n  version "4.17.15"\n  resolved "${REG}/lodash/-/lodash-4.17.15.tgz#abc"\n\nleft-pad@^1.0.0:\n  version "1.0.0"\n  resolved "${REG}/left-pad/-/left-pad-1.0.0.tgz#def"\n`;
const NPM3 = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": { name: "fixture" },
    "node_modules/lodash": { version: "4.17.15", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz" },
    "node_modules/a/node_modules/left-pad": { version: "1.0.0" },
    "node_modules/linked": { link: true },
    "packages/ws": { version: "1.0.0" },
  },
});
const NPM1 = JSON.stringify({ lockfileVersion: 1, dependencies: { lodash: { version: "4.17.15", dependencies: { "left-pad": { version: "1.0.0" } } } } });

// --- the run ----------------------------------------------------------------------
interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}
async function run(argv: readonly string[], json = false): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line: string): void => {
      out.push(line);
    },
    err: (line: string): void => {
      err.push(line);
    },
  };
  const code = await runFamily(auditCommand, ["audit", ...argv], null, json, io, new ScriptedSeams([]));
  return { code, out: out.length === 0 ? "" : `${out.join("\n")}\n`, err: err.join("\n") };
}

/** `audit deps --repo <dir> --contract <c> --row <row> ...rest`, held to the interim fixture's invariants. */
async function expectAudit(dir: string, rest: readonly string[], status: number, stdout: RegExp, contractPath = contract(), row = "node"): Promise<string> {
  const result = await run(["deps", "--repo", dir, "--contract", contractPath, "--row", row, ...rest]);
  const detail = `exit ${String(result.code)}\nstdout: ${result.out.slice(0, 4000)}\nstderr: ${result.err}`;
  expect(result.code, detail).toBe(status);
  expect(result.out, detail).toMatch(stdout);
  if (status === 2) {
    expect(result.out, `a wiring stop prints nothing on stdout\n${detail}`).toBe("");
    expect(result.err, `a wiring stop is named on stderr\n${detail}`).toMatch(/^nen audit: /);
  } else {
    expect(result.err, `verdicts go to stdout only\n${detail}`).toBe("");
  }
  if (status === 3) expect(result.out, `ends on one named not-scanned line\n${detail}`).toMatch(/(^|\n)not scanned: [^\n]+\n$/);
  if ((status === 0 || status === 1) && row === "node") expect(result.out, detail).toMatch(/^resolved: osv npm for /);
  return result.out;
}
const stub = (): string => contract();
const modeContract = (mode: string, edit: Edit = (): void => undefined): string => contract(edit, mode);

describe("nen audit deps -- pnpm (the tree the npm-only row reported NOT SCANNED)", () => {
  it("resolves a pnpm 9 tree without querying", async () => {
    await expectAudit(tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": PNPM9 }), [], 0,
      /^resolved: osv npm for pnpm \(packageManager "pnpm@9\.15\.9", pnpm-lock\.yaml, 2 packages\)\n$/);
  });

  it("queries it and reports the finding, the querybatch carrying exactly the registry packages", async () => {
    seen.length = 0;
    await expectAudit(tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": PNPM9 }), ["--query"], 1,
      /finding: GHSA-test-high HIGH "lodash@4\.17\.15"\nbelow-floor: GHSA-test-moderate MODERATE "lodash@4\.17\.15"\naudit: 1 finding\(s\) at or above HIGH\/CRITICAL or unrated, 0 unqueried, across 2 packages\n$/);
    const batch = JSON.parse(seen.find((request: Seen): boolean => request.url.endsWith("/querybatch"))?.body ?? "{}") as { queries: Array<{ package: { name: string; ecosystem: string }; version: string }> };
    expect(batch.queries.map((query): string => `${query.package.name}@${query.version}`).sort()).toEqual(["@scope/ok@2.0.0", "lodash@4.17.15"]);
    expect(new Set(batch.queries.map((query): string => query.package.ecosystem))).toEqual(new Set(["npm"]));
  });

  it("a clean tree is exit 0", async () => {
    await expectAudit(tree({ "package.json": pkg("pnpm@11.25.0+sha512.abc"), "pnpm-lock.yaml": pnpm("  ok@1.0.0:\n    resolution: {integrity: x}\n") }), ["--query"], 0,
      /audit: 0 finding\(s\) .*, 0 unqueried, across 1 packages\n$/);
  });

  it("reads lockfile v6 peer suffixes and v5 slash keys", async () => {
    await expectAudit(tree({ "package.json": pkg("pnpm@8.15.0"), "pnpm-lock.yaml": PNPM6 }), [], 0, /pnpm-lock\.yaml, 2 packages\)\n$/);
    await expectAudit(tree({ "package.json": pkg("pnpm@7.0.0"), "pnpm-lock.yaml": PNPM5 }), [], 0, /pnpm-lock\.yaml, 2 packages\)\n$/);
  });

  it("an unknown lockfileVersion is not scanned", async () => {
    await expectAudit(tree({ "package.json": pkg("pnpm@99.0.0"), "pnpm-lock.yaml": "lockfileVersion: '12.0'\n" }), [], 3, /lockfileVersion "12" is not one this parser reads/);
  });

  const pnpmCase = (lock: string): string => tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": lock });
  it("reads flow-style entries, trailing comments and a commented packages: header", async () => {
    await expectAudit(pnpmCase(pnpm("  lodash@4.17.15: {resolution: {integrity: sha512-a}}\n  ok@1.0.0:\n    resolution: {integrity: x}\n")), ["--query"], 1, /2 packages\)\n[\s\S]*finding: GHSA-test-high/);
    await expectAudit(pnpmCase(pnpm("  lodash@4.17.15: # pinned\n    resolution: {integrity: sha512-a}\n")), ["--query"], 1, /1 packages\)\n[\s\S]*finding: GHSA-test-high/);
    await expectAudit(pnpmCase("lockfileVersion: '9.0'\n\npackages: # all\n\n  lodash@4.17.15:\n    resolution: {integrity: sha512-a}\n"), ["--query"], 1, /finding: GHSA-test-high/);
  });

  it("refuses what it does not read, never drops it (AC-5)", async () => {
    await expectAudit(pnpmCase(pnpm("  ? lodash@4.17.15\n  : resolution: {integrity: sha512-a}\n")), [], 3, /line 5 is an explicit \? key/);
    await expectAudit(pnpmCase(pnpm("  lodash@4.17.15 = 1\n")), [], 3, /line 5 is not a packages key this parser reads/);
    await expectAudit(pnpmCase(pnpm("  ok@1.0.0:\n    resolution: {integrity: x}\n\n  loda")), [], 3, /does not end with a newline \(truncated\)/);
    await expectAudit(pnpmCase(pnpm("  ok@1.0.0:\n    resolution: {integrity: x}\n\n  lodash@4.17.15:\n")), [], 3, /entry "lodash@4\.17\.15" has no body \(truncated\)/);
    await expectAudit(pnpmCase(pnpm("  lodash@latest:\n    resolution: {integrity: sha512-a}\n")), [], 3, /entry "lodash@latest" is registry-shaped but its name or version does not parse/);
  });

  it("parses a BOM-prefixed lockfile", async () => {
    await expectAudit(pnpmCase(`\uFEFF${PNPM9}`), [], 0, /2 packages\)\n$/);
  });

  it("queries only registry-hosted entries; anything else is unqueried and never clean (AC-6)", async () => {
    await expectAudit(pnpmCase(pnpm("  ok@1.0.0:\n    resolution: {integrity: x}\n  evil@1.0.0:\n    resolution: {tarball: https://evil.invalid/evil-1.0.0.tgz}\n")), ["--query"], 1,
      /1 packages\)\nunqueried: 1 pnpm-lock\.yaml entries come from git, file:, a host off registryHosts, a resolution type other than directory, or a resolved URL that names another package or version -- never clean\naudit: 0 finding\(s\) .*, 1 unqueried, across 1 packages\n$/);
    await expectAudit(pnpmCase(pnpm("  lodash@4.17.15:\n    resolution: {integrity: x, tarball: https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz}\n")), ["--query"], 1, /1 packages\)\n[\s\S]*finding: GHSA-test-high/);
    await expectAudit(pnpmCase(pnpm("  ok@1.0.0:\n    resolution: {integrity: x}\n  lodash@4.17.15:\n    resolution: {tarball: http://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz}\n")), [], 0, /unqueried: 1 /);
    await expectAudit(pnpmCase(pnpm("  ok@1.0.0:\n    resolution: {integrity: x}\n  dep@https://codeload.github.com/x/y/tar.gz/abc:\n    resolution: {commit: abc, repo: https://github.com/x/y, type: git}\n  'local@file:pkgs/local':\n    resolution: {directory: pkgs/local, type: directory}\n")), [], 0,
      /1 packages\)\nlocal: 1 pnpm-lock\.yaml entries are workspace, link or directory packages, not queried\nunqueried: 1 /);
  });
});

describe("nen audit deps -- hanten round 1 on NN#508 (Feitan probes A-F, red before the fix)", () => {
  const pnpmCase = (lock: string): string => tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": lock });

  it("F1/A: a '# type: directory' comment on a registry entry's resolution does not make it local", async () => {
    await expectAudit(pnpmCase(pnpm("  ok@1.0.0:\n    resolution: {integrity: x}\n  lodash@4.17.15:\n    resolution: {integrity: sha512-a} # type: directory\n")), ["--query"], 1,
      /^resolved: [^\n]*2 packages\)\nfinding: GHSA-test-high HIGH "lodash@4\.17\.15"/);
  });

  it("F1/B: a v6 dependency named 'is-directory' does not make the depending entry local", async () => {
    await expectAudit(tree({ "package.json": pkg("pnpm@8.15.0"), "pnpm-lock.yaml": pnpm("  /ok@1.0.0:\n    resolution: {integrity: x}\n  /lodash@4.17.15:\n    resolution: {integrity: sha512-a}\n    dependencies:\n      is-directory: 0.3.1\n", "'6.0'") }), ["--query"], 1,
      /^resolved: [^\n]*2 packages\)\nfinding: GHSA-test-high HIGH "lodash@4\.17\.15"/);
  });

  it("F1: a resolution that is missing, repeated or unreadable is not scanned, never local", async () => {
    await expectAudit(pnpmCase(pnpm("  lodash@4.17.15:\n    integrity: x\n")), [], 3, /entry "lodash@4\.17\.15" has no resolution \(truncated\)/);
    await expectAudit(pnpmCase(pnpm("  lodash@4.17.15:\n    resolution: {integrity: x}\n    resolution: {directory: x, type: directory}\n")), [], 3, /does not parse as strict YAML \(DUPLICATE_KEY, line 7\)/);
    await expectAudit(pnpmCase(pnpm("  lodash@4.17.15:\n    resolution: {integrity: x, type: directory\n")), [], 3, /does not parse as strict YAML/);
    await expectAudit(pnpmCase(pnpm("  lodash@4.17.15:\n    resolution: {integrity: x} type: directory\n")), [], 3, /does not parse as strict YAML/);
    await expectAudit(pnpmCase(pnpm("  lodash@4.17.15:\n    resolution: [integrity, x]\n")), [], 3, /has a resolution that is not a map/);
    await expectAudit(pnpmCase(pnpm("  lodash@4.17.15:\n    resolution: {tarball: {a: b}}\n")), [], 3, /resolution value for "tarball" that is not a scalar/);
  });

  it("F1: a block-form resolution is read by its keys, comments stripped", async () => {
    await expectAudit(pnpmCase(pnpm("  lodash@4.17.15:\n    resolution:\n      integrity: sha512-a # type: directory\n  'local@file:pkgs/local':\n    resolution:\n      directory: pkgs/local\n      type: directory\n")), ["--query"], 1,
      /1 packages\)\nlocal: 1 [^\n]*\nfinding: GHSA-test-high HIGH "lodash@4\.17\.15"/);
  });

  it("F2/C: an npm v3 entry claiming ok@1.0.0 while resolving lodash-4.17.15.tgz is unqueried, never clean", async () => {
    await expectAudit(tree({ "package.json": pkg("npm@10.9.0"), "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/lodash": { name: "ok", version: "1.0.0", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz" } } }) }), ["--query"], 1,
      /0 packages\)\nunqueried: 1 package-lock\.json entries come from git, file:, a host off registryHosts, a resolution type other than directory, or a resolved URL that names another package or version -- never clean\naudit: 0 finding\(s\) [^\n]*, 1 unqueried, across 0 packages\n$/);
  });

  it("F2/D: a yarn classic version disagreeing with its resolved tarball is unqueried", async () => {
    await expectAudit(tree({ "package.json": pkg("yarn@1.22.22"), "yarn.lock": `${CLASSIC_HEAD}lodash@^4.17.15:\n  version "1.0.0"\n  resolved "${REG}/lodash/-/lodash-4.17.15.tgz#abc"\n` }), ["--query"], 1,
      /unqueried: 1 yarn\.lock[^\n]*\naudit: 0 finding\(s\) [^\n]*, 1 unqueried/);
  });

  it("F2/E: a pnpm key naming a clean pair with the vulnerable pair's registry tarball is unqueried", async () => {
    await expectAudit(pnpmCase(pnpm("  ok@1.0.0:\n    resolution: {integrity: sha512-a, tarball: https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz}\n")), ["--query"], 1,
      /unqueried: 1 pnpm-lock\.yaml[^\n]*\naudit: 0 finding\(s\) [^\n]*, 1 unqueried/);
  });

  it("F2/F: npm 'link: true' on a registry-resolved entry is read as that entry, not local", async () => {
    await expectAudit(tree({ "package.json": pkg("npm@10.9.0"), "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/ok": { version: "1.0.0" }, "node_modules/lodash": { version: "4.17.15", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz", link: true } } }) }), ["--query"], 1,
      /^resolved: [^\n]*2 packages\)\nfinding: GHSA-test-high HIGH "lodash@4\.17\.15"/);
  });

  it("F2: a scoped tarball that agrees is queried; a registry URL that is not a tarball path is unqueried", async () => {
    await expectAudit(tree({ "package.json": pkg("npm@10.9.0"), "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/@scope/ok": { version: "2.0.0", resolved: "https://registry.npmjs.org/@scope/ok/-/ok-2.0.0.tgz" }, "node_modules/odd": { version: "1.0.0", resolved: "https://registry.npmjs.org/odd" } } }) }), [], 0,
      /1 packages\)\nunqueried: 1 package-lock\.json/);
  });
});

describe("nen audit deps -- hanten round 2 on NN#508 (Feitan probes K-Q, red before the fix)", () => {
  const LOD = "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz";
  const pnpmCase = (lock: string): string => tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": lock });

  it("F5/K: a backslash-escaped quote cannot smuggle 'type: directory' out of a quoted tarball", async () => {
    await expectAudit(pnpmCase(pnpm(`  ok@1.0.0:\n    resolution: {integrity: x}\n  lodash@4.17.15:\n    resolution: {tarball: "${LOD}?a\\", type: directory, b: \\""}\n`)), ["--query"], 1,
      /^resolved: [^\n]*2 packages\)\nfinding: GHSA-test-high HIGH "lodash@4\.17\.15"/);
  });

  it("F6/L: a mid-scalar apostrophe does not swallow the tarball key", async () => {
    await expectAudit(pnpmCase(pnpm(`  ok@1.0.0:\n    resolution: {a: x'y, tarball: ${LOD}, b: w'v}\n`)), ["--query"], 1,
      /0 packages\)\nunqueried: 1 pnpm-lock\.yaml[^\n]*\naudit: 0 finding\(s\) [^\n]*, 1 unqueried/);
  });

  it("F7/M: a multi-line plain scalar in a block resolution does not hide the keys after it", async () => {
    await expectAudit(pnpmCase(pnpm(`  ok@1.0.0:\n    resolution:\n      a: x\n        y\n      tarball: ${LOD}\n`)), ["--query"], 1,
      /0 packages\)\nunqueried: 1 pnpm-lock\.yaml[^\n]*\naudit: 0 finding\(s\) [^\n]*, 1 unqueried/);
  });

  it("F8/N: a repeated block-form key is not scanned, never last-wins", async () => {
    await expectAudit(pnpmCase(pnpm(`  ok@1.0.0:\n    resolution:\n      tarball: ${LOD}\n      tarball: https://registry.npmjs.org/ok/-/ok-1.0.0.tgz\n`)), ["--query"], 3,
      /^not scanned: pnpm-lock\.yaml does not parse as strict YAML \(DUPLICATE_KEY, line \d+\)\n$/);
  });

  it("P: anchors, aliases, explicit tags and merge keys are not scanned", async () => {
    for (const resolution of ["resolution: *a", "resolution: &a {type: directory}", "resolution: !!map {integrity: x}", "resolution:\n      <<: *a"]) {
      await expectAudit(pnpmCase(pnpm(`  lodash@4.17.15:\n    ${resolution}\n`)), [], 3, /not scanned: pnpm-lock\.yaml (does not parse as strict YAML|carries an? )/);
    }
    await expectAudit(pnpmCase(pnpm("  lodash@4.17.15:\n    resolution: {integrity: x}\n    extra: &x {a: 1}\n")), [], 3, /carries an anchor \(&x\)/);
    await expectAudit(pnpmCase(pnpm("  lodash@4.17.15:\n    resolution: {integrity: x}\n    <<: {a: 1}\n")), [], 3, /carries a << merge key/);
  });

  it("the parser is bounded before it runs: a deep flow nest is not scanned, never a stack overflow", async () => {
    await expectAudit(pnpmCase(pnpm(`  lodash@4.17.15:\n    resolution: {integrity: x}\n    deep: ${"[".repeat(5000)}${"]".repeat(5000)}\n`)), [], 3, /nests deeper than 1000 \(maxDepth\)/);
  });

  it("Q: a FIFO at the lockfile name is refused, never hangs", async () => {
    const dir = tree({ "package.json": pkg("pnpm@9.15.9") });
    (await import("node:child_process")).execFileSync("mkfifo", [join(dir, "pnpm-lock.yaml")]);
    await expectAudit(dir, [], 3, /pnpm-lock\.yaml is not a regular file/);
  });

  it("N8: a registry mounted under a path prefix on registryHosts is queried by the segments before /-/", async () => {
    const prefixed = contract((row): void => { row["registryHosts"] = ["registry.npmjs.org", "art.example"]; });
    await expectAudit(tree({ "package.json": pkg("npm@10.9.0"), "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {},
      "node_modules/lodash": { version: "4.17.15", resolved: "https://art.example/api/npm/npm-remote/lodash/-/lodash-4.17.15.tgz" },
      "node_modules/@scope/ok": { version: "2.0.0", resolved: "https://art.example/api/npm/npm-remote/@scope/ok/-/ok-2.0.0.tgz" },
      "node_modules/@scope/two": { version: "1.0.0", resolved: "https://art.example/api/npm/npm-remote/@scope%2ftwo/-/two-1.0.0.tgz" },
      "node_modules/ok": { version: "1.0.0", resolved: "https://art.example/api/npm/npm-remote/lodash%2f..%2fok/-/ok-1.0.0.tgz" } } }) }), ["--query"], 1,
      /3 packages\)\nunqueried: 1 package-lock\.json[^\n]*\nfinding: GHSA-test-high HIGH "lodash@4\.17\.15"/, prefixed);
  });

  it("O: an uppercase scheme, a dot-segment or a %2f traversal toward another name is unqueried", async () => {
    for (const url of ["HTTPS://registry.npmjs.org/ok/-/ok-1.0.0.tgz/../../../lodash/-/lodash-4.17.15.tgz", "https://registry.npmjs.org/lodash%2f..%2f..%2fok/-/ok-1.0.0.tgz", "https://registry.npmjs.org/ok/-/ok-1.0.0.tgz/%2e%2e/%2e%2e/%2e%2e/lodash/-/lodash-4.17.15.tgz"]) {
      await expectAudit(pnpmCase(pnpm(`  ok@1.0.0:\n    resolution: {tarball: '${url}'}\n`)), ["--query"], 1, /unqueried: 1/);
    }
  });

  it("F9: a file is read through one bounded buffer: over maxLockfileBytes is refused", async () => {
    const dir = tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": PNPM9 });
    await expectAudit(dir, [], 3, /pnpm-lock\.yaml is larger than 64 bytes \(maxLockfileBytes\)/, contract((row): void => { row["maxLockfileBytes"] = 64; }));
  });
});

describe("nen audit deps -- stacks", () => {
  it("reaches the node row for every stack it lists, and is not scanned for one it does not", async () => {
    const dir = tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": PNPM9 });
    for (const stack of ["nextjs", "gatsby", "expo", "react", "electron", "node", "claude-code-plugin"]) {
      await expectAudit(dir, ["--stack", stack], 0, /^resolved: osv npm for pnpm/);
    }
    await expectAudit(dir, ["--stack", "dotnet-winui"], 3, /stack "dotnet-winui" is not on dependencyAudit\.node\.stacks/);
  });
});

describe("nen audit deps -- yarn and npm", () => {
  it("yarn berry", async () => {
    await expectAudit(tree({ "package.json": pkg("yarn@4.5.0"), "yarn.lock": BERRY }), ["--query"], 1,
      /^resolved: osv npm for yarn \(packageManager "yarn@4\.5\.0", yarn\.lock, 1 packages\)\nlocal: 1 yarn\.lock entries[^\n]*\nfinding: GHSA-test-high HIGH "lodash@4\.17\.15"/);
  });

  it("a berry patch of a registry package is queried as that package", async () => {
    const lock = `${BERRY.split('\n\n"app')[0] ?? ""}\n\n"resolve@patch:resolve@npm%3A^1.0.0#~builtin<compat/resolve>":\n  version: 1.22.8\n  resolution: "resolve@patch:resolve@npm%3A1.22.8#~builtin<compat/resolve>::version=1.22.8&hash=c3c19d"\n`;
    await expectAudit(tree({ "package.json": pkg("yarn@4.5.0"), "yarn.lock": lock }), [], 0, /yarn\.lock, 2 packages\)\n$/);
  });

  it("a berry entry with no resolution is refused", async () => {
    await expectAudit(tree({ "package.json": pkg("yarn@4.5.0"), "yarn.lock": '__metadata:\n  version: 8\n\n"lodash@npm:^4.17.15":\n  version: 4.17.15\n' }), [], 3, /entry "\\"lodash@npm:\^4\.17\.15\\"" has no resolution \(truncated\)/);
  });

  it("yarn classic is read by its marker, an unrated id counts", async () => {
    await expectAudit(tree({ "package.json": pkg("yarn@1.22.22"), "yarn.lock": CLASSIC }), ["--query"], 1,
      /yarn\.lock, 2 packages\)\nfinding: GHSA-test-high HIGH "lodash@4\.17\.15"\nbelow-floor: GHSA-test-moderate[^\n]*\nfinding: MAL-test-unrated UNRATED "left-pad@1\.0\.0"/);
  });

  it("a classic npm alias as the only vulnerable entry is queried as the real package", async () => {
    await expectAudit(tree({ "package.json": pkg("yarn@1.22.22"), "yarn.lock": `${CLASSIC_HEAD}"lodash-cjs@npm:lodash@^4.17.15":\n  version "4.17.15"\n  resolved "${REG}/lodash/-/lodash-4.17.15.tgz#abc"\n` }), ["--query"], 1,
      /yarn\.lock, 1 packages\)\nfinding: GHSA-test-high HIGH "lodash@4\.17\.15"/);
  });

  it("classic: tight entries are both read; truncation and foreign hosts are never clean", async () => {
    await expectAudit(tree({ "package.json": pkg("yarn@1.22.22"), "yarn.lock": `${CLASSIC_HEAD}lodash@^4.17.15:\n  version "4.17.15"\nleft-pad@^1.0.0:\n  version "1.0.0"\n` }), [], 0, /yarn\.lock, 2 packages\)\n$/);
    await expectAudit(tree({ "package.json": pkg("yarn@1.22.22"), "yarn.lock": `${CLASSIC_HEAD}lodash@^4.17.15:\n  version "4.17.15"\n\nleft-pad@^1.0.0:\n` }), [], 3, /entry "left-pad@\^1\.0\.0" has no version \(truncated\)/);
    await expectAudit(tree({ "package.json": pkg("yarn@1.22.22"), "yarn.lock": `${CLASSIC_HEAD}lodash@^4.17.15:\n  version "4.17` }), [], 3, /does not end with a newline \(truncated\)/);
    await expectAudit(tree({ "package.json": pkg("yarn@1.22.22"), "yarn.lock": `${CLASSIC_HEAD}ok@^1.0.0:\n  version "1.0.0"\nevil@^1.0.0:\n  version "1.0.0"\n  resolved "https://evil.invalid/evil-1.0.0.tgz"\n` }), [], 0, /1 packages\)\nunqueried: 1 yarn\.lock/);
  });

  it("a non-numeric yarn version is never read as classic; a yarn.lock with neither marker is not scanned", async () => {
    await expectAudit(tree({ "package.json": pkg("yarn@berry"), "yarn.lock": BERRY }), [], 0, /packageManager "yarn@berry", yarn\.lock, 1 packages/);
    await expectAudit(tree({ "package.json": pkg("yarn@4.0.0"), "yarn.lock": "lodash: 1\n" }), [], 3, /matches neither declared lockfile marker/);
  });

  it("npm lockfile v3, v1, aliases, git entries and shrinkwrap", async () => {
    await expectAudit(tree({ "package.json": pkg("npm@10.9.0"), "package-lock.json": NPM3 }), ["--query"], 1,
      /package-lock\.json, 2 packages\)\nlocal: 2 package-lock\.json entries[^\n]*\nfinding: GHSA-test-high/);
    await expectAudit(tree({ "package.json": pkg("npm@10.9.0"), "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/ok": { version: "1.0.0" }, "node_modules/dep": { version: "1.0.0", resolved: "git+ssh://git@github.com/x/y.git#abc" } } }) }), [], 0,
      /1 packages\)\nunqueried: 1 package-lock\.json/);
    await expectAudit(tree({ "package.json": pkg(), "package-lock.json": NPM1 }), [], 0, /for npm \(no packageManager field, package-lock\.json, 2 packages\)/);
    await expectAudit(tree({ "package.json": pkg(), "package-lock.json": JSON.stringify({ lockfileVersion: 1, dependencies: { "lodash-cjs": { version: "npm:lodash@4.17.15" } } }) }), ["--query"], 1, /finding: GHSA-test-high HIGH "lodash@4\.17\.15"/);
    await expectAudit(tree({ "package.json": pkg(), "npm-shrinkwrap.json": NPM3 }), [], 0, /npm-shrinkwrap\.json, 2 packages/);
  });

  it("npm: null, array and BOM-prefixed lockfiles; no field and a pnpm lock", async () => {
    await expectAudit(tree({ "package.json": pkg("npm@10.9.0"), "package-lock.json": "null" }), [], 3, /package-lock\.json is not a JSON object/);
    await expectAudit(tree({ "package.json": pkg("npm@10.9.0"), "package-lock.json": "[]" }), [], 3, /package-lock\.json is not a JSON object/);
    await expectAudit(tree({ "package.json": pkg("npm@10.9.0"), "package-lock.json": `\uFEFF${NPM3}` }), [], 0, /2 packages\)/);
    await expectAudit(tree({ "package.json": pkg(), "pnpm-lock.yaml": PNPM9 }), [], 0, /for pnpm \(no packageManager field, pnpm-lock\.yaml/);
  });

  it("a development-only npm v3 lock is queried, never declared empty", async () => {
    const packages: Record<string, unknown> = { "": { name: "plugin", devDependencies: { vitest: "2.1.8" } } };
    for (let i = 0; i < 60; i += 1) packages[`node_modules/dev${String(i)}`] = { version: "1.0.0", dev: true, resolved: `https://registry.npmjs.org/dev${String(i)}/-/dev${String(i)}-1.0.0.tgz` };
    await expectAudit(tree({ "package.json": pkg(), "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages }) }), ["--stack", "claude-code-plugin", "--query"], 0,
      /^resolved: osv npm for npm \(no packageManager field, package-lock\.json, 60 packages\)\naudit: 0 finding\(s\) at or above HIGH\/CRITICAL or unrated, 0 unqueried, across 60 packages\n$/);
  });
});

describe("nen audit deps -- bounds (AC-5)", () => {
  it("a 20,000-deep npm v1 nest is not scanned (maxDepth)", async () => {
    let deep = '{"version":"1.0.0"}';
    for (let i = 0; i < 20000; i += 1) deep = `{"version":"1.0.0","dependencies":{"d${String(i)}":${deep}}}`;
    await expectAudit(tree({ "package.json": pkg("npm@6.0.0"), "package-lock.json": `{"lockfileVersion":1,"dependencies":{"top":${deep}}}` }), [], 3, /nests dependencies deeper than 1000 \(maxDepth\)/);
  });

  it("more entries than maxEntries, and a lockfile over maxLockfileBytes, are not scanned", async () => {
    const dir = tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": PNPM9 });
    await expectAudit(dir, [], 3, /has more than 1 entries \(maxEntries\)/, contract((row): void => { row["maxEntries"] = 1; }));
    await expectAudit(dir, [], 3, /^not scanned: pnpm-lock\.yaml is larger than 100 bytes \(maxLockfileBytes\)\n$/, contract((row): void => { row["maxLockfileBytes"] = 100; }));
  });
});

describe("nen audit deps -- evidence and hostile trees (AC-3, AC-4)", () => {
  it("names a decoy lockfile beside the selected one", async () => {
    await expectAudit(tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": PNPM9, "package-lock.json": NPM3, "bun.lock": "{}" }), [], 0,
      /audit-config: "package-lock\.json" "other-lockfile" -- not audited; evidence for review\naudit-config: "bun\.lock" "other-lockfile"/);
  });

  it("a hostile tree: redirect and suppression keys are evidence, the finding stands, nothing runs, nothing leaks", async () => {
    const marker = join(scratch, "HOOK-RAN");
    process.env["AUDIT_CANARY"] = CANARY;
    try {
      const hostile = tree({
        "package.json": pkg("pnpm@https://evil.invalid/pnpm.tgz", { scripts: { preinstall: `touch ${marker}` }, pnpm: { auditConfig: { ignoreCves: ["CVE-1"] } } }),
        "pnpm-lock.yaml": PNPM9,
        ".pnpmfile.cjs": `require('fs').writeFileSync(${JSON.stringify(marker)}, process.env.AUDIT_CANARY || '')\n`,
        ".yarnrc.yml": `yarnPath: ./evil.cjs\nnpmRegistryServer: "http://127.0.0.1:${String(port)}"\nnpmAuditIgnoreAdvisories: ["*"]\n`,
        "evil.cjs": `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yarn')\n`,
        ".corepack.env": "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1\nCOREPACK_NPM_REGISTRY=http://127.0.0.1:1\nCOREPACK_INTEGRITY_KEYS=0\n",
        ".npmrc": `registry=http://127.0.0.1:${String(port)}/\n@corp:registry=http://127.0.0.1:${String(port)}/\n//127.0.0.1:${String(port)}/:_authToken=\${AUDIT_CANARY}\naudit=false\n`,
        "pnpm-workspace.yaml": 'auditConfig:\n  ignoreGhsas: ["GHSA-test-high"]\n',
      });
      seen.length = 0;
      const out = await expectAudit(hostile, ["--query"], 1, /finding: GHSA-test-high HIGH "lodash@4\.17\.15"/);
      for (const line of ['".npmrc" "registry"', '".npmrc" "*:registry"', '".npmrc" "audit"', '"package.json" "pnpm.auditConfig"', '"pnpm-workspace.yaml" "auditConfig"', '".yarnrc.yml" "npmRegistryServer"', '".yarnrc.yml" "npmAuditIgnoreAdvisories"']) {
        expect(out).toContain(`audit-config: ${line} -- not honoured`);
      }
      expect(out).not.toContain(CANARY);
      expect(existsSync(marker), "a tree hook (.pnpmfile.cjs, yarnPath, a lifecycle script) ran").toBe(false);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((request: Seen): boolean => request.url.startsWith("/m/ok/")), "only the contract endpoints were contacted").toBe(true);
      for (const request of seen) {
        expect(request.headers.authorization, "an Authorization header reached the endpoint").toBeUndefined();
        expect(JSON.stringify(request)).not.toContain(CANARY);
      }
    } finally {
      delete process.env["AUDIT_CANARY"];
    }
  });

  it("its source executes nothing and reads no environment", () => {
    const dir = join(process.cwd(), "src", "audit");
    for (const file of readdirSync(dir).filter((name: string): boolean => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      // Code, not comments: the headers name what is forbidden in order to say why.
      const text = readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(text, `${file} must execute nothing and read no environment`).not.toMatch(/child_process|process\.env|\bexec(File)?Sync\b|\bspawn\b|context\.seams|Bun\.(spawn|env|\$)/);
    }
  });
});

describe("nen audit deps -- the tree cannot be read: NOT SCANNED, named", () => {
  it("manifest and manager faults", async () => {
    await expectAudit(tree({ "package.json": pkg("pnpm@9.15.9"), "package-lock.json": NPM3 }), [], 3, /packageManager "pnpm@9\.15\.9" but no pnpm-lock\.yaml to audit/);
    await expectAudit(tree({}), [], 3, /no package\.json at the root of the path/);
    const dirManifest = tree({ "pnpm-lock.yaml": PNPM9 });
    mkdirSync(join(dirManifest, "package.json"));
    await expectAudit(dirManifest, [], 3, /package\.json is not a regular file/);
    await expectAudit(tree({ "package.json": '{"secret-ish' }), [], 3, /^not scanned: package\.json does not parse as JSON\n$/);
    await expectAudit(tree({ "package.json": `\uFEFF${pkg("pnpm@9.15.9")}`, "pnpm-lock.yaml": PNPM9 }), [], 0, /^resolved: osv npm for pnpm/);
    await expectAudit(tree({ "package.json": "null" }), [], 3, /package\.json is not a JSON object/);
    await expectAudit(tree({ "package.json": "[]", "pnpm-lock.yaml": PNPM9 }), [], 3, /package\.json is not a JSON object/);
    await expectAudit(tree({ "package.json": '{"packageManager":9}' }), [], 3, /packageManager is not a string/);
    await expectAudit(tree({ "package.json": pkg("pnpm"), "pnpm-lock.yaml": PNPM9 }), [], 3, /packageManager "pnpm" is not <name>@<version>/);
  });

  it("a packageManager carrying a newline cannot forge lines", async () => {
    const out = await expectAudit(tree({ "package.json": pkg("pnpm@9\naudit: 0 finding(s)\nscanned: x"), "pnpm-lock.yaml": PNPM9 }), [], 3, /^not scanned: packageManager carries control characters\n$/);
    expect(out.split("\n")).toHaveLength(2);
  });

  it("managers with no row, bun lockfiles, prototype keys, ambiguity, absence, emptiness", async () => {
    await expectAudit(tree({ "package.json": pkg("bun@1.1.0"), "bun.lockb": "" }), [], 3, /packageManager names "bun", which has no dependencyAudit\.node manager/);
    await expectAudit(tree({ "package.json": pkg(), "bun.lock": "{}" }), [], 3, /bun\.lock is a bun lockfile, which has no dependencyAudit\.node parser/);
    await expectAudit(tree({ "package.json": pkg("constructor@1.0.0") }), [], 3, /names "constructor", which has no dependencyAudit\.node manager/);
    await expectAudit(tree({ "package.json": pkg(), "pnpm-lock.yaml": PNPM9, "package-lock.json": NPM3 }), [], 3, /are all present \(ambiguous\)/);
    await expectAudit(tree({ "package.json": pkg() }), [], 3, /no packageManager field and no lockfile to audit/);
    await expectAudit(tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }), [], 3, /no packages parsed from pnpm-lock\.yaml/);
  });

  it("never follows a symbolic link: package.json, the lockfile, or a directory in their place", async () => {
    const outside = join(scratch, "outside-secret.json");
    writeFileSync(outside, '{"packageManager":"pnpm@9.15.9", "token": "OUTSIDE-SECRET"');
    const linkPkg = tree({ "pnpm-lock.yaml": PNPM9 });
    symlinkSync(outside, join(linkPkg, "package.json"));
    expect(await expectAudit(linkPkg, [], 3, /package\.json is a symlink, never followed/)).not.toContain("OUTSIDE");
    const linkLock = tree({ "package.json": pkg("pnpm@9.15.9") });
    symlinkSync(outside, join(linkLock, "pnpm-lock.yaml"));
    await expectAudit(linkLock, [], 3, /pnpm-lock\.yaml is a symlink, never followed/);
    const dirLock = tree({ "package.json": pkg("pnpm@9.15.9") });
    mkdirSync(join(dirLock, "pnpm-lock.yaml"));
    await expectAudit(dirLock, [], 3, /pnpm-lock\.yaml is not a regular file/);
  });
});

describe("nen audit deps -- OSV answers that cannot be read are never clean (AC-7)", () => {
  const dir = (): string => tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": PNPM9 });
  it("malformed querybatch results", async () => {
    for (const mode of ["null-result", "string-result", "null-vulns", "short"]) {
      await expectAudit(dir(), ["--query"], 3, /not scanned: OSV returned a malformed querybatch response\n$/, modeContract(mode));
    }
    await expectAudit(dir(), ["--query"], 3, /not scanned: OSV returned a malformed vulnerability id\n$/, modeContract("bad-id"));
  });

  it("severities outside severityLevels are UNRATED and count", async () => {
    await expectAudit(tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": pnpm("  minimist@0.0.8:\n    resolution: {integrity: a}\n  ms@0.0.1:\n    resolution: {integrity: b}\n") }), ["--query"], 1,
      /finding: GHSA-test-severe UNRATED "minimist@0\.0\.8"\nfinding: GHSA-test-unknown UNRATED "ms@0\.0\.1"\naudit: 2 finding/);
  });

  it("oversized, not JSON, slow, failing, redirected and unreachable answers", async () => {
    await expectAudit(dir(), ["--query"], 3, /OSV response exceeded 64 bytes \(maxResponseBytes\)\n$/, modeContract("big", (row): void => { row["maxResponseBytes"] = 64; }));
    await expectAudit(dir(), ["--query"], 3, /not scanned: OSV returned a response that is not JSON\n$/, modeContract("notjson"));
    await expectAudit(dir(), ["--query"], 3, /not scanned: OSV query timed out after 1s\n$/, modeContract("hang", (row): void => { row["timeoutSeconds"] = 1; }));
    await expectAudit(dir(), ["--query"], 3, /not scanned: OSV answered HTTP 503 at 127\.0\.0\.1:\d+\n$/, modeContract("down"));
    seen.length = 0;
    await expectAudit(dir(), ["--query"], 3, /^resolved: [^\n]*\nnot scanned: OSV answered a redirect at 127\.0\.0\.1:\d+, never followed\n$/, modeContract("redirect"));
    expect(seen.some((request: Seen): boolean => request.url.startsWith("/m/ok/")), "a redirect was followed").toBe(false);
    expect(seen.filter((request: Seen): boolean => request.url === "/m/redirect/querybatch"), "a redirect was posted more than once").toHaveLength(1);
    await expectAudit(dir(), ["--query"], 3, /not scanned: OSV unreachable at 127\.0\.0\.1:1\n$/, contract((row): void => { row["endpoint"] = "http://127.0.0.1:1/v1/querybatch"; }));
  }, 20_000);

  it("follows next_page_token to the end", async () => {
    await expectAudit(dir(), ["--query"], 1, /finding: GHSA-test-high HIGH "lodash@4\.17\.15"/, modeContract("paged"));
  });

  it("2,500 findings arrive whole with the audit line last", async () => {
    const bulk = Array.from({ length: 2500 }, (_: unknown, i: number): string => `  bulk${String(i)}@1.0.0:\n    resolution: {integrity: x}\n`).join("");
    const out = await expectAudit(tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": pnpm(bulk) }), ["--query"], 1, /\naudit: 2500 finding\(s\) [^\n]*across 2500 packages\n$/);
    expect(out.split("\n").filter((line: string): boolean => line.startsWith("finding: "))).toHaveLength(2500);
  }, 60_000);
});

describe("nen audit deps -- wiring stops are exit 2 on stderr, never a verdict", () => {
  const dir = (): string => tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": PNPM9 });
  it("arguments", async () => {
    const wiring = async (argv: readonly string[]): Promise<void> => {
      const result = await run(argv);
      expect(result.code, `${argv.join(" ")}: ${result.err}`).toBe(2);
      expect(result.out).toBe("");
      expect(result.err).toMatch(/^nen audit: /);
    };
    const d = dir();
    const c = stub();
    await wiring([]);
    await wiring(["bogus"]);
    await wiring(["deps", "--contract", c, "--row", "node"]);
    await wiring(["deps", "--repo", d, "--row", "node"]);
    await wiring(["deps", "--repo", d, "--contract", c]);
    await wiring(["deps", "extra", "--repo", d, "--contract", c, "--row", "node"]);
    await wiring(["deps", "--repo", d, "--contract", c, "--row", "node", "--run"]);
    await wiring(["deps", "--repo", d, "--contract", c, "--row", "node", "--stack", "Next JS"]);
    await wiring(["deps", "--repo", d, "--contract", c, "--row", "node", "--stack", ""]);
    await wiring(["deps", "--repo", join(d, "package.json"), "--contract", c, "--row", "node"]);
    await wiring(["deps", "--repo", d, "--contract", join(scratch, "missing.json"), "--row", "node"]);
    await wiring(["deps", "--repo", d, "--contract", "scans.json", "--row", "node"]);
    await wiring(["deps", "--repo", d, "--contract", c, "--row", "absent"]);
    await wiring(["deps", "--repo", d, "--contract", c, "--row", "$comment"]);
  });

  it("Hatsu's jvm row (no ecosystem) and its swift row as it stands (no vulnEndpoint, levels, floor or timeout)", async () => {
    const hatsu = join(process.cwd(), "src", "audit", "fixtures", "hatsu-scans.json");
    await expectAudit(dir(), [], 2, /^$/, hatsu, "jvm");
    const result = await run(["deps", "--repo", dir(), "--contract", hatsu, "--row", "swift"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/dependencyAudit\.swift\.severityLevels must be a non-empty string array/);
  });

  it("Hatsu's node row is accepted unchanged", async () => {
    await expectAudit(dir(), [], 0, /^resolved: osv npm for pnpm/, join(process.cwd(), "src", "audit", "fixtures", "hatsu-scans.json"));
  });

  it("malformed rows", async () => {
    const malformed: Array<[string, Edit]> = [
      ["the retired run-row manager shape", (row): void => { row["managers"] = { pnpm: { run: "pnpm audit --audit-level=high", lockfiles: ["pnpm-lock.yaml"], format: "pnpm-lock" } }; }],
      ["a non-https endpoint off loopback", (row): void => { row["endpoint"] = "http://osv.example/v1/querybatch"; }],
      ["a vulnEndpoint with no trailing slash (N1)", (row): void => { row["vulnEndpoint"] = "https://api.osv.dev/v1/vulns"; }],
      ["a vulnEndpoint with a query string", (row): void => { row["vulnEndpoint"] = "https://api.osv.dev/v1/vulns/?x=1"; }],
      ["an endpoint carrying credentials", (row): void => { row["endpoint"] = "https://user:pass@osv.example/v1/querybatch"; }],
      ["a zero timeout", (row): void => { row["timeoutSeconds"] = 0; }],
      ["a lockfileMarkers regex that does not compile", (row): void => { ((row["managers"] as Record<string, Record<string, Record<string, string>>>)["yarn"] as Record<string, Record<string, string>>)["lockfileMarkers"] = { berry: "([", classic: "x" }; }],
      ["unsupportedLockfiles that is an array", (row): void => { row["unsupportedLockfiles"] = ["bun.lock"]; }],
      ["unsupportedLockfiles with a non-string value", (row): void => { row["unsupportedLockfiles"] = { "bun.lock": 1 }; }],
      ["auditConfigKeys that is not an object", (row): void => { row["auditConfigKeys"] = "npmrc"; }],
      ["auditConfigKeys with a non-string entry", (row): void => { row["auditConfigKeys"] = { ".npmrc": ["registry", 7] }; }],
      ["auditConfigKeys naming a path", (row): void => { row["auditConfigKeys"] = { "../.npmrc": ["registry"] }; }],
      ["a lockfile naming a path", (row): void => { (row["managers"] as Record<string, Record<string, unknown>>)["pnpm"] = { lockfiles: ["../pnpm-lock.yaml"], format: "pnpm-lock" }; }],
      ["maxResponseBytes of 0", (row): void => { row["maxResponseBytes"] = 0; }],
      ["maxDepth that is not an integer", (row): void => { row["maxDepth"] = "1000"; }],
      ["maxLockfileBytes of 0", (row): void => { row["maxLockfileBytes"] = 0; }],
      ["an unknown row key", (row): void => { row["registry"] = "https://evil.invalid"; }],
      ["an unknown manager key", (row): void => { ((row["managers"] as Record<string, Record<string, unknown>>)["pnpm"] as Record<string, unknown>)["run"] = "pnpm audit"; }],
      ["lockfileMarkers on a non-yarn manager", (row): void => { ((row["managers"] as Record<string, Record<string, unknown>>)["npm"] as Record<string, unknown>)["lockfileMarkers"] = { berry: "x", classic: "y" }; }],
      ["a severityFloor outside severityLevels", (row): void => { row["severityFloor"] = ["SEVERE"]; }],
      ["severityLevels naming UNRATED", (row): void => { row["severityLevels"] = ["HIGH", "UNRATED"]; }],
      ["registryHosts that is empty", (row): void => { row["registryHosts"] = []; }],
      ["an ecosystem with no reader", (row): void => { row["ecosystem"] = "PyPI"; }],
      ["a prose key that is not a string", (row): void => { row["run"] = 7; }],
    ];
    for (const [name, edit] of malformed) {
      const result = await run(["deps", "--repo", dir(), "--contract", contract(edit), "--row", "node"]);
      expect(result.code, `${name}: ${result.err}`).toBe(2);
      expect(result.out, name).toBe("");
    }
  });

  it("absent optional keys take their documented defaults", async () => {
    const defaults = contract((row): void => {
      for (const key of ["unsupportedLockfiles", "auditConfigKeys", "maxResponseBytes", "maxEntries", "maxDepth", "maxLockfileBytes"]) delete row[key];
    });
    await expectAudit(dir(), ["--query"], 1, /finding: GHSA-test-high/, defaults);
  });
});

describe("nen audit deps -- Swift (AC-2, SC-2)", () => {
  const swift = (edit: Edit = (): void => undefined, mode = "ok"): string => contract(edit, mode, "swift");
  const v2 = (pins: readonly Record<string, unknown>[], version = 2): string => JSON.stringify({ pins, version });
  const remote = (identity: string, location: string, version?: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ identity, kind: "remoteSourceControl", location, state: { revision: "a".repeat(40), ...(version !== undefined ? { version } : {}), ...extra } });

  it("queries a root Package.resolved under SwiftURL names and reports the finding", async () => {
    seen.length = 0;
    const dir = tree({ "Package.resolved": v2([remote("swift-nio-http2", "https://github.com/apple/swift-nio-http2.git", "1.19.1"), remote("vapor", "https://github.com/vapor/vapor", "4.0.0")]) });
    await expectAudit(dir, ["--query", "--stack", "xcode-ios"], 1,
      /^resolved: osv SwiftURL for swiftpm \(resolved graph, Package\.resolved, 2 packages\)\nfinding: GHSA-swift-high HIGH "github\.com\/apple\/swift-nio-http2@1\.19\.1"\nbelow-floor: GHSA-swift-low LOW "github\.com\/vapor\/vapor@4\.0\.0"\naudit: 1 finding\(s\) at or above HIGH\/CRITICAL or unrated, 0 unqueried, across 2 packages\n$/,
      swift(), "swift");
    const batch = JSON.parse(seen.find((request: Seen): boolean => request.url.endsWith("/querybatch"))?.body ?? "{}") as { queries: Array<{ package: { name: string; ecosystem: string } }> };
    expect(batch.queries.map((query): string => `${query.package.ecosystem}:${query.package.name}`).sort()).toEqual(["SwiftURL:github.com/apple/swift-nio-http2", "SwiftURL:github.com/vapor/vapor"]);
  });

  it("reads format 1 and format 3, and the bundle copies inside .xcodeproj and .xcworkspace", async () => {
    const v1 = JSON.stringify({ object: { pins: [{ package: "SwiftNIOHTTP2", repositoryURL: "https://github.com/apple/swift-nio-http2.git", state: { branch: null, revision: "b", version: "1.19.1" } }] }, version: 1 });
    await expectAudit(tree({ "App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved": v1 }), ["--query"], 1,
      /^resolved: osv SwiftURL for swiftpm \(resolved graph, App\.xcodeproj\/project\.xcworkspace\/xcshareddata\/swiftpm\/Package\.resolved, 1 packages\)\nfinding: GHSA-swift-high/, swift(), "swift");
    await expectAudit(tree({ "App.xcworkspace/xcshareddata/swiftpm/Package.resolved": v2([remote("vapor", "git@github.com:vapor/vapor.git", "4.0.0")], 3) }), ["--query"], 0,
      /below-floor: GHSA-swift-low LOW "github\.com\/vapor\/vapor@4\.0\.0"\naudit: 0 finding/, swift(), "swift");
  });

  it("a branch or revision pin and a registry pin are unqueried and never clean; a local pin is local", async () => {
    const dir = tree({ "Package.resolved": v2([
      remote("vapor", "https://github.com/vapor/vapor", "4.0.0"),
      remote("edge", "https://github.com/x/edge", undefined, { branch: "main" }),
      { identity: "scope.pkg", kind: "registry", location: "", state: { version: "1.0.0" } },
      { identity: "mine", kind: "localSourceControl", location: "/Users/me/mine", state: { revision: "c" } },
    ]) });
    await expectAudit(dir, ["--query"], 1,
      /1 packages\)\nlocal: 1 Package\.resolved entries are workspace, link or directory packages, not queried\nunqueried: 2 Package\.resolved entries are pinned to a branch or revision, a registry identity, or a non-git location -- never clean\nbelow-floor: GHSA-swift-low[^\n]*\naudit: 0 finding\(s\) [^\n]*, 2 unqueried, across 1 packages\n$/,
      swift(), "swift");
  });

  it("refuses what it cannot read: no file, a symlinked bundle, an unknown version, truncation, a bad version", async () => {
    await expectAudit(tree({ "Package.swift": "// swift-tools-version:5.9\n" }), [], 3, /no Package\.resolved at the root of the path or in an Xcode project or workspace beside it/, swift(), "swift");
    const real = tree({ "xcshareddata/swiftpm/Package.resolved": v2([remote("vapor", "https://github.com/vapor/vapor", "4.0.0")]) });
    const linked = tree({});
    symlinkSync(real, join(linked, "App.xcworkspace"));
    await expectAudit(linked, [], 3, /App\.xcworkspace is a symlink, never followed/, swift(), "swift");
    await expectAudit(tree({ "Package.resolved": JSON.stringify({ pins: [], version: 4 }) }), [], 3, /version is not one this parser reads \(1, 2, 3\)/, swift(), "swift");
    await expectAudit(tree({ "Package.resolved": v2([remote("vapor", "https://github.com/vapor/vapor", "4.0.0")]).slice(0, 40) }), [], 3, /does not parse as JSON/, swift(), "swift");
    await expectAudit(tree({ "Package.resolved": v2([remote("vapor", "https://github.com/vapor/vapor", "four")]) }), [], 3, /pin "vapor" is registry-shaped but its location or version does not parse/, swift(), "swift");
    await expectAudit(tree({ "Package.resolved": v2([]) }), [], 3, /no pins parsed from Package\.resolved/, swift(), "swift");
  });

  it("an unreachable endpoint is not scanned, never clean", async () => {
    await expectAudit(tree({ "Package.resolved": v2([remote("vapor", "https://github.com/vapor/vapor", "4.0.0")]) }), ["--query"], 3, /not scanned: OSV answered HTTP 503/, swift((): void => undefined, "down"), "swift");
  });

  it("names a git location the way OSV's SwiftURL ecosystem does", () => {
    expect(swiftUrlName("https://github.com/apple/swift-nio-http2.git")).toBe("github.com/apple/swift-nio-http2");
    expect(swiftUrlName("https://GitHub.com/Apple/swift-nio/")).toBe("github.com/Apple/swift-nio");
    expect(swiftUrlName("git@github.com:vapor/vapor.git")).toBe("github.com/vapor/vapor");
    expect(swiftUrlName("ssh://git@gitlab.example.com/team/lib.git")).toBe("gitlab.example.com/team/lib");
    expect(swiftUrlName("/Users/me/lib")).toBeUndefined();
    expect(swiftUrlName("file:///Users/me/lib")).toBeUndefined();
  });
});

describe("nen audit deps --json", () => {
  it("is one document carrying the verdict the exit code states", async () => {
    const dir = tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": PNPM9 });
    const result = await run(["deps", "--repo", dir, "--contract", stub(), "--row", "node", "--query", "--stack", "nextjs"], true);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out) as AuditReport;
    expect(report).toMatchObject({
      contract: AUDIT_DEPS_CONTRACT, verdict: "findings", exit: 1, row: "node", ecosystem: "npm", stack: "nextjs", queried: true,
      manager: "pnpm", files: ["pnpm-lock.yaml"], packages: 2, local: 0, unqueried: 0, findingCount: 1, notScanned: null,
    });
    expect(report.findings).toEqual([
      { id: "GHSA-test-high", severity: "HIGH", atFloor: true, pins: ["lodash@4.17.15"] },
      { id: "GHSA-test-moderate", severity: "MODERATE", atFloor: false, pins: ["lodash@4.17.15"] },
    ]);
    expect(Object.keys(report)).toEqual(["contract", "verdict", "exit", "row", "ecosystem", "stack", "queried", "manager", "files", "source", "packages", "pins", "local", "unqueried", "evidence", "findings", "findingCount", "notScanned"]);
  });

  it("states not-scanned with its reason, and never as clean", async () => {
    const result = await run(["deps", "--repo", tree({ "package.json": pkg() }), "--contract", stub(), "--row", "node", "--query"], true);
    expect(result.code).toBe(3);
    const report = JSON.parse(result.out) as AuditReport;
    expect(report).toMatchObject({ verdict: "not-scanned", exit: 3, queried: false, manager: null, notScanned: "no packageManager field and no lockfile to audit" });
  });
});
