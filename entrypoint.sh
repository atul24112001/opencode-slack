#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${WORKSPACE_DIR:-/workspace}"
mkdir -p "$WORKSPACE"

# --- opencode auth ---
# Materialize ~/.local/share/opencode/auth.json from OPENCODE_API_KEY. Using node
# (already in the image) for safe JSON encoding.
AUTH_DIR="$HOME/.local/share/opencode"
AUTH_FILE="$AUTH_DIR/auth.json"
mkdir -p "$AUTH_DIR"
if [ -n "${OPENCODE_API_KEY:-}" ]; then
  node -e '
    const fs = require("fs");
    fs.writeFileSync(
      process.argv[1],
      JSON.stringify({ "opencode-go": { key: process.env.OPENCODE_API_KEY, type: "api" } }),
      { mode: 0o600 },
    );
  ' "$AUTH_FILE"
elif [ ! -f "$AUTH_FILE" ]; then
  echo "[entrypoint] WARNING: OPENCODE_API_KEY is not set and no auth.json exists." >&2
  echo "[entrypoint] opencode will fail to authenticate. Set OPENCODE_API_KEY in .env." >&2
fi

# --- git ---
git config --global user.name "${GIT_USER_NAME:-opencode-slack-bot}"
git config --global user.email "${GIT_USER_EMAIL:-bot@opencode-slack-bot.local}"
git config --global init.defaultBranch main

# GITHUB_TOKEN is read on-demand from env by this credential helper. The token
# is never written into ~/.gitconfig or any repo's .git/config.
if [ -n "${GITHUB_TOKEN:-}" ]; then
  git config --global credential.helper \
    '!f() { echo "username=x-access-token"; echo "password=${GITHUB_TOKEN}"; }; f'
fi

# Clone each repo in GIT_REPOS (comma-separated) into $WORKSPACE/<name>.
# Existing checkouts are left alone — re-clones would clobber local work.
declare -a paths=()
if [ -n "${GIT_REPOS:-}" ]; then
  IFS=',' read -ra REPOS <<< "$GIT_REPOS"
  for repo in "${REPOS[@]}"; do
    repo="$(echo "$repo" | tr -d '[:space:]')"
    [ -z "$repo" ] && continue
    name="$(basename -s .git "$repo")"
    target="$WORKSPACE/$name"
    if [ ! -d "$target/.git" ]; then
      echo "[entrypoint] cloning $repo -> $target"
      git clone "$repo" "$target"
    else
      echo "[entrypoint] $target already present, skipping clone"
    fi
    paths+=("$target")
  done
fi

# Auto-fill ALLOWED_REPOS / DEFAULT_REPO from whatever was cloned, unless the
# user set them explicitly.
if [ "${#paths[@]}" -gt 0 ]; then
  joined="$(IFS=,; echo "${paths[*]}")"
  : "${ALLOWED_REPOS:=$joined}"
  : "${DEFAULT_REPO:=${paths[0]}}"
  export ALLOWED_REPOS DEFAULT_REPO
fi

exec "$@"
