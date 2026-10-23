// src/schema/jsonschema.ts -- a JSON Schema (draft 2020-12) SUBSET validator,
// for a schema the CALLER supplies (zheref/nen#510: `nen pr ledger post
// --findings-schema`, because nen carries no consumer's contract).
//
// WHY A SUBSET, AND WHY IT FAILS CLOSED. nen adds no dependency for this (the
// supply chain is two pinned packages), so it implements the assertion keywords
// a findings contract uses and REFUSES a schema that uses any other: a keyword
// this validator silently skipped would be a rule the caller believes is
// enforced and is not. Annotation keywords ($schema, $id, $comment, title,
// description, default, examples, deprecated, readOnly, writeOnly, $defs,
// definitions) assert nothing and are accepted. `format` is refused: draft
// 2020-12 makes it an annotation by default, and a caller who wrote it most
// likely meant an assertion.
//
// ASSERTED: type, enum, const, required, properties, additionalProperties
// (boolean or schema), items (one schema), minItems, maxItems, minLength,
// maxLength, pattern, minimum, maximum, allOf, anyOf, oneOf, not, if/then/else,
// and $ref to a local JSON pointer ("#", "#/$defs/x", "#/properties/y").
//
// THE ANSWER IS THE FIRST FAILING INSTANCE POINTER (RFC 6901), in document
// order, with the keyword and the schema pointer it came from -- what AC-2 of
// #510 asks the refusal to name.

export interface SchemaViolation {
  /** JSON pointer into the instance ("" is the root). */
  readonly pointer: string;
  /** JSON pointer into the schema, to the keyword that failed. */
  readonly schemaPointer: string;
  readonly keyword: string;
  readonly message: string;
}

/** A schema this validator cannot honour: exit 2 at the caller, never "valid". */
export class UnsupportedSchemaError extends Error {}

const ASSERTIONS = new Set([
  "type", "enum", "const", "required", "properties", "additionalProperties", "items", "minItems", "maxItems",
  "minLength", "maxLength", "pattern", "minimum", "maximum", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "$ref",
]);
const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly", "$defs", "definitions"]);
const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

const escape = (token: string): string => token.replace(/~/g, "~0").replace(/\//g, "~1");
const unescape = (token: string): string => token.replace(/~1/g, "/").replace(/~0/g, "~");

/** Resolve a local `#...` pointer in `root`, or throw UnsupportedSchemaError. */
function resolveRef(root: unknown, ref: string, at: string): { schema: unknown; pointer: string } {
  if (!ref.startsWith("#")) throw new UnsupportedSchemaError(`${at}: $ref '${ref}' is not a local pointer ('#/...'); only references inside the supplied schema are followed.`);
  const path = ref.slice(1);
  let node: unknown = root;
  if (path !== "") {
    if (!path.startsWith("/")) throw new UnsupportedSchemaError(`${at}: $ref '${ref}' is not a JSON pointer.`);
    for (const raw of path.slice(1).split("/")) {
      const key = unescape(decodeURIComponent(raw));
      if (typeof node !== "object" || node === null || !Object.hasOwn(node, key)) throw new UnsupportedSchemaError(`${at}: $ref '${ref}' resolves to nothing.`);
      node = (node as Record<string, unknown>)[key];
    }
  }
  return { schema: node, pointer: path };
}

/** Walk the schema once, refusing every keyword this validator does not assert or ignore. */
export function assertSupportedSchema(root: unknown): void {
  const seen = new Set<unknown>();
  const walk = (schema: unknown, at: string): void => {
    if (typeof schema === "boolean") return;
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) throw new UnsupportedSchemaError(`${at || "/"}: a schema must be an object or a boolean.`);
    if (seen.has(schema)) return;
    seen.add(schema);
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      const here = `${at}/${escape(key)}`;
      if (ANNOTATIONS.has(key)) {
        if ((key === "$defs" || key === "definitions") && typeof value === "object" && value !== null) {
          for (const [name, sub] of Object.entries(value as Record<string, unknown>)) walk(sub, `${here}/${escape(name)}`);
        }
        continue;
      }
      if (!ASSERTIONS.has(key)) throw new UnsupportedSchemaError(`${here}: keyword '${key}' is not one this validator asserts; refused rather than skipped, since a skipped keyword is a rule nobody enforces.`);
      if (key === "type") {
        const types = Array.isArray(value) ? value : [value];
        for (const type of types) if (typeof type !== "string" || !TYPES.has(type)) throw new UnsupportedSchemaError(`${here}: '${String(type)}' is not a JSON Schema type.`);
      }
      if (key === "pattern") {
        if (typeof value !== "string") throw new UnsupportedSchemaError(`${here}: pattern must be a string.`);
        try {
          new RegExp(value, "u");
        } catch (error) {
          throw new UnsupportedSchemaError(`${here}: pattern does not compile (${error instanceof Error ? error.message : String(error)}).`);
        }
      }
      if (key === "$ref") {
        if (typeof value !== "string") throw new UnsupportedSchemaError(`${here}: $ref must be a string.`);
        resolveRef(root, value, here);
      }
      if (key === "properties" && typeof value === "object" && value !== null) {
        for (const [name, sub] of Object.entries(value as Record<string, unknown>)) walk(sub, `${here}/${escape(name)}`);
      }
      if (["items", "not", "if", "then", "else", "additionalProperties"].includes(key)) walk(value, here);
      if (["allOf", "anyOf", "oneOf"].includes(key)) {
        if (!Array.isArray(value) || value.length === 0) throw new UnsupportedSchemaError(`${here}: ${key} must be a non-empty array.`);
        value.forEach((sub, index): void => walk(sub, `${here}/${index}`));
      }
    }
  };
  walk(root, "");
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((key): boolean => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Every violation of `instance` against `root` (after assertSupportedSchema), first failing first. */
export function validateJsonSchema(root: unknown, instance: unknown): readonly SchemaViolation[] {
  assertSupportedSchema(root);
  const check = (schema: unknown, schemaAt: string, value: unknown, at: string, depth: number): SchemaViolation[] => {
    if (depth > 64) throw new UnsupportedSchemaError(`${schemaAt}: $ref recursion deeper than 64 levels.`);
    if (schema === true) return [];
    if (schema === false) return [{ pointer: at, schemaPointer: schemaAt, keyword: "false", message: "no value is allowed here" }];
    const s = schema as Record<string, unknown>;
    const out: SchemaViolation[] = [];
    const fail = (keyword: string, message: string, pointer = at): void => {
      out.push({ pointer, schemaPointer: `${schemaAt}/${keyword}`, keyword, message });
    };
    if (typeof s["$ref"] === "string") {
      const target = resolveRef(root, s["$ref"], schemaAt);
      out.push(...check(target.schema, target.pointer, value, at, depth + 1));
    }
    if (s["type"] !== undefined) {
      const types = (Array.isArray(s["type"]) ? s["type"] : [s["type"]]) as string[];
      if (!types.some((type): boolean => matchesType(value, type))) fail("type", `is ${typeOf(value)}, not ${types.join(" or ")}`);
    }
    if (Array.isArray(s["enum"]) && !s["enum"].some((option): boolean => deepEqual(option, value))) fail("enum", `is ${JSON.stringify(value)}, not one of ${JSON.stringify(s["enum"])}`);
    if (Object.hasOwn(s, "const") && !deepEqual(s["const"], value)) fail("const", `is ${JSON.stringify(value)}, not ${JSON.stringify(s["const"])}`);
    if (typeof value === "string") {
      const length = [...value].length;
      if (typeof s["minLength"] === "number" && length < s["minLength"]) fail("minLength", `is ${length} character(s), fewer than ${s["minLength"]}`);
      if (typeof s["maxLength"] === "number" && length > s["maxLength"]) fail("maxLength", `is ${length} character(s), more than ${s["maxLength"]}`);
      if (typeof s["pattern"] === "string" && !new RegExp(s["pattern"], "u").test(value)) fail("pattern", `does not match ${s["pattern"]}`);
    }
    if (typeof value === "number") {
      if (typeof s["minimum"] === "number" && value < s["minimum"]) fail("minimum", `is ${value}, below ${s["minimum"]}`);
      if (typeof s["maximum"] === "number" && value > s["maximum"]) fail("maximum", `is ${value}, above ${s["maximum"]}`);
    }
    if (Array.isArray(value)) {
      if (typeof s["minItems"] === "number" && value.length < s["minItems"]) fail("minItems", `has ${value.length} item(s), fewer than ${s["minItems"]}`);
      if (typeof s["maxItems"] === "number" && value.length > s["maxItems"]) fail("maxItems", `has ${value.length} item(s), more than ${s["maxItems"]}`);
      if (s["items"] !== undefined) value.forEach((item, index): void => { out.push(...check(s["items"], `${schemaAt}/items`, item, `${at}/${index}`, depth)); });
    }
    if (typeOf(value) === "object") {
      const object = value as Record<string, unknown>;
      if (Array.isArray(s["required"])) {
        for (const key of s["required"] as string[]) if (!Object.hasOwn(object, key)) fail("required", `is missing the required key '${key}'`);
      }
      const properties = (s["properties"] ?? {}) as Record<string, unknown>;
      for (const [key, sub] of Object.entries(properties)) {
        if (Object.hasOwn(object, key)) out.push(...check(sub, `${schemaAt}/properties/${escape(key)}`, object[key], `${at}/${escape(key)}`, depth));
      }
      if (s["additionalProperties"] !== undefined) {
        for (const key of Object.keys(object)) {
          if (Object.hasOwn(properties, key)) continue;
          if (s["additionalProperties"] === false) fail("additionalProperties", `carries the key '${key}' the schema does not allow`, `${at}/${escape(key)}`);
          else out.push(...check(s["additionalProperties"], `${schemaAt}/additionalProperties`, object[key], `${at}/${escape(key)}`, depth));
        }
      }
    }
    if (Array.isArray(s["allOf"])) s["allOf"].forEach((sub, index): void => { out.push(...check(sub, `${schemaAt}/allOf/${index}`, value, at, depth)); });
    if (Array.isArray(s["anyOf"]) && !s["anyOf"].some((sub, index): boolean => check(sub, `${schemaAt}/anyOf/${index}`, value, at, depth).length === 0)) fail("anyOf", "matches none of anyOf");
    if (Array.isArray(s["oneOf"])) {
      const passing = s["oneOf"].filter((sub, index): boolean => check(sub, `${schemaAt}/oneOf/${index}`, value, at, depth).length === 0).length;
      if (passing !== 1) fail("oneOf", `matches ${passing} of oneOf, not exactly one`);
    }
    if (s["not"] !== undefined && check(s["not"], `${schemaAt}/not`, value, at, depth).length === 0) fail("not", "matches the schema under not");
    if (s["if"] !== undefined) {
      const holds = check(s["if"], `${schemaAt}/if`, value, at, depth).length === 0;
      if (holds && s["then"] !== undefined) out.push(...check(s["then"], `${schemaAt}/then`, value, at, depth));
      if (!holds && s["else"] !== undefined) out.push(...check(s["else"], `${schemaAt}/else`, value, at, depth));
    }
    return out;
  };
  return check(root, "", instance, "", 0);
}
