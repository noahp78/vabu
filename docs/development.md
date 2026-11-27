# Development

Use Node.js 24, as in CI. There are no npm dependencies. From the repository root:

```sh
node --test tests/*.test.mjs
node extension/chrome/package.mjs    # dist/chrome/
node extension/firefox/package.mjs   # dist/firefox/
```

The packagers accept one optional output directory. Its parent must exist and the destination must not exist. To test a build without touching an installed extension, pass a new directory and load it into a disposable profile. Never edit or commit generated files under `dist/`.

## Project layout

| Path | Responsibility |
| --- | --- |
| `cli.mjs` | CLI parsing, command output and artifact creation |
| `native.mjs`, `socket.mjs`, `paths.mjs` | Native Messaging, Unix socket transport and private runtime paths |
| `install.mjs` | Per-browser native-host registration |
| `extension/chrome/` | Chromium manifest, background worker and browser-specific adapters |
| `extension/firefox/` | Firefox manifest, background script and generated-content entry point |
| `extension/shared/` | Browser-neutral page operations, popup and icons |
| `extension/stage.mjs` | Explicit build inventory and destination handling |
| `docs/browser-instructions.md` | Source for the guide packaged as `shared/browser-instructions.md` in both builds |
| `tests/` | Node tests, browser mocks and isolated live fixtures |

## Release artifacts

Run `sh scripts/build.sh` to write `dist/release/`, or pass a fresh output directory. The builder requires npm and `zip`, verifies the same version in both manifests and `package.json`, and creates two extension ZIPs, an npm archive and the offline installer. GitHub Actions attaches previews to `main` builds and creates draft releases for matching version tags. Protect `main` and `v*` tags in GitHub and review a draft before publishing it.

See [store submission](store-submission.md) for listing copy, permission justifications, and reviewer instructions.

## Browser validation

For the live Linux Chromium tests, set `VABU_TEST_CHROMIUM` to the absolute path of a Chromium or Chrome binary and run the same suite. The tests stage an extension and create a temporary headless profile, loopback fixture, native host and private socket. A skipped live fixture is not browser verification.

For Firefox, load the staged manifest temporarily in a disposable Developer Edition profile with a disposable HOME, and verify that you can start and stop the actual native bridge from the popup. Use a loopback fixture; see the [Firefox smoke test](firefox.md#live-smoke-test). Keep signed-package installation and older browser versions distinct from development smoke tests.

## Trust boundaries

The native host accepts only the browser-specific extension identity registered by the installer. Keep the Unix socket inside the private runtime directory, verify ownership and modes, and do not put it on a TCP port.

Page operations run against the selected document and must revalidate its tab, origin, identity and permission when a navigation or concurrent browser change could invalidate them. Do not replace an exact document check with tab or frame ID alone. Browser-specific injection and debugger calls should expose narrow operations, not arbitrary CDP. The explicit `eval` command is limited to verified VABU-opened documents in the workspace’s managed groups, subject to the profile’s JavaScript setting and the page’s policy. Privileged capabilities must not adopt tabs that the current bridge/workspace did not open. Keep results bounded and treat page content, logs, and captures as untrusted and potentially sensitive. A screenshot is a separate capability from frame DOM access: it can contain visible cross-origin pixels even when the frame cannot be inspected.
