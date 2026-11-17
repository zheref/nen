### Fixed

- Check declared hook modes even for markerless and verbatim files, preserving POSIX executable-bit checks and Windows read-only drift detection ([#344](https://github.com/zheref/nen/issues/344)). The Windows `0755` to `0666` projection already landed in [#324](https://github.com/zheref/nen/pull/324); regression coverage now checks generated hooks and content drift across Codex, Cursor, and Antigravity. Verification at an adopted release still requires a separate reviewed Hatsu repin and a Windows check.
