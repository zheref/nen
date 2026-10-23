import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSeams } from "../seam/exec.js";
import { sha256 } from "./check.js";
import { excerptLines, testCases } from "./inventory.js";
import { parsePlist } from "./membership.js";
import { commit, MEMBER_SLUG, memberRepo } from "./member.testkit.js";
import { spec } from "./testkit.testkit.js";

const REACT = {
  "tsconfig.json": `{
  // a comment, and a trailing comma below
  "compilerOptions": { "strict": true },
  "include": ["src"],
  "exclude": ["src/legacy"],
}
`,
  "src/list/ListFeature.ts": "export const list = 1;\nexport const more = 2;\n",
  "src/list/ListPage.tsx": "export const Page = () => null;\n",
  "src/list/ListAdapter.tsx": "export const Cell = () => null;\n",
  "src/list/list.test.ts": "describe('list', () => {\n  it('shows the empty state', () => {});\n  test(\"refreshes\", () => {});\n});\n",
  "src/list/helpers.ts": "export const helper = 0;\n",
  "src/legacy/OldPage.tsx": "export const Old = () => null;\n",
  "scripts/BuildPage.tsx": "outside include\n",
  "node_modules/pkg/IndexPage.tsx": "a dependency\n",
};

describe("nen spec inventory", () => {
  it("reads a tsconfig member's build-system file set at a commit into rows, never excerpts", async () => {
    const member = memberRepo(REACT);
    const run = await spec(["inventory", "--scenario", "react-uzf-v1"], member.root, defaultSeams(), true);
    expect(run.code).toBe(0);
    const report = run.json();
    expect(Object.keys(report)).toEqual(["contract", "verdict", "repo", "origin", "lane", "cwd", "scenario", "handbook", "sha", "membership", "excluded", "rows", "totals", "unread", "reason"]);
    expect(report).toMatchObject({ contract: "nen.spec.inventory/v0.1", verdict: "read", origin: MEMBER_SLUG, sha: member.sha, scenario: "react-uzf-v1" });
    expect(report["membership"]).toEqual({ source: "tsconfig", read: ["tsconfig.json"], files: 5, classified: 3, joined: 1, unclassified: 1 });
    const rows = report["rows"] as { id: string; kind: string; lines: number[]; tier: string; ruleId: string; excerptSha256: string; sha: string }[];
    expect(rows.map((row) => row.id)).toEqual([
      "screen:src/list/ListPage.tsx",
      "state:src/list/ListFeature.ts",
      "test:src/list/list.test.ts#refreshes",
      "test:src/list/list.test.ts#shows the empty state",
    ]);
    const state = rows.find((row) => row.kind === "state");
    expect(state).toMatchObject({ lines: [1, 2], tier: "observed", ruleId: "RC-1", sha: member.sha, excerptSha256: sha256("export const list = 1;\nexport const more = 2;\n") });
    expect(rows.find((row) => row.id.endsWith("#refreshes"))).toMatchObject({ lines: [3, 3], tier: "declared" });
    expect(JSON.stringify(report)).not.toContain("export const");
    const totals = report["totals"] as { kind: string; total: number | null; unit: string }[];
    expect(totals.find((total) => total.kind === "test")).toEqual({ kind: "test", total: 2, unit: "case" });
    expect(totals.find((total) => total.kind === "screen")).toEqual({ kind: "screen", total: 1, unit: "file" });
    expect(totals.find((total) => total.kind === "flag")).toEqual({ kind: "flag", total: null, unit: "unknown" });
    expect(totals).toHaveLength(14);
  });

  it("reads the commit, never the work tree, and --exclude drops the caller's paths", async () => {
    const member = memberRepo(REACT);
    commit(member.root, { "src/list/ListFeature.ts": "changed\n" });
    const run = await spec(["inventory", "--scenario", "react-uzf-v1", "--at", member.sha, "--exclude", "src/list/*.test.ts"], member.root, defaultSeams(), true);
    expect(run.code).toBe(0);
    const report = run.json();
    expect(report["sha"]).toBe(member.sha);
    expect(report["excluded"]).toEqual(["src/list/list.test.ts"]);
    expect((report["rows"] as { id: string }[]).map((row) => row.id)).toEqual(["screen:src/list/ListPage.tsx", "state:src/list/ListFeature.ts"]);
  });

  it("follows a relative extends and every references[] project", async () => {
    const member = memberRepo({
      "tsconfig.base.json": `{ "include": ["src"] }\n`,
      "tsconfig.json": `{ "extends": "./tsconfig.base.json", "references": [{ "path": "./apps/web" }] }\n`,
      "src/HomePage.tsx": "x\n",
      "apps/web/tsconfig.json": `{ "files": ["app/RootPage.tsx"] }\n`,
      "apps/web/app/RootPage.tsx": "y\n",
      "apps/web/app/OtherPage.tsx": "not in files[]\n",
    });
    const report = (await spec(["inventory", "--scenario", "react-uzf-v1"], member.root, defaultSeams(), true)).json();
    expect((report["membership"] as { read: string[] }).read).toEqual(["tsconfig.json", "tsconfig.base.json", "apps/web/tsconfig.json"]);
    expect((report["rows"] as { id: string }[]).map((row) => row.id)).toEqual(["screen:apps/web/app/RootPage.tsx", "screen:src/HomePage.tsx"]);
  });

  it("reads a gradle member's include list and source sets, with JUnit cases", async () => {
    const member = memberRepo({
      "settings.gradle.kts": `rootProject.name = "fixture"\ninclude(":app")\n// include(":ghost")\n`,
      "app/build.gradle.kts": `android {\n  sourceSets { getByName("main").java.srcDirs("src/extra") }\n}\n`,
      "app/src/main/kotlin/list/ListScreen.kt": "fun ListScreen() {}\n",
      "app/src/main/kotlin/list/ListState.kt": "data class ListState(val x: Int)\n",
      "app/src/extra/list/ListEvent.kt": "sealed interface ListEvent\n",
      "app/src/test/kotlin/list/ListFeatureTest.kt": "class ListFeatureTest {\n  @Test\n  fun `shows the empty state`() {}\n  @Test fun refreshes() {}\n  fun helper() {}\n}\n",
      "app/src/main/res/values/strings.xml": "<resources/>\n",
      "ghost/src/main/kotlin/GhostScreen.kt": "not included\n",
    });
    const run = await spec(["inventory", "--scenario", "compose-uzf-v2"], member.root, defaultSeams(), true);
    expect(run.code).toBe(0);
    const report = run.json();
    expect((report["membership"] as { read: string[] }).read).toEqual(["settings.gradle.kts", "app/build.gradle.kts"]);
    expect((report["rows"] as { id: string }[]).map((row) => row.id)).toEqual([
      "event:app/src/extra/list/ListEvent.kt",
      "screen:app/src/main/kotlin/list/ListScreen.kt",
      "state:app/src/main/kotlin/list/ListState.kt",
      "strings:app/src/main/res/values/strings.xml",
      "test:app/src/test/kotlin/list/ListFeatureTest.kt#refreshes",
      "test:app/src/test/kotlin/list/ListFeatureTest.kt#shows the empty state",
    ]);
  });

  it("reads an Xcode project's build phases through its group tree, and a synchronized group minus its exceptions", async () => {
    const pbxproj = `// !$*UTF8*$!
{
  objects = {
    G0 /* main */ = { isa = PBXGroup; children = (G1, G2); sourceTree = "<group>"; };
    G1 = { isa = PBXGroup; path = App; children = (F1, F2); sourceTree = "<group>"; };
    G2 = { isa = PBXGroup; children = (F3); path = Frameworks; sourceTree = "<group>"; };
    F1 /* ListScreen.swift */ = { isa = PBXFileReference; path = ListScreen.swift; sourceTree = "<group>"; };
    F2 = { isa = PBXFileReference; path = "ListFeature.swift"; sourceTree = "<group>"; };
    F3 = { isa = PBXFileReference; path = Kit.framework; sourceTree = SDKROOT; };
    B1 = { isa = PBXBuildFile; fileRef = F1; };
    B2 = { isa = PBXBuildFile; fileRef = F2; };
    B3 = { isa = PBXBuildFile; fileRef = F3; };
    P1 = { isa = PBXSourcesBuildPhase; files = (B1, B2); };
    P2 = { isa = PBXFrameworksBuildPhase; files = (B3); };
    S1 = { isa = PBXFileSystemSynchronizedRootGroup; path = AppTests; sourceTree = "<group>"; exceptions = (E1); };
    E1 = { isa = PBXFileSystemSynchronizedBuildFileExceptionSet; membershipExceptions = (Old/LegacyFeatureTests.swift); target = T2; };
    T1 = { isa = PBXNativeTarget; name = App; buildPhases = (P1, P2); productType = "com.apple.product-type.application"; };
    T2 = { isa = PBXNativeTarget; name = AppTests; buildPhases = (); fileSystemSynchronizedGroups = (S1); };
  };
  rootObject = R0;
}
`;
    const member = memberRepo({
      "App.xcodeproj/project.pbxproj": pbxproj,
      "App/ListScreen.swift": "struct ListScreen {}\n",
      "App/ListFeature.swift": "struct ListFeature {}\n",
      "App/UnlistedScreen.swift": "not in a build phase\n",
      "AppTests/ListFeatureTests.swift": "final class ListFeatureTests {\n  func testEmpty() {}\n  @Test func refreshes() {}\n  func helper() {}\n}\n",
      "AppTests/Old/LegacyFeatureTests.swift": "func testOld() {}\n",
    });
    const run = await spec(["inventory", "--scenario", "swiftui-tca-uzf-v2"], member.root, defaultSeams(), true);
    expect(run.code).toBe(0);
    expect((run.json()["rows"] as { id: string }[]).map((row) => row.id)).toEqual([
      "screen:App/ListScreen.swift",
      "state:App/ListFeature.swift",
      "test:AppTests/ListFeatureTests.swift#refreshes",
      "test:AppTests/ListFeatureTests.swift#testEmpty",
    ]);
  });

  it("reads the lane's cwd from nen/contract.json at the commit", async () => {
    const member = memberRepo({
      "nen/contract.json": JSON.stringify({ project: { lanes: { web: { stack: "nextjs", cwd: "web" } }, verbs: { web: { build: { unsupported: "fixture" } } } } }),
      "web/tsconfig.json": `{ "include": ["src"] }`,
      "web/src/HomePage.tsx": "x\n",
    });
    const run = await spec(["inventory", "--scenario", "react-uzf-v1", "--lane", "web"], member.root, defaultSeams(), true);
    expect(run.code, run.err.join("\n") + run.out.join("\n")).toBe(0);
    expect(run.json()).toMatchObject({ lane: "web", cwd: "web" });
    const missing = await spec(["inventory", "--scenario", "react-uzf-v1", "--lane", "ios"], member.root, defaultSeams(), true);
    expect(missing.code).toBe(1);
    expect(missing.json()).toMatchObject({ verdict: "could-not-read" });
    expect(String(missing.json()["reason"])).toContain("--lane ios is not a lane");
  });

  it("says could-not-read, never an empty inventory, when the build system declares nothing to read", async () => {
    const member = memberRepo({ "src/HomePage.tsx": "x\n" });
    const run = await spec(["inventory", "--scenario", "react-uzf-v1"], member.root, defaultSeams(), true);
    expect(run.code).toBe(1);
    expect(run.json()).toMatchObject({ verdict: "could-not-read", rows: [] });
    expect(String(run.json()["reason"])).toContain("no tsconfig.json");
    const text = await spec(["inventory", "--scenario", "react-uzf-v1", "--at", "deadbeef"], member.root, defaultSeams());
    expect(text.code).toBe(1);
    expect(text.out[0]).toMatch(/^could-not-read: /);
  });

  it("reports a declaration it cannot read as partial, exit 1", async () => {
    const member = memberRepo({ "tsconfig.json": `{ "extends": "@scope/tsconfig", "include": ["src"] }`, "src/HomePage.tsx": "x\n" });
    const run = await spec(["inventory", "--scenario", "react-uzf-v1"], member.root, defaultSeams(), true);
    expect(run.code).toBe(1);
    expect(run.json()["verdict"]).toBe("partial");
    expect(run.json()["unread"]).toEqual([{ path: "tsconfig.json", reason: "extends '@scope/tsconfig', a package nen does not resolve; only its own keys were read" }]);
  });

  it("writes the same document with --out", async () => {
    const member = memberRepo(REACT);
    const out = join(mkdtempSync(join(tmpdir(), "nen-spec-out-")), "inventory.json");
    const run = await spec(["inventory", "--scenario", "react-uzf-v1", "--out", out], member.root, defaultSeams(), true);
    expect(run.code).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(run.json());
  });

  it("refuses an unknown scenario, a bad --at and another verb's flag at exit 2", async () => {
    const member = memberRepo(REACT);
    for (const argv of [["inventory", "--scenario", "flutter"], ["inventory", "--scenario", "react-uzf-v1", "--at", "main"], ["inventory", "--scenario", "react-uzf-v1", "--folder", "x"], ["inventory"]]) {
      const run = await spec(argv, member.root, defaultSeams());
      expect(run.code, argv.join(" ")).toBe(2);
    }
  });
});

describe("the inventory's readers", () => {
  it("hashes lines l1..l2 each ending in a newline", () => {
    expect(excerptLines("a\r\nb\nc", 2, 3)).toBe("b\nc\n");
  });

  it("finds test cases by each detector", () => {
    expect(testCases("js-test", "it.only('a', x)\n  test(`b`, y)\nitem('c')\n")).toEqual([{ name: "a", line: 1 }, { name: "b", line: 2 }]);
    expect(testCases("junit", "@Test\n@DisplayName(\"x\")\nfun one() {}\nfun two() {}\n")).toEqual([{ name: "one", line: 3 }]);
    expect(testCases("swift-test", "func testA() {}\nfunc helper() {}\n@Test\nfunc b() {}\n")).toEqual([{ name: "testA", line: 1 }, { name: "b", line: 4 }]);
  });

  it("parses the property-list forms a project file uses and refuses a broken one", () => {
    expect(parsePlist(`{ a = "x\\"y"; b = (c, d,); /* c */ e = { f = g; }; // tail\n}`)).toEqual({ a: 'x"y', b: ["c", "d"], e: { f: "g" } });
    expect(() => parsePlist("{ a = b }")).toThrow(/expected ';'/);
  });
});
