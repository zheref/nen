Copies of Hatsu's issue-section catalogue (`contracts/issue-sections.json`,
`hatsu.issue-sections/v1`) and its five issue templates
(`templates/issue-body/*.md`), taken from zheref/hatsu's
`delivery/sdd-plan-2026-10-22` at 3ae2ef8e. `src/issue/hatsu-catalogue.test.ts`
runs `nen issue body-check` over them so the consumer's real catalogue shape
is held by a test (delivery round on zheref/nen#498, reading 1).
