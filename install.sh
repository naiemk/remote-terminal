#!/usr/bin/env bash
# Installs remote-terminal-server.
#
#   curl -fsSL https://raw.githubusercontent.com/naiemk/remote-terminal/main/install.sh | bash
#
# What it does:
#   - uses your Node.js (18.17+), or downloads a private copy into ~/.remote-terminal-server/node
#   - downloads the app into ~/.remote-terminal-server/app and installs its dependencies
#   - puts a `remote-terminal-server` command in ~/.local/bin (and adds that to PATH if needed)
#   - your settings (~/.remote-terminal-server/commands.json, .env) are never touched
#
# Environment overrides:
#   REMOTE_TERMINAL_REF=v1.2.0          branch or tag to install (default: main)
#   REMOTE_TERMINAL_SOURCE=/path/or.tgz install from a local checkout or tarball instead of GitHub
#   REMOTE_TERMINAL_HOME=~/.rts         where everything lives (default: ~/.remote-terminal-server)
#   REMOTE_TERMINAL_BIN_DIR=~/bin       where the command goes (default: ~/.local/bin)
#   REMOTE_TERMINAL_NO_MODIFY_PATH=1    don't edit your shell profile
#   REMOTE_TERMINAL_NODE=/path/to/node  use this Node.js
#
# The whole script is inside main(), so a partial download can't run half of it.

main() {
  set -euo pipefail

  local REPO="naiemk/remote-terminal"
  local REF="${REMOTE_TERMINAL_REF:-main}"
  local HOME_DIR="${REMOTE_TERMINAL_HOME:-$HOME/.remote-terminal-server}"
  local BIN_DIR="${REMOTE_TERMINAL_BIN_DIR:-$HOME/.local/bin}"
  local APP_DIR="$HOME_DIR/app"
  local NODE_MIN_MAJOR=18 NODE_MIN_MINOR=17
  local NODE_LTS="v22"   # line used when we download Node ourselves

  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    B=$'\033[1m' D=$'\033[2m' G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' C=$'\033[36m' N=$'\033[0m'
  else
    B='' D='' G='' Y='' R='' C='' N=''
  fi
  say()  { printf '%s\n' "$*"; }
  step() { printf '%s›%s %s\n' "$C" "$N" "$*"; }
  ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
  warn() { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
  die()  { printf '%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
  have() { command -v "$1" >/dev/null 2>&1; }

  say "${B}remote-terminal-server installer${N}"
  say ""

  # ---------- platform ----------
  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "Unsupported system: $(uname -s). remote-terminal-server runs on Linux and macOS." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) die "Unsupported CPU: $(uname -m)." ;;
  esac
  have curl || die "curl is required."
  have tar || die "tar is required."

  # ---------- Node.js ----------
  node_ok() {
    "$1" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>$NODE_MIN_MAJOR||(a===$NODE_MIN_MAJOR&&b>=$NODE_MIN_MINOR)?0:1)" 2>/dev/null
  }
  local NODE=""
  if [ -n "${REMOTE_TERMINAL_NODE:-}" ]; then
    node_ok "$REMOTE_TERMINAL_NODE" || die "REMOTE_TERMINAL_NODE=$REMOTE_TERMINAL_NODE isn't Node.js $NODE_MIN_MAJOR.$NODE_MIN_MINOR or newer."
    NODE="$REMOTE_TERMINAL_NODE"
  elif have node && node_ok "$(command -v node)"; then
    # Resolve shims (mise, asdf, volta) to the real binary: the native terminal module is built for it.
    NODE="$(node -p 'process.execPath')"
  elif [ -x "$HOME_DIR/node/bin/node" ] && node_ok "$HOME_DIR/node/bin/node"; then
    NODE="$HOME_DIR/node/bin/node"
  else
    step "Node.js $NODE_MIN_MAJOR.$NODE_MIN_MINOR+ not found; downloading Node.js $NODE_LTS into $HOME_DIR/node"
    local index file tmpn
    index="https://nodejs.org/dist/latest-$NODE_LTS.x/"
    file="$(curl -fsSL "$index" | grep -oE "node-v[0-9.]+-$os-$arch\.tar\.gz" | head -n1)" \
      || die "Couldn't find a Node.js download for $os-$arch. Install Node.js from https://nodejs.org and run this again."
    tmpn="$(mktemp -d)"
    curl -fsSL "$index$file" | tar -xz -C "$tmpn" --strip-components=1 || die "Downloading Node.js failed."
    mkdir -p "$HOME_DIR"
    rm -rf "$HOME_DIR/node"
    mv "$tmpn" "$HOME_DIR/node"
    NODE="$HOME_DIR/node/bin/node"
  fi
  local NPM
  NPM="$(dirname "$NODE")/npm"
  [ -x "$NPM" ] || NPM="$(command -v npm || true)"
  [ -n "$NPM" ] || die "npm not found next to $NODE."
  ok "Node.js $("$NODE" -v) ${D}($NODE)${N}"

  # ---------- build tools (Linux) ----------
  # The terminal module (node-pty) ships prebuilt for macOS; on Linux it's compiled on install.
  if [ "$os" = linux ]; then
    local missing=()
    have make || missing+=(make)
    have g++ || have c++ || missing+=(g++)
    have python3 || missing+=(python3)
    if [ "${#missing[@]}" -gt 0 ]; then
      local hint="your package manager"
      if have apt-get; then hint="sudo apt-get install -y build-essential python3"
      elif have dnf; then hint="sudo dnf install -y make gcc-c++ python3"
      elif have pacman; then hint="sudo pacman -S --needed base-devel python"
      elif have apk; then hint="sudo apk add build-base python3"
      elif have zypper; then hint="sudo zypper install -y make gcc-c++ python3"
      fi
      die "Missing build tools: ${missing[*]}. Install them with:  $hint  then run this again."
    fi
  fi

  # ---------- download ----------
  tmp="$(mktemp -d)"   # not local: the EXIT trap runs after main returns
  trap 'rm -rf "${tmp:-}"' EXIT
  mkdir -p "$tmp/app"
  if [ -n "${REMOTE_TERMINAL_SOURCE:-}" ]; then
    step "Installing from $REMOTE_TERMINAL_SOURCE"
    if [ -d "$REMOTE_TERMINAL_SOURCE" ]; then
      (cd "$REMOTE_TERMINAL_SOURCE" && tar -cf - --exclude=node_modules --exclude=.git --exclude=.env --exclude=./commands.json .) | tar -xf - -C "$tmp/app"
    else
      tar -xzf "$REMOTE_TERMINAL_SOURCE" -C "$tmp/app" --strip-components=1
    fi
  else
    step "Downloading $REPO@$REF"
    curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$tmp/app" --strip-components=1 \
      || die "Download failed: https://github.com/$REPO (ref $REF)."
  fi
  [ -f "$tmp/app/bin/remote-terminal-server" ] || die "That doesn't look like remote-terminal-server."
  # Remember which commit this is, so the server can tell when a newer one exists.
  if [ -z "${REMOTE_TERMINAL_SOURCE:-}" ]; then
    curl -fsSL -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$REPO/commits/$REF" >"$tmp/app/.version" 2>/dev/null || rm -f "$tmp/app/.version"
  fi

  # ---------- dependencies ----------
  step "Installing dependencies (this compiles the terminal module on Linux; it takes a minute)"
  local npm_log="$tmp/npm.log"
  if ! (cd "$tmp/app" && PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --omit=dev --no-audit --no-fund --loglevel=error >"$npm_log" 2>&1); then
    tail -n 30 "$npm_log" >&2
    die "npm install failed (full log above)."
  fi
  # node-pty's prebuilt macOS helper can lose its executable bit in the package, and then every
  # terminal fails to start with "posix_spawnp failed".
  chmod +x "$tmp"/app/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
  "$NODE" -e "require('$tmp/app/node_modules/node-pty')" 2>/dev/null || die "The terminal module (node-pty) didn't build for $("$NODE" -v)."

  # Swap the new version in; the old one is kept until the new one is in place.
  mkdir -p "$HOME_DIR"
  rm -rf "$APP_DIR.old"
  [ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
  mv "$tmp/app" "$APP_DIR"
  rm -rf "$APP_DIR.old"
  ok "Installed $("$NODE" -p "require('$APP_DIR/package.json').version") to $APP_DIR"

  # ---------- command ----------
  mkdir -p "$BIN_DIR"
  cat >"$BIN_DIR/remote-terminal-server" <<EOF
#!/bin/sh
# Installed by remote-terminal-server's install.sh. Re-run the installer (or \`remote-terminal-server update\`) to upgrade.
if [ ! -x "$NODE" ]; then
  echo "remote-terminal-server: Node.js at $NODE is gone. Reinstall with:" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash" >&2
  exit 1
fi
exec "$NODE" "$APP_DIR/bin/remote-terminal-server" "\$@"
EOF
  chmod +x "$BIN_DIR/remote-terminal-server"
  ok "Command: $BIN_DIR/remote-terminal-server"

  local on_path=1
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) on_path=0 ;; esac
  if [ "$on_path" = 0 ] && [ -z "${REMOTE_TERMINAL_NO_MODIFY_PATH:-}" ]; then
    local profile line
    case "$(basename "${SHELL:-bash}")" in
      zsh) profile="$HOME/.zshrc"; line="export PATH=\"$BIN_DIR:\$PATH\"" ;;
      fish) profile="$HOME/.config/fish/config.fish"; line="fish_add_path \"$BIN_DIR\"" ;;
      *) profile="$HOME/.bashrc"; [ "$os" = darwin ] && profile="$HOME/.bash_profile"; line="export PATH=\"$BIN_DIR:\$PATH\"" ;;
    esac
    mkdir -p "$(dirname "$profile")"
    if ! grep -qsF "$line" "$profile"; then
      printf '\n# remote-terminal-server\n%s\n' "$line" >>"$profile"
      ok "Added $BIN_DIR to PATH in $profile"
    fi
  fi

  # ---------- Tailscale (optional) ----------
  say ""
  local ts=""
  if have tailscale; then ts=tailscale
  elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then ts=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  fi
  if [ -z "$ts" ]; then
    warn "Tailscale isn't installed. You can still run the server, but only this computer can open it."
    say  "  To use it from your phone, install Tailscale on both and sign in: ${C}https://tailscale.com/download${N}"
  elif "$ts" status >/dev/null 2>&1; then
    ok "Tailscale is connected"
  else
    warn "Tailscale is installed but not connected. Run ${B}tailscale up${N} or sign in from the Tailscale app."
  fi

  say ""
  say "${G}${B}Done.${N} Start it with:"
  say ""
  if [ "$on_path" = 1 ]; then
    say "  ${B}remote-terminal-server${N}"
  else
    say "  ${B}$BIN_DIR/remote-terminal-server${N}   ${D}(or open a new terminal and run remote-terminal-server)${N}"
  fi
  say ""
  say "  ${D}Commands you can start: $HOME_DIR/commands.json${N}"
  say "  ${D}Docs: https://naiemk.gitbook.io/remote-terminal${N}"
}

main "$@"
