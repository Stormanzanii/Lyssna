#!/bin/bash
set -euo pipefail

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./build.sh [local|branch|commit]
  No target: update main from origin, then build and install the latest app.
  local:     build the current checkout, including uncommitted changes.
  branch:    fetch that branch from origin and build its latest commit.
  commit:    build a commit already available in this repository.
The original checkout is restored after the build. Nothing is pushed.
EOF
}

main() {
  if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then usage; exit 0; fi
  [[ $# -le 1 ]] || fail 'Expected at most one target. Run ./build.sh --help.'
  [[ "$(uname -s)" == Darwin ]] || fail 'This script requires macOS.'
  for tool in git node npm rustup cargo cmake; do
    command -v "$tool" >/dev/null 2>&1 || fail "Missing $tool. See README macOS prerequisites."
  done
  xcode-select -p >/dev/null 2>&1 || fail 'Install Xcode Command Line Tools: xcode-select --install'
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' \
    || fail 'Node.js 24 or later is required.'

  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  git rev-parse --show-toplevel >/dev/null
  target="${1:-}"
  original_branch="$(git symbolic-ref --quiet --short HEAD || true)"
  original_commit="$(git rev-parse HEAD)"
  restore_git=0

  restore_checkout() {
    local status="$1"
    trap - EXIT
    if [[ "$restore_git" == 1 ]]; then
      if [[ -n "$original_branch" ]]; then
        git switch --quiet "$original_branch" || {
          printf 'Could not restore branch %s.\n' "$original_branch" >&2
          status=1
        }
      else
        git switch --quiet --detach "$original_commit" || {
          printf 'Could not restore original commit %s.\n' "$original_commit" >&2
          status=1
        }
      fi
    fi
    exit "$status"
  }
  trap 'restore_checkout "$?"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [[ "$target" == local ]]; then
    printf 'Building current checkout without Git changes.\n'
  else
    [[ -z "$(git status --porcelain --untracked-files=normal)" ]] \
      || fail 'Commit or stash changes first, or use ./build.sh local.'
    restore_git=1
    if [[ -z "$target" ]]; then
      printf 'Updating main from origin.\n'
      git switch main
      git pull --ff-only origin main
    else
      [[ "$target" != -* ]] || fail 'Unknown option. Run ./build.sh --help.'
      if git check-ref-format "refs/heads/$target" >/dev/null 2>&1 \
        && git ls-remote --exit-code --heads origin "refs/heads/$target" >/dev/null 2>&1; then
        # On origin: build its latest commit.
        git fetch --no-tags origin "refs/heads/$target"
        commit="$(git rev-parse --verify 'FETCH_HEAD^{commit}')"
      elif git show-ref --verify --quiet "refs/heads/$target"; then
        # Only local: build the local branch as it is.
        commit="$(git rev-parse --verify "refs/heads/$target^{commit}")"
      elif commit="$(git rev-parse --verify --quiet --end-of-options "${target}^{commit}")"; then
        :
      else
        git check-ref-format "refs/heads/$target" >/dev/null || fail 'Invalid branch or commit.'
        git fetch --no-tags origin "refs/heads/$target"
        commit="$(git rev-parse --verify 'FETCH_HEAD^{commit}')"
      fi
      git switch --detach "$commit"
    fi
  fi

  required_rust="$(node -e '
    const manifest = require("node:fs").readFileSync("Cargo.toml", "utf8");
    const version = manifest.match(/^rust-version\s*=\s*"([^"]+)"/m)?.[1];
    if (!version) throw new Error("Cargo.toml is missing rust-version.");
    process.stdout.write(version.split(".").length === 2 ? version + ".0" : version);
  ')"
  export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-$required_rust}"
  if ! rustup run "$RUSTUP_TOOLCHAIN" rustc --version >/dev/null 2>&1; then
    rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal
  fi

  printf 'Building %s with Rust %s.\n' "$(git rev-parse --short HEAD)" "$RUSTUP_TOOLCHAIN"
  npm ci --no-audit --no-fund
  npm run desktop:build -- -- --locked
}

# Parse the complete build routine before checkout/pull can replace this file.
main "$@"
