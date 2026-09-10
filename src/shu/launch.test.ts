// src/shu/launch.test.ts -- the pure half of a launch: reading a device's id
// out of whatever its declared probe printed, and filling the two tokens an
// after-step may name.
//
// EVERY FIXTURE HERE IS INVENTED OUTPUT, not a real tool's, and deliberately:
// the module under test knows no tool, so a test that pasted one program's real
// document would be testing that program's schema rather than the two SHAPES
// this file actually reads. What the fixtures reproduce is the shapes -- flat
// JSON, JSON whose name and id are cousins rather than siblings, and plain
// tabular lines -- each with the same placeholder vocabulary the shu fixtures
// use everywhere else.

import { describe, expect, it } from "vitest";
import type { DeviceReadiness } from "../schema/contract.js";
import {
  ARTIFACT_TOKEN,
  DEVICE_ID_TOKEN,
  artifactAsSeenFrom,
  findDevice,
  LAUNCH_PLACEHOLDERS,
  substituteSteps,
  tokensUsed,
  usesToken,
} from "./launch.js";
import { REFUSED_PLACEHOLDERS } from "./render.js";

describe("findDevice, over JSON output", () => {
  it("reads an id sitting beside the name", () => {
    const out = JSON.stringify({
      devices: [
        { name: "Placeholder A", udid: "AAAA-1111" },
        { name: "Placeholder B", udid: "BBBB-2222" },
      ],
    });
    expect(findDevice("Placeholder B", out)).toEqual({
      found: true,
      id: "BBBB-2222",
      ambiguous: [],
      readiness: null,
      saw: ["Placeholder A", "Placeholder B"],
      sawKind: "names",
    });
  });

  it("reads an id that is a COUSIN of the name, one object over", () => {
    // THE SHAPE THE LARGER TOOLCHAINS PRINT: the name lives in one sub-object
    // and the id in its sibling, so the two are never siblings themselves. A
    // reader that only looked beside the name would answer "no id" about a
    // document that plainly carries one.
    const out = JSON.stringify({
      result: {
        devices: [
          {
            deviceProperties: { name: "Placeholder Handset Pro" },
            hardwareProperties: { udid: "0000-8030-1234" },
          },
        ],
      },
    });
    expect(findDevice("Placeholder Handset Pro", out).id).toBe("0000-8030-1234");
  });

  it("prefers the earlier id key when an object carries several", () => {
    // The order is `identifier, id, udid, serial` and it is a decision rather
    // than an accident: a document offering two is a document nen must read the
    // same way twice.
    const out = JSON.stringify([{ name: "Placeholder A", serial: "S-9", identifier: "I-9" }]);
    expect(findDevice("Placeholder A", out).id).toBe("I-9");
  });

  it("renders a NUMERIC id rather than refusing it", () => {
    expect(findDevice("Placeholder A", JSON.stringify([{ name: "Placeholder A", id: 17 }])).id).toBe("17");
  });

  it("says 'found, no id' rather than 'no such device' when the name is there", () => {
    // THE THIRD OUTCOME. Telling this reader "it is not among the devices the
    // probe saw" would be nen contradicting output on their own screen.
    const lookup = findDevice("Placeholder A", JSON.stringify([{ name: "Placeholder A", model: "x" }]));
    expect(lookup.found).toBe(true);
    expect(lookup.id).toBeNull();
  });

  it("does not take a DIFFERENT device's id from further up the document", () => {
    // The bound on how far outward the search goes is what this pins: an id
    // sitting on the response envelope belongs to the envelope, not to a device
    // three levels below it.
    const out = JSON.stringify({
      udid: "THE-WRONG-ONE",
      page: { of: { results: { devices: [{ profile: { name: "Placeholder A" } }] } } },
    });
    expect(findDevice("Placeholder A", out).id).toBeNull();
  });

  it("lists the names it DID see when the device is absent", () => {
    const out = JSON.stringify([{ name: "Placeholder B" }, { name: "Placeholder A" }]);
    expect(findDevice("Placeholder Z", out)).toEqual({
      found: false,
      id: null,
      ambiguous: [],
      readiness: null,
      saw: ["Placeholder A", "Placeholder B"],
      sawKind: "names",
    });
  });

  it("matches a name EXACTLY -- never a prefix, never a case fold", () => {
    const out = JSON.stringify([{ name: "Placeholder A Pro", udid: "U-1" }]);
    expect(findDevice("Placeholder A", out).found).toBe(false);
    expect(findDevice("placeholder a pro", out).found).toBe(false);
  });

  it("matches a name's typographic apostrophe EXACTLY -- U+2019, never U+0027", () => {
    // macOS names a paired phone with ITS OWN curly apostrophe -- the same
    // character autocorrect writes for a possessive, U+2019 RIGHT SINGLE
    // QUOTATION MARK ("Sergio’s iPhone") -- never the straight U+0027 a
    // keyboard's apostrophe key types. `findDevice` performs no Unicode
    // normalisation anywhere in this file: `===` compares UTF-16 code units,
    // so two characters that look identical on screen but carry different
    // code points are two different strings to it, exactly as a name typed
    // in the wrong CASE already is (the test above). A declaration written
    // with the wrong apostrophe gets the SAME refusal as any other unmatched
    // name -- "the phone is asleep or you renamed it" -- never a silent
    // match a reader's eye could not have told apart on screen.
    const curly = "Sergio’s iPhone";
    const straight = "Sergio's iPhone";
    expect(curly).not.toBe(straight); // the fixture states two DIFFERENT strings
    const out = JSON.stringify([{ name: curly, udid: "U-1" }]);
    expect(findDevice(curly, out)).toMatchObject({ found: true, id: "U-1" });
    expect(findDevice(straight, out).found).toBe(false);
  });
});

describe("findDevice, over plain output", () => {
  const TABLE = [
    "List of attached devices",
    "PH1234567890   device  usb:1-2 model:Placeholder_A",
    "Placeholder Handset Pro (0000-8030-1234) (connected)",
    "Placeholder Bench 2 (offline)",
  ].join("\n");

  it("takes the first id-shaped token on the device's own line", () => {
    expect(findDevice("Placeholder Handset Pro", TABLE).id).toBe("0000-8030-1234");
  });

  it("skips a status word: an id carries a digit", () => {
    // `connected` is longer than six characters and would be read as an id by a
    // rule that only measured length.
    expect(findDevice("Placeholder Handset Pro", TABLE).id).not.toBe("connected");
  });

  it("never answers with a word of the device's own name", () => {
    expect(findDevice("Placeholder_A", TABLE).id).toBe("PH1234567890");
  });

  it("says 'found, no id' when the line offers nothing id-shaped", () => {
    const lookup = findDevice("Placeholder Bench 2", TABLE);
    expect(lookup.found).toBe(true);
    expect(lookup.id).toBeNull();
  });

  it("lists the LINES it printed when the name is absent", () => {
    const lookup = findDevice("Placeholder Z", TABLE);
    expect(lookup).toEqual({
      found: false,
      id: null,
      ambiguous: [],
      readiness: null,
      saw: [
        "List of attached devices",
        "PH1234567890   device  usb:1-2 model:Placeholder_A",
        "Placeholder Handset Pro (0000-8030-1234) (connected)",
        "Placeholder Bench 2 (offline)",
      ],
      sawKind: "lines",
    });
  });

  it("reads CRLF output as lines, not as one line with returns in it", () => {
    const crlf = "Placeholder A (AAAA-1111)\r\nPlaceholder B (BBBB-2222)\r\n";
    expect(findDevice("Placeholder B", crlf).id).toBe("BBBB-2222");
  });

  it("treats a JSON SCALAR as text, because a scalar is not a document", () => {
    expect(findDevice("x", '"just a string"').sawKind).toBe("lines");
  });

  it("reports an empty probe as having printed nothing", () => {
    expect(findDevice("Placeholder A", "")).toEqual({
      found: false,
      id: null,
      ambiguous: [],
      readiness: null,
      saw: [],
      sawKind: "lines",
    });
  });
});

describe("the two tokens this family fills in", () => {
  const STEPS = [
    { exe: "placeholder-installer", argv: ["install", "--device={device.id}", "{artifact}"] },
    { exe: "placeholder-launcher", argv: ["open", "--device", "{device.id}"] },
  ];

  it("finds them inside a longer argument, not only as a whole one", () => {
    expect(usesToken(STEPS, DEVICE_ID_TOKEN)).toBe(true);
    expect(tokensUsed(STEPS)).toEqual([DEVICE_ID_TOKEN, ARTIFACT_TOKEN]);
    expect(tokensUsed([{ exe: "x", argv: ["--plain"] }])).toEqual([]);
  });

  it("substitutes everywhere the token appears, and splits no argument in two", () => {
    const filled = substituteSteps(STEPS, { deviceId: "an id with spaces", artifact: "build/app" });
    expect(filled[0]?.argv).toEqual(["install", "--device=an id with spaces", "build/app"]);
    expect(filled[1]?.argv).toEqual(["open", "--device", "an id with spaces"]);
  });

  it("leaves a token whose value is null exactly as written -- the dry run's case", () => {
    const filled = substituteSteps(STEPS, { deviceId: null, artifact: "build/app" });
    expect(filled[0]?.argv).toEqual(["install", "--device={device.id}", "build/app"]);
  });

  it("shares no token with the reference pack's REFUSED set", () => {
    // A token in both would be refused by one rule and substituted by the
    // other, and which won would depend on the order two functions are called.
    const overlap = LAUNCH_PLACEHOLDERS.filter((token): boolean =>
      REFUSED_PLACEHOLDERS.includes(token),
    );
    expect(overlap).toEqual([]);
  });
});

describe("two candidates for one name: nen picks neither", () => {
  // THE FAILURE A SUBSTRING MATCH MAKES POSSIBLE, and the one Copilot's review
  // of #143 named: plain output has no field boundaries, so a declared name
  // that is the BEGINNING of a longer one is carried by both rows. Taking the
  // first would put the build on somebody else's device and report success.
  const TWO = [
    "Placeholder Handset      PH-0001  connected",
    "Placeholder Handset Pro  PH-0002  connected",
  ].join("\n");

  it("refuses a plain-text name that two id-bearing lines carry", () => {
    const lookup = findDevice("Placeholder Handset", TWO);
    expect(lookup.found).toBe(true);
    expect(lookup.id).toBeNull();
    expect(lookup.ambiguous).toEqual([
      "Placeholder Handset      PH-0001  connected",
      "Placeholder Handset Pro  PH-0002  connected",
    ]);
  });

  it("resolves the longer name, which only its own line carries", () => {
    expect(findDevice("Placeholder Handset Pro", TWO).id).toBe("PH-0002");
  });

  it("is not confused by a summary line that names the device and offers no id", () => {
    // A probe that prints a heading above its table carries the name twice and
    // means one device. Only the row offers an id, so there is one candidate.
    const withHeading = ["Found 1: Placeholder Handset", "Placeholder Handset  PH-0001"].join("\n");
    expect(findDevice("Placeholder Handset", withHeading).id).toBe("PH-0001");
  });

  it("refuses two JSON objects that share a name and disagree about the id", () => {
    const out = JSON.stringify([
      { name: "Placeholder A", udid: "AAAA-1" },
      { name: "Placeholder A", udid: "AAAA-2" },
    ]);
    const lookup = findDevice("Placeholder A", out);
    expect(lookup.found).toBe(true);
    expect(lookup.id).toBeNull();
    expect(lookup.ambiguous).toEqual(["AAAA-1", "AAAA-2"]);
  });

  it("is NOT ambiguous when the same device is described twice with one id", () => {
    const out = JSON.stringify([
      { name: "Placeholder A", udid: "AAAA-1" },
      { name: "Placeholder A", udid: "AAAA-1" },
    ]);
    expect(findDevice("Placeholder A", out).id).toBe("AAAA-1");
  });
});

// ── readiness: the state beside the name, which the name cannot carry ───────
//
// A DEVICE LIST IS NOT A LIST OF USABLE DEVICES. The same row that says a
// handset is attached also says whether its pairing prompt was answered, and
// matching the name answers only the first of those. These fixtures reproduce
// the two SHAPES a state arrives in -- a column on a line, a key on an object --
// with the same invented vocabulary the rest of this file uses. This module
// COMPARES nothing: what it reports is the word the probe printed, and
// ../shu/run.ts is where that word is held against the accepted set.

/** A plain-line readiness rule, as ../schema/contract.ts parses one. */
function byField(field: number, accepted: readonly string[] = ["ready"]): DeviceReadiness {
  return { field, path: null, in: accepted, raw: {} };
}

/** A JSON readiness rule, as ../schema/contract.ts parses one. */
function byPath(path: string, accepted: readonly string[] = ["ready"]): DeviceReadiness {
  return { field: null, path, in: accepted, raw: {} };
}

describe("findDevice reads a device's STATE where the declaration says it is", () => {
  const ROWS = [
    "PH0000000001   unpaired",
    "PH0000000002   ready      usb:1-2",
  ].join("\n");

  it("counts fields FROM ONE, the way a reader counts columns on their screen", () => {
    // Field 1 is the serial the declaration matched on; field 2 is the state.
    expect(findDevice("PH0000000002", ROWS, byField(1)).readiness).toBe("PH0000000002");
    expect(findDevice("PH0000000002", ROWS, byField(2)).readiness).toBe("ready");
    expect(findDevice("PH0000000002", ROWS, byField(3)).readiness).toBe("usb:1-2");
  });

  it("reads the state off a row that offers NO id at all", () => {
    // THE CASE THE WHOLE KEY EXISTS FOR. A device whose state is the reason it
    // is unusable routinely prints a row with nothing id-shaped on it, and
    // "the probe gave nen no id" is the true sentence that helps least.
    const lookup = findDevice("PH0000000001", ROWS, byField(2));
    expect(lookup.found).toBe(true);
    expect(lookup.id).toBeNull();
    expect(lookup.readiness).toBe("unpaired");
  });

  it("answers null for a field the row does not reach", () => {
    expect(findDevice("PH0000000001", ROWS, byField(9)).readiness).toBeNull();
  });

  it("answers null for a rule written for the OTHER shape", () => {
    // A `path` against plain lines reads nothing rather than guessing at one;
    // ../shu/run.ts refuses with the rule quoted, which is the whole diagnosis.
    expect(findDevice("PH0000000002", ROWS, byPath("state")).readiness).toBeNull();
  });

  it("changes nothing at all when no rule is declared", () => {
    expect(findDevice("PH0000000002", ROWS).readiness).toBeNull();
    // The id is unchanged too -- the first token on the row that is not one of
    // the name's own words and carries a digit, exactly as it always was.
    expect(findDevice("PH0000000002", ROWS).id).toBe("usb:1-2");
  });

  it("reads a key off the matched JSON object, dotted for a nested one", () => {
    const out = JSON.stringify([
      { name: "Placeholder A", udid: "U-1", connection: { state: "ready" } },
    ]);
    expect(findDevice("Placeholder A", out, byPath("connection.state")).readiness).toBe("ready");
    expect(findDevice("Placeholder A", out, byPath("state")).readiness).toBeNull();
  });

  it("reads it off an ENCLOSING object when the matched one is only the name", () => {
    // The cousin shape: the name in one sub-object, everything else in its
    // sibling. The state walks exactly as far as the id already does.
    const out = JSON.stringify({
      result: {
        devices: [
          {
            deviceProperties: { name: "Placeholder Handset Pro" },
            hardwareProperties: { udid: "0000-8030-1234" },
            connectionProperties: { tunnelState: "connected" },
          },
        ],
      },
    });
    const rule = byPath("connectionProperties.tunnelState", ["connected"]);
    expect(findDevice("Placeholder Handset Pro", out, rule).readiness).toBe("connected");
  });

  it("renders a boolean or a number rather than reading nothing", () => {
    const flags = JSON.stringify([{ name: "Placeholder A", udid: "U-1", usable: true, tier: 3 }]);
    expect(findDevice("Placeholder A", flags, byPath("usable", ["true"])).readiness).toBe("true");
    expect(findDevice("Placeholder A", flags, byPath("tier", ["3"])).readiness).toBe("3");
  });

  it("reads nothing from an OBJECT at the end of the path", () => {
    // Comparing `[object Object]` against a word would refuse every device
    // forever while looking exactly like a rule that was working.
    const out = JSON.stringify([{ name: "Placeholder A", udid: "U-1", state: { code: 2 } }]);
    expect(findDevice("Placeholder A", out, byPath("state")).readiness).toBeNull();
  });

  it("reports NO state when the name matched two rows, in either shape", () => {
    // Two candidates are two rows, so "this device's state" names two values
    // and nen reports neither -- the ambiguity is the refusal in any case.
    const two = ["Placeholder Handset      PH-0001  ready", "Placeholder Handset Pro  PH-0002  ready"].join("\n");
    expect(findDevice("Placeholder Handset", two, byField(3)).readiness).toBeNull();
    const json = JSON.stringify([
      { name: "Placeholder A", udid: "AAAA-1", state: "ready" },
      { name: "Placeholder A", udid: "AAAA-2", state: "ready" },
    ]);
    expect(findDevice("Placeholder A", json, byPath("state")).readiness).toBeNull();
  });
});

// ── {artifact}, seen from where the after-steps actually stand ──────────────

describe("artifactAsSeenFrom: two roots, one file", () => {
  it("returns the declared string UNCHANGED for a lane at the repository root", () => {
    // THE COMPATIBILITY PROMISE, and the reason the rebasing is relative rather
    // than absolute: nearly every lane sits here, and every one of them passes
    // exactly the bytes it always did.
    expect(artifactAsSeenFrom(".", "build/App.app")).toBe("build/App.app");
    expect(artifactAsSeenFrom("", "build/App.app")).toBe("build/App.app");
  });

  it("climbs out of a lane one directory down", () => {
    expect(artifactAsSeenFrom("native", "build/App.app")).toBe("../build/App.app");
    expect(artifactAsSeenFrom("apps/web", "build/App.app")).toBe("../../build/App.app");
  });

  it("stays inside the lane when the artifact is under it", () => {
    expect(artifactAsSeenFrom("native", "native/build/App.app")).toBe("build/App.app");
  });

  it("answers '.' rather than an empty argument for an artifact AT the cwd", () => {
    // An empty string would turn `install <path>` into `install`, which is the
    // failure `project.launch.<name>.artifact`'s own empty-string refusal names.
    expect(artifactAsSeenFrom("native", "native")).toBe(".");
  });

  it("answers with forward slashes whatever the declaration or the host use", () => {
    // The same lane must render identically on all three platforms this
    // project's CI runs, and a backslash is not a separator a declaration writes.
    expect(artifactAsSeenFrom("native\\deep", "build/App.app")).toBe("../../build/App.app");
    expect(artifactAsSeenFrom("./native/", "./build/App.app")).toBe("../build/App.app");
  });
});
