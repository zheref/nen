# `src/shu/fixtures/coverage/`

Report fixtures for `nen shu coverage`'s five parsers. **Test data, not shipped
code**: eslint, the taxonomy sweep and `src/shu/purity.test.ts` all skip
`fixtures/`, which is why these files may name real tools and reproduce real
report layouts.

**Every happy fixture states the same coverage**, deliberately: **14 of 17 lines
(82.35%)** and, where the format measures them, **3 of 4 branches (75%)**, split
into two rows of 11/13 and 3/4. Five formats disagree about everything else, and
`src/shu/coverage.test.ts` asserts they land on one shape — which is the whole
claim this verb makes.

| file | format | what it is for |
| --- | --- | --- |
| `coverage-summary.json` | Istanbul JSON summary | happy path; per-file rows, one of them with no branch block |
| `empty-coverage-summary.json` | " | a report about no code: `pct: 100` in the file, `percent: null` in nen's answer |
| `malformed-coverage-summary.json` | " | truncated JSON |
| `xccov-report.json` | xccov JSON report | happy path; per-target rows, no branch figure anywhere |
| `xccov-empty.json` | " | no targets, zero lines |
| `xccov-malformed.json` | " | a target row with no `name` |
| `coverage.cobertura.xml` | Cobertura XML | happy path; **the class-level line list is repeated under `<method>`**, which is the double-count trap |
| `empty.cobertura.xml` | " | `lines-valid="0"`, no packages |
| `malformed.cobertura.xml` | " | a `<coverage>` root stating no line figure at all |
| `jacocoTestReport.xml` | JaCoCo XML | happy path; counters at four nesting levels, only two of which are read |
| `jacoco-empty.xml` | " | a report-level `LINE` counter at 0/0 |
| `jacoco-malformed.xml` | " | package counters only — no report-level `LINE` |
| `lcov.info` | LCOV tracefile | happy path; `LF`/`LH` summaries beside `DA`/`BRDA` entries |
| `empty.info` | " | one record, no lines |
| `malformed.info` | " | `SF:` with no `end_of_record` |
| `notes.md` | — | not a coverage report in any format: the detection refusal |

The names are not decoration either — `src/shu/coverage/parse.ts` chooses a
parser by file name first and confirms it against the bytes, so each fixture is
named the way the tool that writes it names its output.
