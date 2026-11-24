import type { Desk, DeskRow } from "./register.js";

type DeskDocument = Omit<Desk, "rows" | "spendNotes"> & { rows: Record<string, DeskRow>; spendNotes: Record<string, string> };

/** A judgement-only starter: no fabricated readiness, object identity or ledger data. */
export function deskStarter(row?: string): DeskDocument {
  return {
    variant: "register", title: "My report", scope: "Describe this report's scope", gate: "G4",
    generatedAtLocal: "", footerNote: "Starter document: replace the example judgement before sharing.", architectureCaption: "",
    gates: [{ gate: "G4", label: "Review", cleared: "", asks: [{
      kind: "DO", rank: 1, title: "Prepare this report", why: "Replace this example with the decision or action needed.", pr: null,
      options: [{ letter: "A", label: "Prepare the report", command: "", consequence: "The report reflects the current work.", star: true }],
      objects: [{ label: "This desk", url: "#desk" }],
    }] }],
    rows: row === undefined ? {} : { [row]: { marks: "", gate: "", gateClass: "", needs: "", session: "", lane: "", thought: "" } }, legendRows: [{ mark: "", meaning: "Add the marks used by this report." }], efforts: [], spendNotes: {},
  };
}
