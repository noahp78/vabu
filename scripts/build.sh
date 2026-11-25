#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
output=${1:-dist/release}
case "$output" in /*) ;; *) output="$PWD/$output" ;; esac
mkdir -p "$(dirname "$output")"
mkdir "$output" # Do not mix new artifacts with an earlier build.
version=$(node -p 'require("./extension/manifest.json").version')
if [ "$version" != "$(node -p 'require("./package.json").version')" ] ||
   [ "$version" != "$(node -p 'require("./extension/firefox/manifest.template.json").version')" ]; then
  echo 'Chrome, Firefox, and npm versions must match.' >&2
  exit 1
fi
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
cp scripts/install.sh "$output/install.sh"
