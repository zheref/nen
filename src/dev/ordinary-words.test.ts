// The ordinary-word list is pinned and derived, never edited (zheref/nen#535;
// Feitan F5 and Nobunaga N3 on NN-PR-#541): a word added by hand changes a pin
// here, in a reviewable diff, or turns the drift test red.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import data from "../issue/ordinary-words.json";
import { ORDINARY_WORD_COUNT } from "../issue/ordinary-words.js";
import {
  COPYRIGHT_PATH,
  JSON_PATH,
  SCOWL_SHA256,
  deriveOrdinaryWords,
  ordinaryWordsMain,
  renderOrdinaryWordsDoc,
  wordsSha256,
} from "./ordinary-words.js";

/** THE PINS. Moving either is a change to what the guard polices; say why in the PR. */
const PINNED_COUNT = 10737;
const PINNED_WORDS_SHA256 = "01157d10337846c1957243c07e5ab11386729b1664e42c8483477db199eed949";

const read = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

describe("the ordinary-word list (zheref/nen#535)", () => {
  it("count, the JSON's own count, the loaded set and the pin agree", () => {
    expect(data.words).toHaveLength(PINNED_COUNT);
    expect(data.count).toBe(PINNED_COUNT);
    expect(ORDINARY_WORD_COUNT).toBe(PINNED_COUNT);
  });

  it("the words' sha256, the JSON's own wordsSha256 and the pin agree", () => {
    expect(wordsSha256(data.words)).toBe(PINNED_WORDS_SHA256);
    expect(data.wordsSha256).toBe(PINNED_WORDS_SHA256);
    expect(data.tarballSha256).toBe(SCOWL_SHA256);
  });

  it("the committed file is exactly the render of its own words: no hand-edited header or order", () => {
    expect(read(JSON_PATH)).toBe(renderOrdinaryWordsDoc(data.words));
  });

  it("SCOWL's Copyright file is vendored beside it, the collective-work notice included", () => {
    const notice = read(COPYRIGHT_PATH);
    expect(data.copyrightFile).toBe(COPYRIGHT_PATH);
    expect(notice).toContain("The collective work is Copyright 2000-2018 by Kevin Atkinson");
    expect(notice).toMatch(/VarCon/);
    expect(notice).toMatch(/WordNet/);
  });

  it("derives: ASCII letters only, lowercased, deduplicated, bytewise sorted, calendar names only from upper.35", () => {
    const words = deriveOrdinaryWords({
      words10: "able\nabout\nability's\ncafé\n",
      words20: "zebra\nable\n",
      upper10: "English\nI\n",
      upper35: "Friday\nAfrican\nMarch\n",
    });
    expect(words).toEqual(["able", "about", "english", "friday", "i", "march", "zebra"]);
  });

  it("refuses a tarball whose sha256 is not the pinned one (1) and a call with no tarball (2), deriving nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-ow-test-"));
    try {
      const fake = join(dir, "scowl.tar.gz");
      writeFileSync(fake, "not the tarball");
      expect(ordinaryWordsMain(["--tarball", fake], dir)).toBe(1);
      expect(ordinaryWordsMain([], dir)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
