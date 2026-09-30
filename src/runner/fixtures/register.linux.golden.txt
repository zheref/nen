#!/usr/bin/env bash
# jusshin — register self-hosted GitHub Actions runners as systemd services.
# rendered by nen 0.0.0-test runner script — do not edit; re-run nen runner script
#
# target:   zheref/nen
# pool:     linux-x64 (self-hosted,Linux,X64)
# runners:  NZ-NNR1, NZ-NNR2, NZ-NNR3
# identity: runner
# root:     /opt/actions-runners
# package:  actions-runner-linux-x64-2.337.0.tar.gz (runner 2.337.0)
#
# Run it as root, through sudo from your own account: sudo bash <this file>.
# config.sh runs as the service user (it refuses root), gh runs as YOU
# (SUDO_USER, with your own sign-in), and svc.sh installs the systemd unit as
# root. The registration token is minted per runner into a variable that is
# never printed.
#
# Exit codes: 0 every planned runner's service is running; 1 anything else;
# 3 run as the wrong user; 5 gh missing or not signed in; 6 the runner
# package failed its SHA-256 check (the file is deleted).
set -euo pipefail

TARGET='zheref/nen'
REPO_URL='https://github.com/zheref/nen'
LABELS='self-hosted,Linux,X64'
ROOT='/opt/actions-runners'
PROJECT_DIR='/opt/actions-runners/nen-runners'
DOWNLOAD_URL='https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-linux-x64-2.337.0.tar.gz'
ARCHIVE='actions-runner-linux-x64-2.337.0.tar.gz'
SHA256='70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613'
SERVICE_PREFIX='actions.runner.zheref-nen.'
RUNNERS=(
  'NZ-NNR1|/opt/actions-runners/nen-runners/Runner1'
  'NZ-NNR2|/opt/actions-runners/nen-runners/Runner2'
  'NZ-NNR3|/opt/actions-runners/nen-runners/Runner3'
)
WORK_DIR="$PROJECT_DIR/_jusshin"
registered=0
skipped=0
failed=0

finish() {
  echo "jusshin: ${registered} registered, ${skipped} skipped, ${failed} failed"
  exit "$1"
}

# Whether a runner directory is already configured as NAME (idempotent re-run).
configured_as() {
  [ -f "$1/.runner" ] && grep -q "\"agentName\": *\"$2\"" "$1/.runner"
}

SERVICE_USER='runner'

if [ "$(id -u)" -ne 0 ]; then
  echo "jusshin: run as root (sudo bash $0) -- this script installs systemd services."
  finish 3
fi
if [ -z "${SUDO_USER:-}" ] || [ "$SUDO_USER" = root ]; then
  echo "jusshin: run through sudo from your own account -- gh runs as that account (SUDO_USER), with its own sign-in."
  finish 3
fi
as_invoker() { sudo -u "$SUDO_USER" -H "$@"; }
if ! as_invoker gh --version >/dev/null 2>&1; then
  echo "jusshin: gh is not on PATH for $SUDO_USER. Install the GitHub CLI and re-run."
  finish 5
fi
if ! as_invoker gh auth status >/dev/null 2>&1; then
  echo "jusshin: 'gh auth status' failed for $SUDO_USER. Run 'gh auth login' and re-run."
  finish 5
fi
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "jusshin: the service user $SERVICE_USER does not exist. Create it (useradd --system --create-home $SERVICE_USER) and re-run."
  finish 1
fi

mkdir -p "$ROOT" "$PROJECT_DIR" "$WORK_DIR"
chmod 0755 "$ROOT" "$PROJECT_DIR"
log="$WORK_DIR/register-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$log") 2>&1
echo "jusshin: ${#RUNNERS[@]} runner(s) for $TARGET; log $log"

pending=()
for entry in "${RUNNERS[@]}"; do
  name="${entry%%|*}"
  dir="${entry#*|}"
  if configured_as "$dir" "$name"; then
    echo "jusshin: $name is already configured in $dir -- skipped."
    skipped=$((skipped + 1))
    continue
  fi
  if [ -f "$dir/.runner" ]; then
    echo "jusshin: $dir holds a runner configured as another name, not $name -- left untouched."
    failed=$((failed + 1))
    continue
  fi
  pending+=("$entry")
done

archive="$WORK_DIR/$ARCHIVE"
verify_archive() {
  echo "$SHA256  $archive" | sha256sum -c - >/dev/null 2>&1
}
if [ "${#pending[@]}" -gt 0 ]; then
  if [ ! -f "$archive" ] || ! verify_archive; then
    echo "jusshin: downloading $ARCHIVE"
    curl -fsSL -o "$archive" "$DOWNLOAD_URL"
    if ! verify_archive; then
      rm -f "$archive"
      echo "jusshin: $ARCHIVE failed its SHA-256 check (expected $SHA256) -- deleted."
      finish 6
    fi
  fi
  echo "jusshin: $ARCHIVE verified (sha256 $SHA256)."
fi

for entry in "${pending[@]+"${pending[@]}"}"; do
  name="${entry%%|*}"
  dir="${entry#*|}"
  echo "jusshin: registering $name in $dir"
  install -d -o "$SERVICE_USER" -m 0755 "$dir"
  sudo -u "$SERVICE_USER" tar xzf "$archive" -C "$dir"
  token="$(as_invoker gh api -X POST "repos/$TARGET/actions/runners/registration-token" --jq .token 2>/dev/null)" || token=""
  if [ -z "$token" ]; then
    echo "jusshin: could not mint a registration token for $name; the gh user must be an admin of $TARGET."
    failed=$((failed + 1))
    continue
  fi
  if ! (cd "$dir" && sudo -u "$SERVICE_USER" ./config.sh --unattended --url "$REPO_URL" --token "$token" --name "$name" --labels "$LABELS" --work _work); then
    token=""
    echo "jusshin: config.sh failed for $name."
    failed=$((failed + 1))
    continue
  fi
  token=""
  if ! (cd "$dir" && ./svc.sh install "$SERVICE_USER" && ./svc.sh start && ./svc.sh status); then
    echo "jusshin: svc.sh could not install or start the service for $name."
    failed=$((failed + 1))
    continue
  fi
  registered=$((registered + 1))
done

down=0
for entry in "${RUNNERS[@]}"; do
  name="${entry%%|*}"
  if ! systemctl is-active --quiet "${SERVICE_PREFIX}${name}.service"; then
    echo "jusshin: ${SERVICE_PREFIX}${name}.service is not active."
    down=$((down + 1))
  fi
done
systemctl list-units "${SERVICE_PREFIX}*" --all --no-pager || true

if [ "$down" -eq 0 ] && [ "$failed" -eq 0 ]; then finish 0; fi
finish 1
