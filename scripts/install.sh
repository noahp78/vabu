#!/bin/sh
set -eu

usage() {
  echo 'Usage: sh install.sh [CHROME_EXTENSION_ID [--config-dir ABSOLUTE_PATH] | --firefox]' >&2
  exit 1
}
case "$(uname -s)" in Darwin|Linux) ;; *) echo 'VABU requires macOS or Linux.' >&2; exit 1 ;; esac
case $# in
  0|1) ;;
  3)
    [ "$2" = --config-dir ] || usage
    case "$3" in /*) ;; *) usage ;; esac
    ;;
  *) usage ;;
esac
if [ "$#" -ne 0 ]; then
  if [ "$1" = --firefox ]; then
    [ "$#" -eq 1 ] || usage
  else
    [ "${#1}" -eq 32 ] || usage
    case "$1" in *[!abcdefghijklmnop]*) usage ;; esac
  fi
fi
if ! command -v npm >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)'; then
  echo 'Install Node.js 22 or newer with npm first.' >&2
  exit 1
fi

# Keep the installer and its matching archive together. Never fetch from a registry.
CDPATH= cd "$(dirname "$0")"
find_archive() {
  if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo 'Put exactly one noahp78-vacu-*.tgz from the same GitHub release next to install.sh.' >&2
    exit 1
  fi
  archive=$1
}
find_archive ./noahp78-vacu-*.tgz
prefix="$HOME/.local"
npm install --global --prefix "$prefix" --ignore-scripts --offline --no-audit --no-fund "$archive"
cli="$prefix/bin/vabu"
if [ "$#" -ne 0 ]; then
  "$cli" setup "$@"
else
  extension=$("$cli" setup)
  printf '\nChrome extension folder: %s\n' "$extension"
  printf 'After loading it, run "%s" setup CHROME_EXTENSION_ID once.\n' "$cli"
fi
verify=status
if [ "${1:-}" = --firefox ]; then verify='--socket firefox-default status'; fi
printf 'Verify with "%s" %s (or add %s/bin to PATH).\n' "$cli" "$verify" "$prefix"
