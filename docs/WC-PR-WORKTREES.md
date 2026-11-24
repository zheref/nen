# Pinned pull-request worktree

`nen wc worktree --repo . --name review --pr 650 --head <full-lowercase-sha>`
fetches `refs/pull/650/head` from origin and compares it with the pin before
creating or moving the detached worktree. Use `--copy-from-core <ignored-file>`
for the same protected copies as the `--base` form. These selectors are mutually
exclusive. The caller checks that the PR is open and trusted; this verb reads
no PR metadata. A mismatch names both commits and leaves the worktree untouched.

`--dry-run` fetches and writes nothing. It prints the planned fetch and detached
placement; remote-head verification remains pending, and when the commit or a required tree is not
local, destination/overwrite checks remain pending too. The displayed state is
conditional on those checks passing on the real run.

PR dry runs require Git 2.44 or newer and disable lazy fetch for all reads.
PR reads and placement ignore local replacement objects. Fetches suppress
configured ref mappings, tag following, pruning, recursive submodule fetching
and automatic maintenance; the scratch ref is removed before placement.
