### Breaking / consumer notes

- `nen surface mirror generate` and `check` now refuse a Codex `AGENTS.md` over 32,768 UTF-8 bytes at exit 2. The refusal names the first affected persona or shared include, its byte range and the first unread byte. Previously generation succeeded with a warning and check could pass despite silent truncation. Split oversized source instructions before regenerating; the read limit is not raised and no partial mirror is written. Closes #641.
