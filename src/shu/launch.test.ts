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
import {
  ARTIFACT_TOKEN,
  DEVICE_ID_TOKEN,
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
      saw: ["Placeholder A", "Placeholder B"],
      sawKind: "names",
    });
  });

  it("matches a name EXACTLY -- never a prefix, never a case fold", () => {
    const out = JSON.stringify([{ name: "Placeholder A Pro", udid: "U-1" }]);
    expect(findDevice("Placeholder A", out).found).toBe(false);
    expect(findDevice("placeholder a pro", out).found).toBe(false);
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
