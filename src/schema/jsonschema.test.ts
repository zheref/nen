import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UnsupportedSchemaError, validateJsonSchema } from "./jsonschema.js";

const FINDINGS = JSON.parse(readFileSync(join(process.cwd(), "src", "pr", "fixtures", "findings.schema.json"), "utf8")) as unknown;
const finding = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "F1", scope: "security", persona: "feitan", rule: "SEC-3", severity: "high", path: "src/a.ts", line: 3,
  evidence: "x", proposedFix: "y", disposition: { state: "fixed" }, ...overrides,
});

describe("the JSON Schema subset validator (zheref/nen#510)", () => {
  it("accepts a findings document that meets the schema", () => {
    expect(validateJsonSchema(FINDINGS, { scopes: [], findings: [finding()] })).toEqual([]);
  });

  it("names the first failing JSON pointer", () => {
    const violations = validateJsonSchema(FINDINGS, { scopes: [], findings: [finding(), finding({ severity: "huge" })] });
    expect(violations[0]).toMatchObject({ pointer: "/findings/1/severity", keyword: "enum" });
  });

  it("holds an if/then rule: a CON/HR finding pushed back fails", () => {
    const violations = validateJsonSchema(FINDINGS, { scopes: [], findings: [finding({ rule: "HR-10", severity: "critical", disposition: { state: "pushed-back", detail: "no" } })] });
    expect(violations.map((v) => v.pointer)).toContain("/findings/0/disposition/state");
  });

  it("follows a $ref through subschema positions only", () => {
    const schema = { $defs: { a: { properties: { b: { type: "string" } } } }, properties: { x: { $ref: "#/$defs/a/properties/b" } } };
    expect(validateJsonSchema(schema, { x: "ok" })).toEqual([]);
    expect(validateJsonSchema(schema, { x: 1 })[0]).toMatchObject({ pointer: "/x", keyword: "type" });
  });

  it("follows local $ref, required, minLength, pattern, minimum, items, anyOf, oneOf, not, additionalProperties", () => {
    const schema = {
      $defs: { name: { type: "string", minLength: 2, pattern: "^[a-z]+$" } },
      type: "object",
      required: ["a"],
      additionalProperties: false,
      properties: {
        a: { $ref: "#/$defs/name" },
        n: { type: "integer", minimum: 1, maximum: 3 },
        l: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
        u: { anyOf: [{ type: "string" }, { type: "null" }] },
        o: { oneOf: [{ const: 1 }, { const: 2 }] },
        x: { not: { const: "no" } },
      },
    };
    expect(validateJsonSchema(schema, { a: "ok", n: 2, l: ["x"], u: null, o: 1, x: "yes" })).toEqual([]);
    const pointers = validateJsonSchema(schema, { a: "A", n: 9, l: [1, 2, 3], u: 3, o: 5, x: "no", extra: 1 }).map((v) => `${v.pointer}:${v.keyword}`);
    expect(pointers).toEqual(expect.arrayContaining(["/a:minLength", "/a:pattern", "/n:maximum", "/l:maxItems", "/l/0:type", "/u:anyOf", "/o:oneOf", "/x:not", "/extra:additionalProperties"]));
    expect(validateJsonSchema(schema, {}).map((v) => v.keyword)).toEqual(["required"]);
  });

  it.each([
    [{ type: "object", format: "email" }, /format/],
    [{ dependentRequired: {} }, /dependentRequired/],
    [{ $ref: "https://example.com/s.json" }, /not a local pointer/],
    [{ $ref: "#/$defs/missing" }, /resolves to nothing/],
    [{ type: "thing" }, /not a JSON Schema type/],
    [{ pattern: "(" }, /does not compile/],
    [{ anyOf: [] }, /non-empty array/],
    [{ required: "id" }, /required must be an array of distinct strings/],
    [{ required: ["a", "a"] }, /required must be an array of distinct strings/],
    [{ enum: "a" }, /enum must be a non-empty array/],
    [{ enum: [] }, /enum must be a non-empty array/],
    [{ properties: [] }, /properties must be an object of schemas/],
    [{ properties: "oops" }, /properties must be an object of schemas/],
    [{ $defs: [] }, /\$defs must be an object of schemas/],
    [{ minLength: "3" }, /minLength must be a non-negative integer/],
    [{ maxLength: -1 }, /maxLength must be a non-negative integer/],
    [{ minItems: 1.5 }, /minItems must be a non-negative integer/],
    [{ maxItems: "2" }, /maxItems must be a non-negative integer/],
    [{ minimum: "5" }, /minimum must be a number/],
    [{ maximum: null }, /maximum must be a number/],
    [{ type: [] }, /at least one type/],
    [{ items: [{ type: "string" }] }, /must be an object or a boolean/],
    [{ properties: { n: { minLength: "3" } } }, /minLength must be a non-negative integer/],
    [{ examples: [{ format: "x" }], $ref: "#/examples/0" }, /not a subschema position/],
    [{ $comment: "x", $ref: "#/$comment" }, /not a subschema position/],
    [{ $ref: "#/%E0" }, /does not decode/],
  ])("refuses a schema it cannot honour %#, rather than skipping the keyword", (schema, message) => {
    expect(() => validateJsonSchema(schema, {})).toThrow(UnsupportedSchemaError);
    expect(() => validateJsonSchema(schema, {})).toThrow(message);
  });
});
