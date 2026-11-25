#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
output=${1:-dist/release}
case "$output" in /*) ;; *) output="$PWD/$output" ;; esac
mkdir -p "$(dirname "$output")"
mkdir "$output" # Do not mix new artifacts with an earlier build.
version=$(node -p 'require("./extension/manifest.json").version')
(
  cd extension
  zip -qr "$output/vacu-chrome-$version.zip" . -x 'firefox/*' 'firefox/' '.DS_Store' '*/.DS_Store'
)
firefox=$(mktemp -d)
trap 'rm -rf "$firefox"' EXIT
node extension/firefox/package.mjs "$firefox/extension"
(
  cd "$firefox/extension"
  zip -qr "$output/vacu-firefox-$version.zip" .
)
npm pack --ignore-scripts --pack-destination "$output"
