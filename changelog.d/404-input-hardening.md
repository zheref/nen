### Fixed

- **schema** — lane cwd paths share stdoutTo's repository-relative validation, including Windows absolute, drive-relative and traversal spellings on every host. Dependabot review exemptions name one anchored literal bot account rather than a catch-all or human-shaped regex.
- **pr** — threads settle scans every inline and file body before any GitHub call for GitHub/URL credentials, AWS access keys, Google API keys, Azure account keys, private-key headers and high-entropy tokens. Refusals name the shape and redact the value. A URL authority's numeric port followed by an @ in its path, query or fragment no longer reads as a password.
- **gates** — NEXT_RELEASE is derived as VERSION's next minor; release proposals need no separate edit to gates.ts. The bounded release unit inherited from #348 is unchanged.
- **reports** — Nen declares final/register sections for Hatsu's Rikugan template.

### Breaking / consumer notes

- A lane traversal is now rejected while loading the schema: a shu invocation exits 1 for the malformed declaration, where it formerly reached runtime containment at exit 2. No subprocess runs in either case; filesystem/symlink containment still runs at use.
- Lane cwd declarations that are empty, absolute, drive-relative, contain a parent segment or a glob now fail at their own pointer. A dependabot_carve_out.author_pattern must name one anchored literal [bot] login, one literal -bot login, or the legacy dependabot/renovate account (those latter forms also admit an optional [bot] suffix). Regex alternation, wildcard bot sets and human-shaped names are refused. Consumers see these new validator refusals through schema check on repin.
- The shared content scanner is heuristic: its entropy rule flags base64-like tokens of at least 32 characters, at least three character classes and Shannon entropy at least 4.5 bits per character. Hex hashes and low-entropy text do not meet that rule; a shape it does not know can pass. Only threads settle currently calls it. Stage triage's filename secret-shape row and the private-name guard do not reuse it in this change.
- This delivery changes no version or compatibility-floor literal. Hatsu adoption follows the released Nen build. Closes [#404](https://github.com/zheref/nen/issues/404).
