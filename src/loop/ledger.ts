// src/loop/ledger.ts -- the izanagi cap, enforced ACROSS a loop rather than
// parsed once at its start (zheref/nen#47).
//
// THE GAP THIS CLOSES. `nen parse izanagi` refuses an invocation with no
// `up to <N>`, which makes the cap's PRESENCE AND SHAPE nen's business -- and
// then the parser never sees iteration 2. `nen watch until --max-iterations` is
// a different bound on a different loop: izanami's, which is read-only and can
// compound no mistake, and whose own `--help` says so. So the count of how many
// times the MUTATING task had actually run lived entirely in the calling skill's
// prose, exactly as it did before any of this was ported, with no nen-side
// backstop against a caller that miscounts and exceeds the cap it was given.
//
// WHY A LEDGER AND NOT A LOOP. nen is a stateless CLI invoked once per step; the
// loop belongs to the caller and always will. What nen can own is the COUNT --
// a fact that outlives one invocation, written down where the next invocation
// can read it. So the caller claims each iteration before performing it, and the
// cap is enforced by the claim being REFUSED rather than by anyone remembering.
//
// THE LINE IS RESTATED ON EVERY CLAIM, and that is the safety property rather
// than ceremony. A cap a caller can raise by re-typing the invocation with a
// bigger N is not a cap; it is a suggestion with extra steps. So a claim whose
// line differs from the recorded one is REFUSED, naming both -- which also
// catches the honest version of the same mistake, a second loop reusing an id
// that already belongs to a different task.

export const LOOP_LEDGER_CONTRACT = "nen.loop.iterate/v0.1";

export interface LoopLedger {
  readonly contract: string;
  readonly id: string;
  /** The invocation line, verbatim, exactly as the caller restates it. */
  readonly line: string;
  readonly task: string;
  readonly condition: string;
  readonly cap: number;
  /** How many iterations have been CLAIMED. Never how many succeeded. */
  readonly iterations: number;
  readonly startedAt: string;
  readonly lastAt: string;
  /** True once the loop has ended -- condition met, or a gate ended it. */
  readonly released: boolean;
  /** The caller's own word for why it ended; `null` while running. */
  readonly releaseReason: string | null;
}

export interface ClaimRefusal {
  readonly kind: "usage" | "cap";
  readonly message: string;
}

export type ClaimResult =
  | { readonly ok: true; readonly ledger: LoopLedger; readonly released: boolean }
  | { readonly ok: false; readonly error: ClaimRefusal };

export interface ClaimInput {
  readonly id: string;
  readonly line: string;
  readonly task: string;
  readonly condition: string;
  readonly cap: number;
  readonly now: string;
  /** End the loop instead of claiming an iteration. */
  readonly release: string | null;
}

/**
 * The whole decision, over the ledger as it stands and the claim being made.
 *
 * PURE: no filesystem, no clock, no argv. The caller reads the file, calls this,
 * and writes what comes back -- which is what makes every branch below testable
 * without a temp directory, including the two that must never be reachable by
 * accident (raising a cap mid-loop, and re-entering a released loop).
 */
export function claimIteration(existing: LoopLedger | null, input: ClaimInput): ClaimResult {
  if (existing === null) {
    if (input.release !== null) {
      return {
        ok: false,
        error: {
          kind: "usage",
          // Releasing a loop that was never begun is not a no-op worth being
          // quiet about: the caller believes it is ending something, and the
          // thing it believes in does not exist. Almost always a mistyped id.
          message: `no loop '${input.id}' has been begun under this repository, so there is nothing to release. A loop begins on its FIRST 'loop iterate' claim; check the --id, or drop --release to begin one.`,
        },
      };
    }
    return {
      ok: true,
      released: false,
      ledger: {
        contract: LOOP_LEDGER_CONTRACT,
        id: input.id,
        line: input.line,
        task: input.task,
        condition: input.condition,
        cap: input.cap,
        iterations: 1,
        startedAt: input.now,
        lastAt: input.now,
        released: false,
        releaseReason: null,
      },
    };
  }

  // THE LINE MUST MATCH. Compared verbatim after the caller's own trim, because
  // any looser comparison is a rule about which EDITS to an invocation are
  // allowed, and the only honest answer to that is none: a loop whose task,
  // condition or cap changed is a different loop and gets a different id.
  if (existing.line !== input.line) {
    return {
      ok: false,
      error: {
        kind: "usage",
        message:
          `loop '${input.id}' is running a DIFFERENT invocation from the one claimed here, so this claim is refused rather than counted against it.\n` +
          `  running:  ${existing.line}\n` +
          `  claimed:  ${input.line}\n` +
          "A cap a caller can raise by re-typing the line with a bigger N is not a cap. If this is genuinely a new loop, give it its own --id; if the running one is finished, end it with --release <why> first.",
      },
    };
  }

  if (existing.released) {
    if (input.release !== null) {
      // Releasing twice is the caller saying the same true thing again. Nothing
      // changes and nothing is wrong, so it answers rather than refusing.
      return { ok: true, released: true, ledger: existing };
    }
    return {
      ok: false,
      error: {
        kind: "usage",
        message: `loop '${input.id}' was released at ${existing.lastAt}${existing.releaseReason === null ? "" : ` (${existing.releaseReason})`} and cannot claim another iteration. A released loop is finished; begin a new one under its own --id.`,
      },
    };
  }

  if (input.release !== null) {
    return {
      ok: true,
      released: true,
      ledger: { ...existing, lastAt: input.now, released: true, releaseReason: input.release },
    };
  }

  // THE CAP, ENFORCED. `>=` and not `>`: the cap is how many iterations the
  // caller agreed to, so the claim AFTER the last one is the refusal -- a loop
  // capped at 3 performs 3 iterations, never a fourth that discovers the bound.
  if (existing.iterations >= existing.cap) {
    return {
      ok: false,
      error: {
        kind: "cap",
        message:
          `loop '${input.id}' has claimed all ${existing.cap} iteration(s) its invocation allowed, so this claim is REFUSED.\n` +
          `  ${existing.line}\n` +
          "This is the cap doing its job, not a failure: izanagi's cap is grammar rather than a default precisely so that reaching it is a decision to bring back to a human, never a bound to raise and re-run. End the loop with --release <why>, and take what it reached to the gate.",
      },
    };
  }

  return {
    ok: true,
    released: false,
    ledger: { ...existing, iterations: existing.iterations + 1, lastAt: input.now },
  };
}

/**
 * A loop id as ONE path segment, or null when it is not one.
 *
 * REFUSED RATHER THAN SANITISED, unlike the bootstrap's cache key. A cache slot
 * is nen's own bookkeeping and a mangled one costs a re-download; a loop id is
 * the caller's own label for a loop that WRITES, and two ids mangled to the same
 * segment would silently share one cap between two loops -- the failure this
 * whole module exists to prevent, arriving through the door meant to prevent it.
 */
export function loopIdSegment(id: string): string | null {
  if (id === "" || id.length > 100) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return null;
  if (id.includes("..")) return null;
  return id;
}

/** Parse a stored ledger, or null when the file is not one this build wrote. */
export function parseLedger(value: unknown): LoopLedger | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record["contract"] !== LOOP_LEDGER_CONTRACT) return null;
  const text = (key: string): string | null =>
    typeof record[key] === "string" ? (record[key] as string) : null;
  const whole = (key: string): number | null =>
    typeof record[key] === "number" && Number.isInteger(record[key]) ? (record[key] as number) : null;
  const id = text("id");
  const line = text("line");
  const task = text("task");
  const condition = text("condition");
  const startedAt = text("startedAt");
  const lastAt = text("lastAt");
  const cap = whole("cap");
  const iterations = whole("iterations");
  if (id === null || line === null || task === null || condition === null) return null;
  if (startedAt === null || lastAt === null || cap === null || iterations === null) return null;
  if (typeof record["released"] !== "boolean") return null;
  const reason = record["releaseReason"];
  return {
    contract: LOOP_LEDGER_CONTRACT,
    id,
    line,
    task,
    condition,
    cap,
    iterations,
    startedAt,
    lastAt,
    released: record["released"],
    releaseReason: typeof reason === "string" ? reason : null,
  };
}
