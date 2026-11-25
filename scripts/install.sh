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

# Use an adjacent archive for offline installs; otherwise fetch a published release.
cd "$(dirname "$0")"
set_archive() {
  if [ "$#" -eq 1 ] && [ -f "$1" ]; then
    archive=$1
  elif [ "$#" -ne 1 ]; then
    echo 'Keep at most one noahp78-vacu-*.tgz next to install.sh.' >&2
    exit 1
  fi
}
archive=
set_archive ./noahp78-vacu-*.tgz
if [ -z "$archive" ]; then
  temp=$(mktemp -d)
  trap 'rm -rf "$temp"' EXIT
  curl -fsSL 'https://api.github.com/repos/noahp78/vacu/releases?per_page=100' -o "$temp/releases.json"
  url=$(node --input-type=module - "$temp/releases.json" <<'JS'
import { readFileSync } from 'node:fs';
const releases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const packages = releases.filter(({ draft }) => !draft).map((release) => ({
  ...release, asset: release.assets.find(({ name }) => /^noahp78-vacu-[\w.-]+\.tgz$/.test(name)),
})).filter(({ asset }) => asset);
const release = packages.find(({ prerelease }) => !prerelease)
  ?? packages.find(({ tag_name }) => /^preview-[a-f0-9]{40}$/.test(tag_name));
const asset = release?.asset;
if (!asset) {
  console.error('No VACU tarball found. Check https://github.com/noahp78/vacu/releases or build from source.');
  process.exit(1);
}
console.log(`https://github.com/noahp78/vacu/releases/download/${encodeURIComponent(release.tag_name)}/${asset.name}`);
JS
  )
  archive="$temp/${url##*/}"
  printf 'Downloading %s\n' "$url"
  curl -fsSL "$url" -o "$archive"
fi
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
