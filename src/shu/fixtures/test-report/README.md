# `src/shu/fixtures/test-report/` — the report files `nen shu test-report` parses

Not marker trees. Nothing detects anything about these: they are read as text and
handed to a parser, exactly as `../coverage/` is. They are **test data, not
shipped code** — nothing under a `fixtures/` directory is linted, type-checked or
swept by `src/shu/purity.test.ts`, which is what lets them state concrete runner
vocabulary.

**Every happy fixture states the same suite: 5 tests — 3 passed, 1 failed, 1
skipped.** That is deliberate and it is the whole point of having three of them:
the three formats disagree about every spelling and about nothing else, so a
parser that read one of them wrong produces a total that differs from its two
siblings' rather than a plausible number nobody checks.

| file | what it proves |
|---|---|
| `junit-suites.xml` | the `<testsuites>` wrapper: two suites, `classname` on every case, `<failure>` and `<skipped>` children, and `time` in **seconds** (so `0.012` is `12.00ms`). Its `tests=`/`failures=` attributes are stated and deliberately **not read** — the rows are what nen counts |
| `junit-single.xml` | one `<testsuite>` root with **no `classname` anywhere**, so the suite has to come off the enclosing tag; an `<error>` (which is a failure, not a third status); a `<system-out>` child that must be ignored rather than refused; and one case carrying **both** a `<skipped>` and a `<failure>`, where the worse of the two has to win whichever order they are written in |
| `junit-empty.xml` | a run that matched nothing: zero rows, zero counts, and **not** a refusal — an empty report is a report about no tests |
| `junit-unnamed.xml` | a `<testcase>` with no `name`. A row nobody can look up is not a finding, so the file is refused by name rather than counted |
| `junit-not-a-report.xml` | XML that is not a test report. It matters most inside a **directory** artifact, where every `*.xml` is read: one file nen does not recognise refuses the whole read rather than being skipped past |
| `assertion-results.json` | the `testResults[].assertionResults[]` shape: two test **files** (the suites) with five assertions between them, `duration` in **milliseconds** (`12.345` → `12.35`, the two-decimal rule), a `pending` that is a skip, and one row carrying only `title` where `fullName` is the field nen prefers. Its file names are **absolute** — which is why the verb relativises them |
| `assertion-results-empty.json` | `{"testResults": []}` — a run that matched no test file. It still claims the format: sending it to "no format nen reads" would refuse a document that honestly contains a zero |
| `assertion-results-nameless.json` | an assertion with neither `fullName` nor `title` |
| `assertion-results-unknown-status.json` | a status word nen has not met. Refused rather than guessed at: guessing wrong in one direction makes a red suite look green |
| `not-json.json` | a `.json` artifact that is not JSON at all. The name is a hint and the content decides, so this reaches the "no format nen reads" refusal rather than a parser's |
| `xcresult-summary.json` | the summary a **declared** result-bundle extraction step writes: the four counts stated, and only the failures listed. `tests.length` is 1 under a `total` of 5, which is the one case where those two numbers legitimately differ |
| `xcresult-nodes.json` | the same summary carrying the per-test list beside it: the tree walked to its `Test Case` leaves, the **innermost** enclosing name used as the suite, a case hanging directly off the bundle (which then names it), an `Expected Failure` that is a **pass**, and durations written as `0.012s` and `1m 3s` — units in the string, because `Number("1m 3s")` is `NaN` |
| `xcresult-impossible.json` | 4 passed + 2 failed + 1 skipped out of 5. More tests accounted for than it says it ran: refused, never summed |
| `xcresult-malformed.json` | a count that is a string. nen reports what a report states and never coerces one |
