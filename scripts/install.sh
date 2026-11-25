#!/bin/sh
set -eu

case "$(uname -s)" in Darwin|Linux) ;; *) echo 'VACU requires macOS or Linux.' >&2; exit 1 ;; esac
case $# in
  0) set -- ;;
  1) ;;
  *) echo 'Usage: sh install.sh [CHROME_EXTENSION_ID | --firefox]' >&2; exit 1 ;;
esac
if ! command -v npm >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)'; then
  echo 'Install Node.js 22 or newer with npm first.' >&2
  exit 1
fi

# Keep the installer and its matching archive together.
cd "$(dirname "$0")"
set_archive() {
  if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo 'Put exactly one noahp78-vacu-*.tgz from the same GitHub release next to install.sh.' >&2
    exit 1
  fi
  archive=$1
}
set_archive ./noahp78-vacu-*.tgz
prefix="$HOME/.local"
npm install --global --prefix "$prefix" --ignore-scripts "$archive"
cli="$prefix/bin/vacu"
if [ "$#" -eq 1 ]; then
  "$cli" setup "$1"
else
  printf '\nChrome extension folder: '
  "$cli" setup
  printf 'After loading it, run "%s" setup CHROME_EXTENSION_ID once.\n' "$cli"
fi
printf 'Verify with "%s" status (or add %s/bin to PATH).\n' "$cli" "$prefix"
