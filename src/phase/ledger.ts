// src/phase/ledger.ts -- the phase ledger's two constants, in a module with no
// command in it, so the report assembler can read the directory without
// importing a verb (review finding on zheref/nen#216).
export const PHASE_LEDGER_DIR = ".nen/phases";
export const PHASE_CONTRACT = "nen.phase.ledger/v0.1";
