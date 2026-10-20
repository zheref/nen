Add a declaration-pinned, lane-local RubyGems installer for Bashcov on macOS and Linux, with runtime preflights, exact release pins and post-install verification.

Installer prerequisites are reported as additive `installPreconditions` in JSON and in human check/dry-run/install output; the declaration-owned `why` remains unchanged.

Preserve dotted and numeric-attached prerelease suffixes in version observations, so a stable Bashcov pin cannot be falsely satisfied before or after installation.
