import { describe, expect, it } from "vitest";
import { ColorError, resolveStatus } from "./status.js";
import type { ColorVocabulary } from "../schema/colors.js";

interface Value {
  readonly name: string;
  readonly emoji: string | null;
  readonly hex: string | null;
  readonly label: string | null;
  readonly means: string | null;
  readonly extra: Record<string, never>;
}

function vocab(precedence: string[], valueNames: string[]): ColorVocabulary {
  const values: Value[] = valueNames.map((name): Value => ({
    name,
    emoji: `[${name}]`,
    hex: null,
    label: name,
    means: null,
    extra: {},
  }));
  const category = {
    name: "status",
    scope: null,
    precedence,
    values,
    get: (name: string): Value | undefined => values.find((v): boolean => v.name === name),
  };
  const categories = [category];
  return {
    path: "schemas/colors.yml",
    version: 1,
    categories,
    category: (name): typeof category | undefined => (name === "status" ? category : undefined),
    resolve: (): undefined => undefined,
  };
}

describe("resolveStatus", () => {
  it("applies FIRST MATCH IN THE FILE'S OWN ORDER", () => {
    const colors = vocab(["blocked", "ready"], ["blocked", "ready"]);
    const result = resolveStatus(colors, "status", ["ready", "blocked"]);
    expect(result.resolved?.name).toBe("blocked");
    expect(result.outranked).toEqual(["ready"]);
  });

  it("refuses a category the file does not declare", () => {
    const colors = vocab(["a"], ["a"]);
    expect(() => resolveStatus(colors, "nope", [])).toThrow(ColorError);
  });

  it("reports unknown present names separately from a resolved value", () => {
    const colors = vocab(["a"], ["a"]);
    const result = resolveStatus(colors, "status", ["a", "not-a-value"]);
    expect(result.resolved?.name).toBe("a");
    expect(result.unknown).toEqual(["not-a-value"]);
  });

  it("a single candidate wins even with no declared precedence", () => {
    const colors = vocab([], ["only"]);
    const result = resolveStatus(colors, "status", ["only"]);
    expect(result.resolved?.name).toBe("only");
  });

  it("more than one candidate with no precedence is UNRESOLVED, never an arbitrary pick", () => {
    const colors = vocab([], ["a", "b"]);
    const result = resolveStatus(colors, "status", ["a", "b"]);
    expect(result.resolved).toBeNull();
    expect(result.reason).toMatch(/no precedence/);
  });

  it("is unresolved when nothing present matches the category's values", () => {
    const colors = vocab(["a"], ["a"]);
    const result = resolveStatus(colors, "status", []);
    expect(result.resolved).toBeNull();
  });
});
