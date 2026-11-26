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
// code and the same verdict lines. The cases it ran against Hatsu's OWN tree
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


// Feitan probes (security review of NN#508). Each asserts the CURRENT behaviour so a red here is a fix landing.
const pnpmCaseP = (lock: string): string => tree({ "package.json": pkg("pnpm@9.15.9"), "pnpm-lock.yaml": lock });
describe("feitan probes", () => {
  it("A: a YAML comment '# type: directory' on a vulnerable registry entry hides it (exit 0)", async () => {
    await expectAudit(pnpmCaseP(pnpm("  ok@1.0.0:\n    resolution: {integrity: x}\n  lodash@4.17.15:\n    resolution: {integrity: sha512-a} # type: directory\n")), ["--query"], 0, /local: 1 /);
  });
  it("B: a v6 dependency NAMED 'directory' makes the depending vulnerable entry local (exit 0)", async () => {
    await expectAudit(tree({ "package.json": pkg("pnpm@8.15.0"), "pnpm-lock.yaml": pnpm("  /ok@1.0.0:\n    resolution: {integrity: x}\n  /lodash@4.17.15:\n    resolution: {integrity: sha512-a}\n    dependencies:\n      is-directory: 0.3.1\n", "'6.0'") }), ["--query"], 0, /local: 1 /);
  });
  it("C: npm v3 name/version disagreeing with the registry tarball queries the claimed pair (exit 0)", async () => {
    await expectAudit(tree({ "package.json": pkg("npm@10.9.0"), "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/lodash": { name: "ok", version: "1.0.0", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz" } } }) }), ["--query"], 0, /1 packages/);
  });
  it("D: yarn classic version disagreeing with resolved queries the claimed version (exit 0)", async () => {
    await expectAudit(tree({ "package.json": pkg("yarn@1.22.22"), "yarn.lock": `${CLASSIC_HEAD}lodash@^4.17.15:\n  version "1.0.0"\n  resolved "${REG}/lodash/-/lodash-4.17.15.tgz#abc"\n` }), ["--query"], 0, /1 packages/);
  });
  it("E: pnpm key naming a clean pair with a registry tarball of the vulnerable one (exit 0)", async () => {
    await expectAudit(pnpmCaseP(pnpm("  ok@1.0.0:\n    resolution: {integrity: sha512-a, tarball: https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz}\n")), ["--query"], 0, /1 packages/);
  });
  it("F: npm v3 'link: true' on a registry entry makes it local (exit 0)", async () => {
    await expectAudit(tree({ "package.json": pkg("npm@10.9.0"), "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/ok": { version: "1.0.0" }, "node_modules/lodash": { version: "4.17.15", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz", link: true } } }) }), ["--query"], 0, /local: 1 /);
  });
  it("G: CRLF pnpm lockfile still finds the vuln", async () => {
    await expectAudit(pnpmCaseP(pnpm("  lodash@4.17.15:\r\n    resolution: {integrity: sha512-a}\r\n").replace(/\n/g, "\r\n").replace(/\r\r/g, "\r")), ["--query"], 1, /finding: GHSA-test-high/);
  });
  it("H: non-ASCII package name is not scanned", async () => {
    await expectAudit(pnpmCaseP(pnpm("  lödash@4.17.15:\n    resolution: {integrity: sha512-a}\n")), [], 3, /does not parse/);
  });
  it("I: yarn classic alias with npm: header", async () => {
    await expectAudit(tree({ "package.json": pkg("yarn@1.22.22"), "yarn.lock": `${CLASSIC_HEAD}"x@npm:@scope/ok@^1.0.0", lodash@^4.17.15:\n  version "4.17.15"\n  resolved "${REG}/lodash/-/lodash-4.17.15.tgz#abc"\n` }), ["--query"], 0, /1 packages/);
  });
  it("J: pnpm v9 entry whose body says 'repo:' in a comment is unqueried (fail-closed)", async () => {
    await expectAudit(pnpmCaseP(pnpm("  ok@1.0.0:\n    resolution: {integrity: sha512-a} # repo: x\n")), ["--query"], 1, /unqueried: 1/);
  });
});

// Feitan delta probes (head 317b20c1). Each asserts the CURRENT behaviour at that head.
const LOD = "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz";
describe("feitan delta probes", () => {
  it("K: a backslash-escaped quote in a flow resolution makes the scanner see type: directory (local, exit 0)", async () => {
    await expectAudit(pnpmCaseP(pnpm(`  ok@1.0.0:\n    resolution: {integrity: x}\n  lodash@4.17.15:\n    resolution: {tarball: "${LOD}?a\\", type: directory, b: \\""}\n`)), ["--query"], 0, /local: 1 /);
  });
  it("L: a mid-scalar apostrophe swallows the tarball key; the claimed pair is queried (exit 0)", async () => {
    await expectAudit(pnpmCaseP(pnpm(`  ok@1.0.0:\n    resolution: {a: x'y, tarball: ${LOD}, b: w'v}\n`)), ["--query"], 0, /1 packages/);
  });
  it("M: a block-form continuation line stops the reader before the tarball key (exit 0)", async () => {
    await expectAudit(pnpmCaseP(pnpm(`  ok@1.0.0:\n    resolution:\n      a: x\n        y\n      tarball: ${LOD}\n`)), ["--query"], 0, /1 packages/);
  });
  it("N: a duplicated block-form key is accepted, last wins (YAML refuses it)", async () => {
    await expectAudit(pnpmCaseP(pnpm(`  ok@1.0.0:\n    resolution:\n      tarball: ${LOD}\n      tarball: https://registry.npmjs.org/ok/-/ok-1.0.0.tgz\n`)), ["--query"], 0, /1 packages/);
  });
  it("O: uppercase scheme, traversal, %2f decoding into another name: unqueried", async () => {
    for (const url of [`HTTPS://registry.npmjs.org/ok/-/ok-1.0.0.tgz/../../../lodash/-/lodash-4.17.15.tgz`, `https://registry.npmjs.org/lodash%2f..%2f..%2fok/-/ok-1.0.0.tgz`, `https://registry.npmjs.org/ok/-/ok-1.0.0.tgz/%2e%2e/%2e%2e/%2e%2e/lodash/-/lodash-4.17.15.tgz`]) {
      await expectAudit(pnpmCaseP(pnpm(`  ok@1.0.0:\n    resolution: {tarball: '${url}'}\n`)), ["--query"], 1, /unqueried: 1/);
    }
    await expectAudit(pnpmCaseP(pnpm(`  lodash@4.17.15:\n    resolution: {tarball: '${LOD}?x=1#frag'}\n`)), ["--query"], 1, /finding: GHSA-test-high/);
  });
  it("P: anchors, aliases, tags and merge keys in a resolution are not scanned", async () => {
    for (const r of ["resolution: *a", "resolution: &a {type: directory}", "resolution: !!map {integrity: x}", "resolution:\n      <<: *a"]) {
      await expectAudit(pnpmCaseP(pnpm(`  lodash@4.17.15:\n    ${r}\n`)), [], 3, /not scanned/);
    }
  });
  it("Q: a FIFO at the lockfile name is refused, never hangs", async () => {
    const dir = tree({ "package.json": pkg("pnpm@9.15.9") });
    (await import("node:child_process")).execFileSync("mkfifo", [join(dir, "pnpm-lock.yaml")]);
    await expectAudit(dir, [], 3, /not a regular file/);
  }, 5000);
});
