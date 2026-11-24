# Read a registration summary

`nen runner summary --plan <plan.json> --after 2026-11-24T12:00:00Z --json`
reads the newest `register-*.summary` strictly newer than the launch time under
the plan’s project directory, using file modification times and path order for ties.
It never launches a script or opens a transcript. The `nen.runner.summary/v0.1`
result reports `read` with counts/path/time, `none` with null counts, or
`unreadable`/`malformed` with a reason. Exit 0 means a successful read or no new
summary, not successful registration: inspect `failed`. A missing directory,
link, non-regular file or unstable read is exit 1, as is a malformed newest
summary (no fallback). Invalid plan, host path or UTC ISO launch time is exit 2.
Summary content is never echoed on refusal.
