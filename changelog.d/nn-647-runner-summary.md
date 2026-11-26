### Added
- `runner summary --plan --after` reads the newest registration summary after a UTC launch time, returning its counts and path or distinct none, unreadable and malformed outcomes without launching scripts or reading transcripts (NN#647).
- Generated Windows scripts grant the launching user parent-only read-attributes access so the unelevated summary reader retains its directory/link checks without gaining parent content access (NN#647).
