### Added

- `nen wc worktree --pr <n> --head <full-sha>` stands the existing detached worktree at a pinned PR head, with the same ignored-file copy and overwrite refusals. A moved head is refused before placement. Dry runs print the fetch and placement plan without fetching; unavailable destination checks are explicitly pending. PR metadata/trust remains the caller’s responsibility. Closes #650.
