#!/usr/bin/env bash
# bootstrap/nen.sh — fetch, checksum-verify and cache the compiled `nen` binary
# pinned to a tag (zheref/nen#1, Akatsuki migration P1).
#
# THIS IS THE ONE SHELL FILE THIS REPOSITORY IS ALLOWED TO HAVE. The AK-11
# successor keeps a near-empty allowlist: only bootstrap-class shell may exist
# at all (Akatsuki migration §3), and this is that file. The exception is not a
# courtesy, it is a bootstrap constraint — this script's entire job is to
# PRODUCE the `nen` binary, and written in TypeScript it would need that binary
# (or a bun toolchain) to run, which is precisely the thing a consumer does not
# have yet. Nothing here may ever be ported into the CLI it fetches, and nothing
# else may ever be added to this directory.
#
# THE SECURITY POSITION, which is the reason this file exists at all.
# zheref/bankai-core#740 is explicit: "A checksum-unverified download is not an
# acceptable end state — it converts a source-pinned supply chain into an
# unpinned one." Consumers pin by REF and get reviewed, readable source at that
# ref. Handing them a pre-compiled executable instead removes the human's
# ability to read what ships. The SHA-256 is what puts the pin back: the
# manifest published beside the binaries at a given tag is the only thing tying
# the bytes a consumer executes to the commit a human reviewed.
#
# So every failure mode here FAILS CLOSED — never "warn and continue", never
# "verify if a hashing tool happens to be installed":
#   * SHA256SUMS unfetchable for a ref -> refuse (EXIT_MANIFEST)
#   * no SHA256SUMS for the ref        -> refuse (EXIT_MANIFEST)
#   * artifact absent from SHA256SUMS  -> refuse (EXIT_MANIFEST)
#   * malformed digest in SHA256SUMS   -> refuse (EXIT_MANIFEST)
#   * no sha256sum/shasum/openssl      -> refuse (EXIT_CHECKSUM)
#   * downloaded bytes disagree        -> DELETE the file, refuse (EXIT_CHECKSUM)
# The one thing this script must never do is print a path to a binary it did not
# verify, because its caller's next act is to EXECUTE that path.
#
# Decision logic lives in small argument-taking functions (artifact_for_host,
# expected_sha, checksum_matches, cache_path, cache_is_valid, verify_or_reject);
# main() does the uname, the network and the mv. The split is deliberate: the
# predicates are then exercisable with no network, which matters here more than
# usual because this file cannot be covered by the vitest harness that covers
# everything else in the repository.
#
# Usage:
#   bootstrap/nen.sh --ref <tag> [--source <owner/name>] [--cache-dir <dir>]
#   (prints the resolved, verified binary path on stdout; non-zero otherwise)
#
# Env equivalents (the flag wins when both are given):
#   NEN_REF        the ref to fetch — REQUIRED, no default (see main)
#   NEN_SOURCE     owner/name to fetch release assets from
#   NEN_CACHE_DIR  default ${XDG_CACHE_HOME:-$HOME/.cache}/nen
#
# `--source`, NOT `--repo`, and the rename from the script this succeeds is
# deliberate. In nen, `--repo` means the PATH of the target repository whose
# taxonomy is being read (src/repo/root.ts); here the argument is a GitHub
# `owner/name` to download release assets from. Two different things under one
# flag name is a silent mistake waiting to happen — `--repo ../bankai-core`
# would be accepted by a fetcher and produce a bewildering 404 — so the two
# meanings get two names across both the shell and the CLI.
#
# `set -e` is deliberately ABSENT. Most functions below return 1 as a VERDICT
# ("no, that checksum does not match"), and under `set -e` a verdict returned
# from a function called outside a conditional kills the shell before the caller
# can print why — the fail-closed messages above are the whole product of this
# script, so an abrupt exit with no message is the one failure mode worse than a
# wrong answer.
set -uo pipefail

# --- exit codes ---------------------------------------------------------------
# Distinct rather than a blanket 1 so a CALLER can tell an operational failure
# (no network) from a security failure (bad checksum) without parsing stderr.
# A wrapper that retries on EXIT_DOWNLOAD must never retry on EXIT_CHECKSUM or
# EXIT_MANIFEST: retrying a checksum failure is how a fail-closed guard becomes a
# fail-open one by attrition, and a manifest that is absent, stripped or
# malformed does not become present by being asked again. Which code a given
# failure carries is therefore a CONTRACT, not a label: see main(), where the
# manifest fetch deliberately reports EXIT_MANIFEST rather than the EXIT_DOWNLOAD
# its transport raised.
EXIT_USAGE=2            # the invocation is wrong; nothing was attempted
EXIT_UNSUPPORTED_HOST=3 # this platform/arch ships no nen binary
EXIT_DOWNLOAD=4         # the BINARY asset could not be retrieved — the retryable one
EXIT_CHECKSUM=5         # SECURITY: bytes did not verify, or could not be verified
EXIT_MANIFEST=6         # SHA256SUMS unfetchable, missing, malformed, or silent about the artifact

# The manifest's published name. Fixed by .github/workflows/release-assets.yml,
# which writes it in `sha256sum -c` format and attaches it as the fourth release
# asset alongside the three binaries.
SUMS_FILE="SHA256SUMS"

DEFAULT_SOURCE="zheref/nen"

# --- lower TEXT ---------------------------------------------------------------
# Lowercase TEXT via `tr`, never `${TEXT,,}`. The bash 4 parameter expansion is a
# bad-substitution error on macOS's stock /bin/bash 3.2, which is a shell this
# will really be run under.
lower() {
  printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'
}

# --- artifact_for_host UNAME_S UNAME_M ----------------------------------------
# Echo the release-asset filename this host can execute; refuse with
# EXIT_UNSUPPORTED_HOST when the host is not one of the three that are built.
#
# The three names are a PUBLISHED CONTRACT, restated here rather than derived:
# package.json's `build:*` outfiles own them, this script must agree with them
# byte for byte, and release-assets.yml asserts the same three names a third
# time before it uploads. Three independent restatements is the point — a list
# derived from the table it is supposed to check is a tautology, not a check.
#
# Deliberately EXHAUSTIVE, with no "closest match" fallback. The two hosts this
# refuses are real machines somebody will run it on — an Intel Mac
# (Darwin/x86_64) and an arm64 Linux runner — and no binary is published for
# either. Handing an Intel Mac the darwin-arm64 build to "try" would produce a
# `Bad CPU type` execve failure three steps later, in a caller with no idea why;
# refusing here says so once, here.
artifact_for_host() {
  local uname_s="${1:-}" uname_m="${2:-}"
  local os arch

  # Case patterns, not equality: MSYS2/Git-for-Windows/Cygwin all report a
  # DECORATED kernel name (`MINGW64_NT-10.0-26200`, `CYGWIN_NT-10.0`), and Git
  # Bash on Windows is a first-class supported host (§10), not an afterthought.
  case "$uname_s" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT|Windows*) os="windows" ;;
    *)
      echo "nen bootstrap: unsupported operating system '${uname_s}' — binaries are published for Linux, macOS and Windows only." >&2
      return "$EXIT_UNSUPPORTED_HOST"
      ;;
  esac

  # `uname -m` spells the same machine differently per OS and per toolchain:
  # x86_64 (Linux/macOS/MSYS), amd64 (some BSD-derived and Go-flavoured
  # environments), and aarch64 (Linux) vs arm64 (Darwin) for the same silicon.
  case "$uname_m" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      echo "nen bootstrap: unsupported machine architecture '${uname_m}' (from uname -m) — x86_64 and arm64 binaries only." >&2
      return "$EXIT_UNSUPPORTED_HOST"
      ;;
  esac

  # The pairing, not the cross product. Only three of the six combinations are
  # built, and the other three must be refused BY NAME so the message tells the
  # operator which half is the problem.
  case "${os}-${arch}" in
    linux-x64) printf '%s\n' "nen-linux-x64" ;;
    darwin-arm64) printf '%s\n' "nen-darwin-arm64" ;;
    # Only Windows carries an extension: an unsuffixed name would be
    # unexecutable on the platform it is built for.
    windows-x64) printf '%s\n' "nen-windows-x64.exe" ;;
    *)
      echo "nen bootstrap: no nen binary is published for ${os}/${arch} (uname -s '${uname_s}', uname -m '${uname_m}'). Published targets: linux/x64, darwin/arm64, windows/x64." >&2
      return "$EXIT_UNSUPPORTED_HOST"
      ;;
  esac
}

# --- expected_sha MANIFEST_FILE ARTIFACT --------------------------------------
# Echo the 64-hex SHA-256 that MANIFEST_FILE records for ARTIFACT; refuse with
# EXIT_MANIFEST if the manifest is absent, says nothing about ARTIFACT, names it
# twice, or records something that is not a SHA-256.
#
# Every one of those is a HARD refusal rather than "fall back to no
# verification": an unreadable manifest and a missing manifest are
# indistinguishable from a STRIPPED one, and the safe reading of an ambiguous
# supply-chain signal is always "stop".
expected_sha() {
  local manifest="${1:-}" artifact="${2:-}"
  local matches count digest

  if [ ! -f "$manifest" ]; then
    echo "nen bootstrap: checksum manifest '${manifest}' is missing — refusing to use an unverified binary." >&2
    return "$EXIT_MANIFEST"
  fi

  # awk with an EXACT field-2 comparison, never `grep "$artifact"`. Today's three
  # names are not substrings of one another, but the failure a substring match
  # invites is silent and severe: an artifact whose name contains another's would
  # match two lines, the first would win, and the binary would be checked against
  # a digest belonging to a different file — a verification step that verifies
  # the wrong thing is worse than none, because it reports success.
  #
  # `sub(/^\*/, "", $2)` accepts the binary-mode spelling too: `sha256sum -b`
  # writes `<hex> *<name>`, and a consumer who regenerates the manifest by hand
  # may well produce that form. release-assets.yml writes the two-space text
  # form; both are the same manifest.
  matches="$(awk -v want="$artifact" '{ sub(/^\*/, "", $2); if ($2 == want) print $1 }' "$manifest")"
  count="$(printf '%s' "$matches" | grep -c . )"

  if [ "$count" -eq 0 ]; then
    echo "nen bootstrap: '${artifact}' has no entry in ${manifest} — refusing to use an unverified binary. The release may have shipped an incomplete asset set." >&2
    return "$EXIT_MANIFEST"
  fi
  if [ "$count" -gt 1 ]; then
    # Ambiguity is refused, never resolved by picking one. Two digests for one
    # filename means the manifest was concatenated, edited or tampered with, and
    # there is no reading of it that is safe to guess at.
    echo "nen bootstrap: '${artifact}' appears ${count} times in ${manifest} with conflicting digests — refusing an ambiguous manifest." >&2
    return "$EXIT_MANIFEST"
  fi

  digest="$matches"
  # Shape-check the digest itself. A truncated or non-hex field would otherwise
  # sail through into a comparison that can never match, and the operator would
  # be told "MISMATCH" (which implicates the download) when the real fault is a
  # corrupt manifest (which implicates the release).
  case "$digest" in
    *[!0-9a-fA-F]*|"")
      echo "nen bootstrap: the digest recorded for '${artifact}' in ${manifest} is not hexadecimal ('${digest}') — refusing a malformed manifest." >&2
      return "$EXIT_MANIFEST"
      ;;
  esac
  if [ "${#digest}" -ne 64 ]; then
    echo "nen bootstrap: the digest recorded for '${artifact}' in ${manifest} is ${#digest} characters, not the 64 of a SHA-256 ('${digest}') — refusing a malformed manifest." >&2
    return "$EXIT_MANIFEST"
  fi

  printf '%s\n' "$digest"
}

# --- sha256_of FILE -----------------------------------------------------------
# Echo FILE's lowercase-hex SHA-256, using whichever of the three usual tools
# this host carries. Returns non-zero — never an empty string treated as a digest
# — when none is present or the file cannot be read.
#
# THE ABSENCE OF A HASHING TOOL IS A REFUSAL, not a reason to skip verification.
# That inversion is the single most likely way this script could be made
# fail-open by a well-meaning edit ("shasum isn't on the minimal container, just
# skip the check there"), so it is stated here rather than left implied: a host
# that cannot verify a binary is a host that does not get one.
sha256_of() {
  local file="${1:-}" out

  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum "$file" 2>/dev/null)" || return 1
    # `${out%% *}` — the digest is the first field; sha256sum's separator is two
    # spaces in text mode and ` *` in binary mode, and both start with a space.
    #
    # THEN STRIP A LEADING BACKSLASH, and this one is a real §10 (macOS ==
    # Windows/Git Bash) defect found by test rather than a hypothetical. GNU
    # coreutils uses an "escaped filename" convention: when the name it echoes
    # contains a backslash or a newline, the whole LINE is prefixed with `\` and
    # the name's backslashes are doubled. On Windows/Git Bash a perfectly
    # ordinary cache directory is spelled `C:\Users\...`, so the output is
    # `\<digest> *C:\\Users\\...` and the first field is a 65-character string
    # starting with `\`. That never equals the manifest's digest — so the cache
    # NEVER hits, every run re-downloads, and (worse) `checksum_matches` reports
    # "does not match" for bytes that are in fact correct, which is a
    # fail-closed direction but for entirely the wrong reason.
    out="${out%% *}"
    printf '%s\n' "${out#\\}"
    return 0
  fi
  # macOS ships `shasum` (perl) and, on recent releases, `sha256sum` too; older
  # ones have only the former, so it is a first-class path rather than a
  # curiosity. It follows the same escaped-filename convention.
  if command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 "$file" 2>/dev/null)" || return 1
    out="${out%% *}"
    printf '%s\n' "${out#\\}"
    return 0
  fi
  # openssl's line is `SHA2-256(file)= <hex>` (or `SHA256(file)= <hex>` on 1.x),
  # so the digest is the LAST field here, not the first.
  if command -v openssl >/dev/null 2>&1; then
    out="$(openssl dgst -sha256 "$file" 2>/dev/null)" || return 1
    printf '%s\n' "${out##* }"
    return 0
  fi

  echo "nen bootstrap: no sha256sum, shasum or openssl on PATH — this host cannot verify a download, so it does not get a binary." >&2
  return 1
}

# --- checksum_matches FILE EXPECTED_HEX ---------------------------------------
# 0 iff FILE exists, can be hashed, and hashes to EXPECTED_HEX. Every other
# outcome — absent file, unreadable file, no hashing tool, differing digest — is
# 1, because every one of them means the same thing to the caller: this file has
# not been proven to be the published artifact.
checksum_matches() {
  local file="${1:-}" expected="${2:-}" actual

  [ -f "$file" ] || return 1
  # Assigned on its own line, never `local actual="$(...)"`: `local` is itself a
  # command and swallows the substitution's exit status (SC2155), which would
  # turn "no hashing tool on this host" into an empty digest compared against a
  # real one — a silent 1 for the right reason today and the wrong reason after
  # the next edit.
  actual="$(sha256_of "$file")" || return 1

  # Case-insensitive: every tool above emits lowercase, but a hand-regenerated
  # manifest may be uppercase, and a digest's spelling is not part of its
  # identity. Never a substring/prefix comparison — a truncated expectation must
  # FAIL, which is what expected_sha's length check guarantees before this is
  # ever reached.
  [ "$(lower "$actual")" = "$(lower "$expected")" ]
}

# --- verify_or_reject FILE EXPECTED_HEX [LABEL] -------------------------------
# The fail-closed gate every downloaded byte passes through. 0 when FILE
# verifies; otherwise DELETES FILE and returns EXIT_CHECKSUM.
#
# The `rm -f` is load-bearing, not tidiness. A rejected artifact left on disk is
# a rejected artifact that a later run — or a caller that ignores this exit
# status, or an operator poking at the temp directory — can still execute. The
# only safe residue of a failed verification is no file at all.
#
# TWO DISTINCT REFUSALS, not one. Both fail closed and both return EXIT_CHECKSUM
# — that is not negotiable — but they are different incidents and must not read
# the same:
#
#   * "could not COMPUTE"  — this host has no hashing tool, or the file is
#     unreadable. Nothing is known about the bytes. The operator's next move is
#     to fix the host.
#   * "MISMATCH"           — the bytes were hashed and they are NOT the
#     published ones. The operator's next move is to treat the release as
#     compromised.
#
# Reporting the first as the second sends someone hunting a tampered release
# that does not exist.
verify_or_reject() {
  local file="${1:-}" expected="${2:-}" label="${3:-${1:-}}" actual

  # An absent file or an empty expectation is a refusal before any hashing:
  # comparing "" against "" would otherwise be a trivially satisfied
  # verification.
  if [ ! -f "$file" ] || [ -z "$expected" ]; then
    rm -f "$file"
    echo "nen bootstrap: refusing ${label} — no file to verify, or no expected digest to verify it against." >&2
    return "$EXIT_CHECKSUM"
  fi

  if ! actual="$(sha256_of "$file" 2>/dev/null)"; then
    rm -f "$file"
    echo "nen bootstrap: could not COMPUTE a SHA-256 for ${label} — refusing to use it." >&2
    echo "nen bootstrap: this is NOT a mismatch: the bytes were never hashed, so nothing is known about them. A host that cannot verify a binary does not get one. Install sha256sum, shasum or openssl and re-run." >&2
    return "$EXIT_CHECKSUM"
  fi

  if [ "$(lower "$actual")" = "$(lower "$expected")" ]; then
    return 0
  fi

  rm -f "$file"
  echo "nen bootstrap: SHA-256 MISMATCH for ${label}." >&2
  echo "nen bootstrap:   expected ${expected}" >&2
  echo "nen bootstrap:   actual   ${actual}" >&2
  echo "nen bootstrap: the downloaded file has been DELETED and nothing was executed. A checksum-unverified download is not an acceptable end state — it converts a source-pinned supply chain into an unpinned one (zheref/bankai-core#740). Re-run to retry; if it mismatches again, the release assets and the SHA256SUMS published beside them disagree, and that is a supply-chain incident, not a flake." >&2
  return "$EXIT_CHECKSUM"
}

# --- cache_path CACHE_ROOT REF ARTIFACT ---------------------------------------
# Echo the stable location a verified binary for REF is kept at. Pure string
# work: it creates nothing and touches nothing, so a caller can ask where a
# binary WOULD live without side effects.
#
# Keyed by REF, so two consumers pinned to different nen tags coexist instead of
# overwriting one another — which is exactly what a source-pinned supply chain
# means when applied to a binary.
#
# REF IS SANITIZED because it arrives from a consumer's pin and is interpolated
# into a filesystem path. A tag (`v0.1.0`) is harmless, but the same input
# accepts a branch (`bootstrap/1-scaffold`, which would silently nest the cache)
# and would accept `../../../.ssh` from a caller that built it from untrusted
# input. A cache path is not a place to extend trust to an argument.
cache_path() {
  local root="${1:-}" ref="${2:-}" artifact="${3:-}" safe_ref

  # Anything outside [A-Za-z0-9._-] becomes '_'. `tr -c` complements the set; the
  # trailing '-' inside the set is literal.
  safe_ref="$(printf '%s' "$ref" | tr -c 'A-Za-z0-9._-' '_')"
  # Dots survive the pass above (tags need them), so `..` survives it too and
  # traversal is still reachable — collapse it separately, and LOOP because a
  # single pass over `....` leaves a fresh `..` behind.
  while [ "$safe_ref" != "${safe_ref//../_}" ]; do
    safe_ref="${safe_ref//../_}"
  done

  printf '%s/%s/%s\n' "$root" "$safe_ref" "$artifact"
}

# --- cache_is_valid CACHED_PATH EXPECTED_HEX ----------------------------------
# 0 iff a cached binary is present AND still hashes to what the manifest says it
# should. This is the whole of the cache-reuse rule: presence is never
# sufficient.
#
# The manifest is re-fetched on every run (see main) rather than cached beside
# the binary, so this predicate always compares against the CURRENT published
# digest for the ref. That matters for a re-cut tag, where a cached manifest
# would happily certify yesterday's bytes forever. Re-fetching a few hundred
# bytes to avoid that is not a trade worth thinking about twice.
cache_is_valid() {
  local cached="${1:-}" expected="${2:-}"

  [ -f "$cached" ] || return 1
  checksum_matches "$cached" "$expected"
}

# --- fetch_release_asset SOURCE REF ASSET DEST --------------------------------
# Retrieve one release asset to DEST. Imperative and network-touching; the only
# decision in it is "which transport is available".
#
# `gh` FIRST when present: it carries the operator's credentials, so it is the
# only path that works against a PRIVATE repository or a draft release — which is
# the state nen is in until it goes public at v0.1 — and it resolves the asset
# through the API rather than guessing a URL shape. `curl` is the fallback for a
# bare container with no gh: the public-release path.
fetch_release_asset() {
  local source_repo="${1:-}" ref="${2:-}" asset="${3:-}" dest="${4:-}"

  if command -v gh >/dev/null 2>&1; then
    if gh release download "$ref" --repo "$source_repo" --pattern "$asset" --output "$dest" --clobber >/dev/null 2>&1; then
      return 0
    fi
    echo "nen bootstrap: 'gh release download ${ref} --pattern ${asset}' failed for ${source_repo}; trying an unauthenticated download." >&2
  fi

  if command -v curl >/dev/null 2>&1; then
    # --retry covers the transient 5xx/connection-reset case only; a 404 is not
    # retried by curl and must not be, because "this release has no such asset"
    # is an answer, not a flake.
    if curl -fsSL --retry 3 --retry-delay 2 -o "$dest" \
      "https://github.com/${source_repo}/releases/download/${ref}/${asset}"; then
      return 0
    fi
    echo "nen bootstrap: could not download '${asset}' from ${source_repo} release '${ref}'." >&2
    return "$EXIT_DOWNLOAD"
  fi

  echo "nen bootstrap: neither 'gh' nor 'curl' is on PATH — cannot fetch '${asset}'." >&2
  return "$EXIT_DOWNLOAD"
}

usage() {
  cat >&2 <<'USAGE'
usage: bootstrap/nen.sh --ref <tag> [--source <owner/name>] [--cache-dir <dir>]

Fetches the `nen` binary published for <ref>, verifies it against the SHA256SUMS
attached to that same release, caches it, and prints its path on stdout.

  --ref        tag/ref to fetch (or $NEN_REF). REQUIRED.
  --source     owner/name to fetch release assets from (or $NEN_SOURCE).
               NOT a filesystem path: `nen --repo` is the flag that takes one.
  --cache-dir  cache root (or $NEN_CACHE_DIR).

Exit codes: 0 ok · 2 usage · 3 unsupported host · 4 binary download failed
            5 CHECKSUM VERIFICATION FAILED · 6 manifest missing/unfetchable/malformed
Retry 4. Never retry 5 or 6 — neither a mismatching binary nor an absent
manifest becomes trustworthy by being asked for again.
USAGE
}

# --- main ---------------------------------------------------------------------
main() {
  local ref="${NEN_REF:-}"
  local source_repo="${NEN_SOURCE:-$DEFAULT_SOURCE}"
  local cache_root="${NEN_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/nen}"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      # Arity is checked BEFORE the shift: `shift 2` with one argument left exits
      # 1 with a raw `shift count out of range`, so a bare trailing `--ref` would
      # abort with a shell diagnostic instead of the usage error that names the
      # problem.
      --ref) [ "$#" -ge 2 ] || { usage; return "$EXIT_USAGE"; }; ref="$2"; shift 2 ;;
      --ref=*) ref="${1#--ref=}"; shift ;;
      --source) [ "$#" -ge 2 ] || { usage; return "$EXIT_USAGE"; }; source_repo="$2"; shift 2 ;;
      --source=*) source_repo="${1#--source=}"; shift ;;
      --cache-dir) [ "$#" -ge 2 ] || { usage; return "$EXIT_USAGE"; }; cache_root="$2"; shift 2 ;;
      --cache-dir=*) cache_root="${1#--cache-dir=}"; shift ;;
      -h|--help) usage; return 0 ;;
      *) echo "nen bootstrap: unknown argument '$1'." >&2; usage; return "$EXIT_USAGE" ;;
    esac
  done

  # NO DEFAULT REF, and no `latest`. A bootstrap that defaults to the newest
  # release is precisely the unpinned supply chain #740 refuses: the consumer's
  # pin names a ref, and the binary must come from THAT ref or the pin has
  # stopped meaning anything. Missing input is a usage error, never a guess.
  if [ -z "$ref" ]; then
    echo "nen bootstrap: --ref (or \$NEN_REF) is required — a bootstrap that defaulted to 'latest' would unpin a source-pinned supply chain." >&2
    usage
    return "$EXIT_USAGE"
  fi

  # An owner/name is required to have exactly the shape of one. A path slipped in
  # here (the `--repo`/`--source` confusion this script's header is about) would
  # otherwise reach the network and come back as a bewildering 404.
  case "$source_repo" in
    */*/*|/*|.*|"")
      echo "nen bootstrap: --source takes a GitHub 'owner/name' (got '${source_repo}'). It is NOT a filesystem path — 'nen --repo <path>' is the flag that takes one." >&2
      return "$EXIT_USAGE"
      ;;
    */*) : ;;
    *)
      echo "nen bootstrap: --source takes a GitHub 'owner/name' (got '${source_repo}')." >&2
      return "$EXIT_USAGE"
      ;;
  esac

  local artifact rc
  artifact="$(artifact_for_host "$(uname -s)" "$(uname -m)")" || return "$EXIT_UNSUPPORTED_HOST"

  local work
  work="$(mktemp -d)" || {
    echo "nen bootstrap: could not create a temporary directory." >&2
    return "$EXIT_DOWNLOAD"
  }
  # NOT `local`: the EXIT trap fires after main() has returned, by which point a
  # `local` is out of scope and `set -u` would kill an otherwise-successful run
  # on an unbound variable.
  BOOTSTRAP_WORKDIR="$work"
  trap 'rm -rf "${BOOTSTRAP_WORKDIR:-}"' EXIT

  # The manifest is fetched FIRST and unconditionally, before any decision about
  # the cache. It is the authority: without it there is no verdict to reach about
  # a cached binary either, so there is no path through this script that skips
  # it.
  #
  # A FAILURE HERE IS EXIT_MANIFEST, NOT EXIT_DOWNLOAD, even though the transport
  # that failed is the same one the binary uses. `fetch_release_asset` cannot
  # tell "this release publishes no SHA256SUMS" from "the network is down" — but
  # the caller contract above is only honourable if the caller is told the
  # SUBJECT of the failure, because that contract reads "retry EXIT_DOWNLOAD,
  # never retry EXIT_CHECKSUM/EXIT_MANIFEST". Returning 4 here would make a
  # wrapper obeying it retry forever against a release whose manifest is
  # permanently absent, and would classify a STRIPPED manifest — the exact
  # supply-chain event that demands a hard stop — as a transient outage. Erring
  # toward the non-retryable code is the fail-closed direction.
  if ! fetch_release_asset "$source_repo" "$ref" "$SUMS_FILE" "$work/$SUMS_FILE"; then
    echo "nen bootstrap: could not retrieve ${SUMS_FILE} for ${source_repo} release '${ref}' — with no manifest there is nothing to verify a binary against, so this is a refusal and not a retryable download failure." >&2
    return "$EXIT_MANIFEST"
  fi

  local expected
  expected="$(expected_sha "$work/$SUMS_FILE" "$artifact")"
  rc=$?
  [ "$rc" -eq 0 ] || return "$rc"

  local cached
  cached="$(cache_path "$cache_root" "$ref" "$artifact")"

  if cache_is_valid "$cached" "$expected"; then
    # The only fast path, and it is gated on the CHECKSUM rather than on the
    # file's existence: a truncated earlier download, a partially-written mv, or
    # a re-cut tag all land here as a MISS and fall through to a fresh fetch.
    echo "nen bootstrap: cache hit for ${source_repo}@${ref} (${artifact}), checksum verified." >&2
    printf '%s\n' "$cached"
    return 0
  fi

  echo "nen bootstrap: fetching ${artifact} from ${source_repo} release ${ref}…" >&2
  fetch_release_asset "$source_repo" "$ref" "$artifact" "$work/$artifact" || return "$EXIT_DOWNLOAD"

  # Verified in the TEMP directory, before anything is moved into the cache. The
  # ordering is the guarantee: a binary that fails here never occupies the path
  # this script prints, so a later run cannot find rejected bytes sitting where
  # verified ones belong.
  verify_or_reject "$work/$artifact" "$expected" "${artifact} (${source_repo}@${ref})" || return "$EXIT_CHECKSUM"

  # The +x is what makes the path this script PRINTS actually runnable: both
  # `gh release download` and `curl` write 0644, so without it the caller gets a
  # path and an `exit 126, Permission denied` the moment it runs it. A failure
  # here is a REFUSAL, not a warning — a guard that gives up quietly is how a
  # missing permission becomes a green run.
  #
  # Skipped for `.exe` because Windows has no exec bit to set: there, chmod is a
  # no-op that can still report failure on some filesystems, and failing the
  # download over a bit that does not exist would be its own false negative.
  case "$artifact" in
    *.exe) : ;;
    *)
      chmod +x "$work/$artifact" || {
        rm -f "$work/$artifact"
        echo "nen bootstrap: verified ${artifact} but could not make it executable — refusing to hand back a path that cannot be run." >&2
        return "$EXIT_DOWNLOAD"
      }
      ;;
  esac
  mkdir -p "$(dirname "$cached")" || {
    echo "nen bootstrap: could not create the cache directory '$(dirname "$cached")'." >&2
    return "$EXIT_DOWNLOAD"
  }
  # `mv` within… not necessarily the same filesystem ($TMPDIR and $HOME often
  # differ), so this is a copy+unlink on those hosts and therefore NOT atomic.
  # That is tolerable only because of the ordering above plus cache_is_valid's
  # checksum gate: a mv interrupted midway leaves a short file, which the next
  # run hashes, rejects as a cache miss, and replaces.
  mv -f "$work/$artifact" "$cached" || {
    echo "nen bootstrap: could not install the verified binary at '${cached}'." >&2
    return "$EXIT_DOWNLOAD"
  }

  echo "nen bootstrap: verified ${artifact} for ${source_repo}@${ref} (sha256 ${expected})." >&2
  # stdout carries the PATH ALONE — every diagnostic above goes to stderr — so a
  # caller can safely do: nen="$(bootstrap/nen.sh --ref "$ref")".
  printf '%s\n' "$cached"
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
