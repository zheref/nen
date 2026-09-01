# Nen

A local development CLI for repository-driven, agentic delivery workflows: one binary that reads a repo's taxonomy as data (labels, registry, colors) and gives humans, Claude Code skills, and CI the **same deterministic verbs** — readiness verdicts, backlog sweeps, wake protocols, release preflight, scaffolding — with human-readable output by default and a stable `--json` contract.

> **Status: pre-release (private).** Nen ships first in the Akatsuki migration and serves the live [bankai-core](https://github.com/zheref/bankai-core) system before its successor exists. This repo goes public at **v0.1**, with a full README, license, and checksummed binaries for linux-x64 / darwin-arm64 / windows-x64.

Design principles (ratified in the migration plan):

- **Names are data** — no hard-coded personas, labels, check names, or colors; everything is read from the target repo's schemas.
- **One readiness authority** — `nen pr ready` produces the same verdict for the human, the plugin, and CI.
- **Deterministic verbs, LLM judgment** — Nen detects, computes, formats, and verifies; it never decides what only judgment can.
- **One binary** — plus `git` and `gh`; no make, no jq/yq, no runtime Python.

## Working on Nen

Requires [bun](https://bun.sh) 1.4.0 or newer, and nothing else. Identical on
macOS and Windows/Git Bash.

```
bun install --frozen-lockfile
bun run typecheck && bun run lint && bun run test   # or: bun src/index.ts dev test
```

Tests live beside their sources (`src/**/*.test.ts`). `bun run build:linux-x64`
(and the `darwin-arm64` / `windows-x64` siblings) cross-compile the release
binaries from any one host.
