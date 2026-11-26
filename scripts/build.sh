#!/bin/sh
set -eu

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ -z "$1" ]; }; then
  echo 'Usage: sh scripts/build.sh [NEW_DIRECTORY]' >&2
  exit 1
fi
CDPATH= cd "$(dirname "$0")/.."
output=${1:-dist/release}
case "$output" in /*) ;; *) output="$PWD/$output" ;; esac
if [ -e "$output" ] || [ -L "$output" ]; then
  echo "Release output already exists: $output" >&2
  exit 1
fi
version=$(node -e '
  const { version } = require("./package.json");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
      ["chrome", "firefox"].some(browser => require(`./extension/${browser}/manifest.json`).version !== version)) {
    throw new Error("Chrome, Firefox, and npm versions must match (MAJOR.MINOR.PATCH).");
  }
  console.log(version);
')
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' 0
trap 'exit 1' HUP INT TERM
mkdir "$scratch/release"
for browser in chrome firefox; do
  node "extension/$browser/package.mjs" "$scratch/$browser"
  (
    cd "$scratch/$browser"
    zip -qr "$scratch/release/vacu-$browser-$version.zip" manifest.json "$browser" shared
  )
done
npm pack --ignore-scripts --pack-destination "$scratch/release"
mkdir -p "$(dirname "$output")"
mkdir "$output" # Do not mix new artifacts with an earlier build.
cp "$scratch/release/vacu-chrome-$version.zip" "$scratch/release/vacu-firefox-$version.zip" \
  "$scratch/release/noahp78-vacu-$version.tgz" scripts/install.sh "$output/"
