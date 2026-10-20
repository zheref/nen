import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadRepoRegistry, parseRepoRegistry } from "../schema/repos.js";
import { resolveFamily, renderFamily } from "./family.js";

const ROOT = join(process.cwd(), "src/schema/fixtures/families-repo");
const base = loadRepoRegistry(ROOT);

describe("family resolution (#453)", () => {
  it("returns the spec first, members in declaration order, with product_codes authority", () => {
    const result = resolveFamily(base, "SAMPLE-PRODUCT");
    expect(result).toEqual({ family: "sample-product", spec: { code: null, repo: "owner/product-spec", role: "spec", gate: "G2" }, members: [{ code: "RA", repo: "owner/product-ios", platform: "ios" }, { code: "RB", repo: "owner/product-android", platform: "android" }] });
    expect(renderFamily(result)).toEqual(["- owner/product-spec spec", "RA owner/product-ios ios", "RB owner/product-android android"]);
    expect(base.consumers).toHaveLength(2);
    expect(base.byCode("RA")).toBeUndefined();
  });

  it("refuses a missing or ambiguous owner, naming the member and remedy", () => {
    for (const consumers of [[], [{ repo: "one/product-android", consumes: [] }, { repo: "two/product-android", consumes: [] }]]) {
      const registry = parseRepoRegistry("nen/repos.json", { consumers, product_codes: base.productCodes, families: base.families });
      expect(() => resolveFamily(registry, "sample-product")).toThrow(/families\[0\].members\[1\].code.*Record the full owner\/name/);
    }
  });

  it("never replaces a full product-code slug with a conflicting consumer code", () => {
    const registry = parseRepoRegistry("nen/repos.json", { consumers: [{ repo: "other/conflicting", code: "RA", consumes: [] }], product_codes: { RA: "owner/product-ios", RB: "owner/product-android", SP: "owner/product-spec" }, families: base.families });
    expect(resolveFamily(registry, "sample-product").spec.code).toBe("SP");
    expect(resolveFamily(registry, "sample-product").members[0]?.repo).toBe("owner/product-ios");
  });

  it("refuses malformed or terminal-active product-code repositories in this new lookup only", () => {
    for (const value of ["owner/a/b", "owner/bad\nrow", "owner/bad\u001b[2K"]) {
      const registry = parseRepoRegistry("nen/repos.json", { consumers: [], product_codes: { RA: value, RB: "owner/product-android" }, families: base.families });
      expect(() => resolveFamily(registry, "sample-product")).toThrow(/families\[0\].members\[0\].code/);
    }
  });

  it("unknown families and blank selectors list only declared family choices", () => {
    for (const name of ["sample", "", "missing\nrow"]) expect(() => resolveFamily(base, name)).toThrow(/Declared families: "sample-product"/);
    expect(() => resolveFamily({ ...base, families: [] }, "missing")).toThrow("(none declared)");
  });
});
