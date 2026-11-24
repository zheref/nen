### Added

- `nen commit format --repo <path> --message-file <path>` validates existing commit text without rewriting it or requiring a staged index, using commit-write’s message and policy validators. Mixed file/building inputs are refused. Closes #606.
