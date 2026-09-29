// src/commit/case.test.ts -- ./case.ts held to commitlint's own answers.
//
// EVERY EXPECTED VALUE IN THE THREE TABLES BELOW WAS RECORDED FROM THE REAL
// PACKAGES -- @commitlint/ensure and @commitlint/rules 21.2.3, with the
// es-toolkit 1.52.0 they resolve -- on 2026-09-29, by calling them, not by
// reading the port. A table written from the port's own logic would pass on
// the port's own bugs; these pass only if the port and commitlint agree.

import { describe, expect, it } from "vitest";
import { CASE_NAMES, deburr, ensureCase, isCaseName, subjectCaseVerdict, toCase, words, type CaseCheck, type CaseName, type Condition } from "./case.js";

const FAMILIES = ["lower-case", "upper-case", "camel-case", "kebab-case", "pascal-case", "sentence-case", "snake-case", "start-case"] as const;

/** @commitlint/ensure 21.2.3's to-case, per input, per case. */
const TO_CASE: readonly (readonly [string, Record<(typeof FAMILIES)[number], string>])[] = [
  ["start the timer", { "lower-case": "start the timer", "upper-case": "START THE TIMER", "camel-case": "startTheTimer", "kebab-case": "start-the-timer", "pascal-case": "StartTheTimer", "sentence-case": "Start the timer", "snake-case": "start_the_timer", "start-case": "Start The Timer" }],
  ["Start The Timer", { "lower-case": "start the timer", "upper-case": "START THE TIMER", "camel-case": "startTheTimer", "kebab-case": "start-the-timer", "pascal-case": "StartTheTimer", "sentence-case": "Start The Timer", "snake-case": "start_the_timer", "start-case": "Start The Timer" }],
  ["HTTPRequest handler", { "lower-case": "httprequest handler", "upper-case": "HTTPREQUEST HANDLER", "camel-case": "httpRequestHandler", "kebab-case": "http-request-handler", "pascal-case": "HttpRequestHandler", "sentence-case": "HTTPRequest handler", "snake-case": "http_request_handler", "start-case": "HTTP Request Handler" }],
  ["fooBar baz", { "lower-case": "foobar baz", "upper-case": "FOOBAR BAZ", "camel-case": "fooBarBaz", "kebab-case": "foo-bar-baz", "pascal-case": "FooBarBaz", "sentence-case": "FooBar baz", "snake-case": "foo_bar_baz", "start-case": "Foo Bar Baz" }],
  ["foo-bar", { "lower-case": "foo-bar", "upper-case": "FOO-BAR", "camel-case": "fooBar", "kebab-case": "foo-bar", "pascal-case": "FooBar", "sentence-case": "Foo-bar", "snake-case": "foo_bar", "start-case": "Foo Bar" }],
  ["foo_bar", { "lower-case": "foo_bar", "upper-case": "FOO_BAR", "camel-case": "fooBar", "kebab-case": "foo-bar", "pascal-case": "FooBar", "sentence-case": "Foo_bar", "snake-case": "foo_bar", "start-case": "Foo Bar" }],
  ["FOO BAR", { "lower-case": "foo bar", "upper-case": "FOO BAR", "camel-case": "fooBar", "kebab-case": "foo-bar", "pascal-case": "FooBar", "sentence-case": "FOO BAR", "snake-case": "foo_bar", "start-case": "FOO BAR" }],
  ["café au lait", { "lower-case": "café au lait", "upper-case": "CAFÉ AU LAIT", "camel-case": "cafeAuLait", "kebab-case": "cafe-au-lait", "pascal-case": "CafeAuLait", "sentence-case": "Café au lait", "snake-case": "cafe_au_lait", "start-case": "Cafe Au Lait" }],
  ["don't stop", { "lower-case": "don't stop", "upper-case": "DON'T STOP", "camel-case": "dontStop", "kebab-case": "dont-stop", "pascal-case": "DontStop", "sentence-case": "Don't stop", "snake-case": "dont_stop", "start-case": "Dont Stop" }],
  ["1st place", { "lower-case": "1st place", "upper-case": "1ST PLACE", "camel-case": "1stPlace", "kebab-case": "1st-place", "pascal-case": "1stPlace", "sentence-case": "1st place", "snake-case": "1st_place", "start-case": "1st Place" }],
  ["Ǆemal", { "lower-case": "ǆemal", "upper-case": "ǄEMAL", "camel-case": "ǆemal", "kebab-case": "ǆemal", "pascal-case": "Ǆemal", "sentence-case": "Ǆemal", "snake-case": "ǆemal", "start-case": "Ǆemal" }],
];

/** @commitlint/ensure 21.2.3's `case`, per input, per case. */
const ENSURE: readonly (readonly [string, Record<(typeof FAMILIES)[number], boolean>])[] = [
  ["Start the timer", { "lower-case": false, "upper-case": false, "camel-case": false, "kebab-case": false, "pascal-case": false, "sentence-case": true, "snake-case": false, "start-case": false }],
  ["start the timer", { "lower-case": true, "upper-case": false, "camel-case": false, "kebab-case": false, "pascal-case": false, "sentence-case": false, "snake-case": false, "start-case": false }],
  ["`Escape` key closes", { "lower-case": true, "upper-case": false, "camel-case": false, "kebab-case": false, "pascal-case": false, "sentence-case": false, "snake-case": false, "start-case": false }],
  ['"Escape" closes', { "lower-case": true, "upper-case": false, "camel-case": true, "kebab-case": true, "pascal-case": false, "sentence-case": false, "snake-case": true, "start-case": false }],
  ["'Escape' closes", { "lower-case": true, "upper-case": false, "camel-case": true, "kebab-case": true, "pascal-case": false, "sentence-case": false, "snake-case": true, "start-case": false }],
  ["Update `Foo`", { "lower-case": false, "upper-case": false, "camel-case": false, "kebab-case": false, "pascal-case": true, "sentence-case": true, "snake-case": false, "start-case": true }],
  ["`Foo`", { "lower-case": true, "upper-case": true, "camel-case": true, "kebab-case": true, "pascal-case": true, "sentence-case": true, "snake-case": true, "start-case": true }],
  ["2fa support", { "lower-case": true, "upper-case": true, "camel-case": true, "kebab-case": true, "pascal-case": true, "sentence-case": true, "snake-case": true, "start-case": true }],
  ["x `unterminated", { "lower-case": true, "upper-case": false, "camel-case": false, "kebab-case": false, "pascal-case": false, "sentence-case": false, "snake-case": false, "start-case": false }],
  ["a 'b", { "lower-case": true, "upper-case": false, "camel-case": false, "kebab-case": false, "pascal-case": false, "sentence-case": false, "snake-case": false, "start-case": false }],
];

const CONVENTIONAL = ["sentence-case", "start-case", "pascal-case", "upper-case"] as const;

/** @commitlint/rules 21.2.3's subjectCase: [subject, when, value as configured, valid, message]. */
const RULE: readonly (readonly [string, Condition, string | readonly (string | { when: string; case: string })[], boolean, string | null])[] = [
  // The issue's own subjects, under @commitlint/config-conventional's default.
  ["Start the timer", "never", CONVENTIONAL, false, "subject must not be sentence-case"],
  ["Escape key closes the modal", "never", CONVENTIONAL, false, "subject must not be sentence-case"],
  ["start the timer", "never", CONVENTIONAL, true, null],
  ["`Escape` key closes the modal", "never", CONVENTIONAL, true, null],
  ["API endpoint", "never", CONVENTIONAL, false, "subject must not be sentence-case"],
  // `never` reports only the cases that MATCHED.
  ["ADD THING", "never", CONVENTIONAL, false, "subject must not be sentence-case, start-case, upper-case"],
  ["Élan", "never", CONVENTIONAL, false, "subject must not be sentence-case"],
  ["2fa support", "never", CONVENTIONAL, true, null],
  ['"Quoted" start', "never", CONVENTIONAL, true, null],
  // A titlecase digraph: es-toolkit finds no word in it, the empty transform counts as a match.
  ["ǲ", "never", CONVENTIONAL, false, "subject must not be start-case, pascal-case"],
  [" leading space", "never", CONVENTIONAL, true, null],
  // `always` reports every case listed, and a single string is a list of one.
  ["Start the timer", "always", "lower-case", false, "subject must be lower-case"],
  ["start the timer", "always", "lower-case", true, null],
  ["Élan", "always", "lower-case", false, "subject must be lower-case"],
  ["Start the timer", "always", ["sentence-case", "lower-case"], true, null],
  ["ǲ", "always", ["sentence-case", "lower-case"], false, "subject must be sentence-case, lower-case"],
  ["start the timer", "never", "lower-case", false, "subject must not be lower-case"],
  ["Start the timer", "never", "lower-case", true, null],
  // An entry's own `when: never` inverts that entry before the rule's condition applies.
  ["ADD THING", "always", [{ when: "never", case: "upper-case" }], false, "subject must be upper-case"],
  ["Start the timer", "always", [{ when: "never", case: "upper-case" }], true, null],
  // `always` with nothing listed fails every subject that is checked at all.
  ["start the timer", "always", [], false, "subject must be "],
  ["2fa support", "always", [], true, null],
];

/** @commitlint/rules's own normalization of a configured value, for the table above. */
function checksOf(value: string | readonly (string | { when: string; case: string })[]): CaseCheck[] {
  return (typeof value === "string" ? [value] : value).map((entry): CaseCheck =>
    typeof entry === "string" ? { when: "always", case: entry as CaseName } : { when: entry.when === "never" ? "never" : "always", case: entry.case as CaseName },
  );
}

describe("toCase -- @commitlint/ensure's transforms, recorded from 21.2.3", () => {
  for (const [input, expected] of TO_CASE) {
    it(`transforms ${JSON.stringify(input)} as commitlint does, in every case`, () => {
      for (const family of FAMILIES) expect(toCase(input, family), family).toBe(expected[family]);
    });
  }

  it("answers the legacy aliases exactly as the names they alias", () => {
    for (const input of ["Start the timer", "start the timer", "FOO BAR"]) {
      expect(toCase(input, "uppercase")).toBe(toCase(input, "upper-case"));
      expect(toCase(input, "sentencecase")).toBe(toCase(input, "sentence-case"));
      expect(toCase(input, "lowercase")).toBe(toCase(input, "lower-case"));
      expect(toCase(input, "lowerCase")).toBe(toCase(input, "lower-case"));
    }
  });
});

describe("ensureCase -- quoted spans dropped, empty and digit-leading pass, recorded from 21.2.3", () => {
  for (const [input, expected] of ENSURE) {
    it(`judges ${JSON.stringify(input)} as commitlint does, in every case`, () => {
      for (const family of FAMILIES) expect(ensureCase(input, family), family).toBe(expected[family]);
    });
  }
});

describe("subjectCaseVerdict -- @commitlint/rules's subject-case, recorded from 21.2.3", () => {
  for (const [subject, when, value, valid, message] of RULE) {
    it(`${JSON.stringify(subject)} under [${when}, ${JSON.stringify(value)}] is ${valid ? "valid" : "refused"}`, () => {
      const verdict = subjectCaseVerdict(subject, when, checksOf(value));
      expect(verdict.valid).toBe(valid);
      expect(verdict.message).toBe(message);
    });
  }

  it("reports the matched cases for `never` and every listed case for `always`", () => {
    expect(subjectCaseVerdict("ADD THING", "never", checksOf(CONVENTIONAL)).reported).toEqual(["sentence-case", "start-case", "upper-case"]);
    expect(subjectCaseVerdict("Start", "always", checksOf(["lower-case", "camel-case"])).reported).toEqual(["lower-case", "camel-case"]);
    expect(subjectCaseVerdict("start", "always", checksOf(["lower-case"])).reported).toEqual([]);
  });
});

describe("the building blocks", () => {
  it("knows exactly the case names to-case accepts", () => {
    expect(CASE_NAMES).toHaveLength(12);
    for (const name of CASE_NAMES) expect(isCaseName(name)).toBe(true);
    for (const name of ["shouty-case", "Sentence-Case", "", 2, null, undefined]) expect(isCaseName(name)).toBe(false);
  });

  it("splits words as es-toolkit 1.52.0 does, dropping the separators", () => {
    expect(words("HTTPRequest handler")).toEqual(["HTTP", "Request", "handler"]);
    expect(words("foo_bar-baz qux")).toEqual(["foo", "bar", "baz", "qux"]);
    expect(words("")).toEqual([]);
    expect(words("--__--")).toEqual([]);
  });

  it("deburrs the mapped letters and drops every combining-mark block", () => {
    expect(deburr("Æthelred Øre ß")).toBe("Aethelred Ore ss");
    expect(deburr("crème brûlée")).toBe("creme brulee");
    expect(deburr("a⃐b︠c")).toBe("abc");
  });
});
