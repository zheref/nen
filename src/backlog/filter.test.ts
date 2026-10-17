import { describe, expect, it } from "vitest";
import { parseLabelTaxonomy } from "../schema/labels.js";
import { filterObjects, validateFilter, type EffortObject } from "./filter.js";

const taxonomy = parseLabelTaxonomy("target/nen/labels.json", { labels: ["a", "b", "c", "x&y", "t:severity/critical", "t:severity/high", "t:severity/low"].map((name) => ({ name, color: "123456", description: "fixture" })) });
const order = "critical,high,low";
const objects: EffortObject[] = [
  { kind: "issue", number: 1, labels: ["a", "t:severity/high"], linked: [3, 5] },
  { kind: "issue", number: 2, labels: ["b", "t:severity/low"], linked: [3] },
  { kind: "pr", number: 3, labels: ["c"], linked: [1, 2] },
  { kind: "pr", number: 4, labels: ["b", "t:severity/critical"], linked: [] },
  { kind: "pr", number: 5, labels: [], linked: [1] },
];
const ids = (rows: readonly EffortObject[]): number[] => rows.map((row) => row.number);

describe("effort filters (#410)", () => {
  it("ANDs labels over the issue/direct-PR union and retains every member", () => {
    expect(ids(filterObjects(objects, validateFilter(taxonomy, ["a", "c"])))).toEqual([1, 3, 5]);
    expect(ids(filterObjects(objects, validateFilter(taxonomy, ["c"])))).toEqual([1, 2, 3, 5]);
    expect(ids(filterObjects(objects, validateFilter(taxonomy, ["b"])))).toEqual([2, 3, 4]);
  });
  it("never mixes sibling issue labels transitively through a shared PR", () => {
    expect(filterObjects(objects, validateFilter(taxonomy, ["a", "b"]))).toEqual([]);
  });
  it("retains the fetched context only: an absent companion donates no label", () => {
    expect(filterObjects(objects.slice(0, 1), validateFilter(taxonomy, ["c"]))).toEqual([]);
    expect(ids(filterObjects([objects[2]!], validateFilter(taxonomy, ["c"])))).toEqual([3]);
  });
  it("selects exact bands and the band-or-higher range, then ANDs labels", () => {
    expect(ids(filterObjects(objects, validateFilter(taxonomy, [], "HIGH", order)))).toEqual([1, 3, 5]);
    expect(ids(filterObjects(objects, validateFilter(taxonomy, [], "high+", order)))).toEqual([1, 3, 4, 5]);
    expect(ids(filterObjects(objects, validateFilter(taxonomy, ["b"], "high+", order)))).toEqual([4]);
  });
  it.each(["missing", "A", ""])("refuses undeclared or empty label %s", (name) => expect(() => validateFilter(taxonomy, [name])).toThrow());
  it.each(["x", "y", "x&y"])("names the ampersand-label limit for %s", (name) => expect(() => validateFilter(taxonomy, [name])).toThrow("labels containing '&' are not supported in selectors: 'x&y'"));
  it("names ampersand labels even when selector splitting trimmed their segments", () => {
    const spaced = parseLabelTaxonomy("labels", { labels: [{ name: "one & two", color: "123456", description: "fixture" }] });
    expect(() => validateFilter(spaced, ["one"])).toThrow("labels containing '&' are not supported in selectors: 'one & two'");
  });
  it.each([
    ["high", undefined], ["high++", order], ["missing", order], ["high", "high,low"], ["high", "critical,high,high,low"], ["high", "critical,,high,low"],
  ])("refuses malformed or incomplete band input %s %s", (severity, ranked) => expect(() => validateFilter(taxonomy, [], severity, ranked)).toThrow());
  it("refuses a missing or ambiguous severity mapping rather than inventing one", () => {
    const labels = ["priority: p1", "a"].map((name) => ({ name, color: "123456", description: "fixture" }));
    expect(() => validateFilter(parseLabelTaxonomy("labels", { labels }), [], "high", order)).toThrow("none are declared");
    labels.push(...["one:severity/high", "two:severity/high"].map((name) => ({ name, color: "123456", description: "fixture" })));
    expect(() => validateFilter(parseLabelTaxonomy("labels", { labels }), [], "high", "high")).toThrow("ambiguous");
  });
});
