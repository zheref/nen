import { describe, expect, it } from "vitest";
import { parseCallerToken, VerbUsageError } from "./command.js";

class DomainRefusal extends Error {}

describe("parseCallerToken (zheref/nen#10 item 3)", () => {
  it("returns the parsed value untouched when the parse succeeds", () => {
    expect(parseCallerToken((): number => 42, (): boolean => true)).toBe(42);
  });

  it("converts the domain parser's refusal to a VerbUsageError -- exit 2 -- with the message whole", () => {
    expect(() =>
      parseCallerToken(
        (): never => {
          throw new DomainRefusal("the form is <CODE>-<IS|PR>-#<N>");
        },
        (error): boolean => error instanceof DomainRefusal,
      ),
    ).toThrow(VerbUsageError);

    try {
      parseCallerToken(
        (): never => {
          throw new DomainRefusal("the form is <CODE>-<IS|PR>-#<N>");
        },
        (error): boolean => error instanceof DomainRefusal,
      );
      expect.unreachable("the refusal must propagate");
    } catch (error) {
      // NOT re-worded and NOT prefixed: the parser's own message is the half
      // that tells the caller what to type instead.
      expect((error as Error).message).toBe("the form is <CODE>-<IS|PR>-#<N>");
    }
  });

  it("RE-THROWS anything the predicate does not claim, so a bug is never relabelled a typo", () => {
    // The direction that matters: converting indiscriminately would report a
    // genuine failure (exit 1) as a usage error (exit 2), and a retry wrapper
    // honouring the codes would stop retrying something worth retrying.
    const bug = new TypeError("undefined is not a function");
    let thrown: unknown = null;
    try {
      parseCallerToken(
        (): never => {
          throw bug;
        },
        (error): boolean => error instanceof DomainRefusal,
      );
    } catch (error) {
      thrown = error;
    }
    // IDENTITY, not just the message: `toThrow(bug)` alone compares message
    // text, so a version that wrapped every error in a VerbUsageError carrying
    // the same text would pass it.
    expect(thrown).toBe(bug);
    expect(thrown).not.toBeInstanceOf(VerbUsageError);
  });
});
