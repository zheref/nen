### Added

- `pr body-check --exact [--max <n>]` refuses undeclared, repeated, ambiguous or
  out-of-order level-2 headings outside comments and fences, with line findings.
  `--prose-budget <words>` warns on excessive prose without changing the verdict.
- `pr sections resolve` reads caller-owned section catalogues, conditional facts
  and workflow overrides; `pr sections family` folds taxonomy jobs by count and
  declared precedence. JSON uses `nen.pr.sections/v0.1` (zheref/nen#448).
