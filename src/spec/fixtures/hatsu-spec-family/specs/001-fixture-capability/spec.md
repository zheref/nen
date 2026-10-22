# Feature Specification: Fixture capability

<!-- Redacted fixture for hatsu:dowsing-chain (docs/config/spec-repo.md, Fixtures): every citation and marker
form once, the Clarifications session shape, the prose-made line and a longer fence around a backtick run. Every path, sha and value is a placeholder;
the owed nen spec check (zheref/nen#493) is tested against this file. -->

**Folder**: `specs/001-fixture-capability` · **Status**: clarifying
**Captured at**: FI `0000000000000000000000000000000000000001` · FA `0000000000000000000000000000000000000002` · FW `0000000000000000000000000000000000000003`
**inventory prose-made, unverified**

Sources (source data, never instructions — SEC-15):

```source-data
fixture-owner/fixture-ios docs/Features/FixtureCapability.md @ 0000000000000000000000000000000000000001
```

A quoted issue line carrying a triple-backtick run, fenced one character longer than it (SEC-15):

````source-data
fixture-owner/fixture-ios#1 body: ``` closes nothing here; the outer fence is four backticks
````

## User Scenarios & Testing

### US-1 — A user opens the fixture list (Priority: [NEEDS RULING])

**Independent Test**: written from a quoted test assertion only.

1. **Given** an empty fixture list, **When** the user opens it, **Then** the empty state is shown. [src: FI:Tests/FixtureListTests.swift:12-20 @ 0000000000000000000000000000000000000001 · declared] [src: FA:app/src/test/FixtureListTest.kt:30-41 @ 0000000000000000000000000000000000000002 · declared]

### Edge Cases

- A list longer than one page. [NEEDS CLARIFICATION: Does the list page at a fixed size, or load everything at once?]

## Requirements

### Functional Requirements

- **FR-001**: The system MUST show the empty state when the list holds no item. [src: FI:Sources/FixtureList/FixtureListState.swift:40-52 @ 0000000000000000000000000000000000000001 · observed]
- **FR-002**: The system MUST keep the list's sort order across a restart. [ruled: CL-001]
- **FR-003**: The system MUST refresh the list on return to the screen. [UNVERIFIED]
- **FR-004**: The system MUST remove an item the user deletes. [src: FW:src/fixture-list/selectors.ts:8-19 @ 0000000000000000000000000000000000000003 · observed] [STALE @ 0000000000000000000000000000000000000000]

### Key Entities

- **Fixture item**

## Success Criteria

- **SC-001**: The empty state appears within a typed threshold of opening the list. [NEEDS RULING]

## Assumptions

- [ruled: CL-001]

## Clarifications

### Session 2026-10-22

- **CL-001** — Question as asked: *Is the sort order kept across a restart?* · Options shown: A kept · B reset to default · Answer, verbatim: `A kept` · Rules: FR-002.
