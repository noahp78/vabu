# Store submission

## Listing

**Name:** VABU

**Short description:** Control selected browser tabs from a local command-line tool.

**Description:** VABU connects your browser to a command-line tool on the same computer. Open tabs, inspect pages, interact with controls, and organize tabs in named sessions. On supported browsers, capture viewports and read limited text from eligible frames.

**Requires a separate local installation.** The extension does not include the VABU CLI. Install the matching CLI and native host from [GitHub Releases](https://github.com/noahp78/vabu/releases) using the [setup guide](https://github.com/noahp78/vabu/blob/main/docs/installation.md). VABU supports macOS and Linux with Node.js 22 or newer. Chrome requires version 124 or newer; Firefox requires version 140 or newer. Some Firefox features require version 153 or newer.

While the bridge runs, requested browser data is shared with the local CLI. VABU does not send this data to the developer or automatically forward it to an AI service. Use the extension popup to stop the bridge.

**Privacy policy URL:** https://github.com/noahp78/vabu/blob/main/docs/privacy.md

**Chrome single purpose:** Enable a user-installed local VABU CLI to inspect and interact with explicitly selected website tabs.

## Permission justifications

| Permission | Reason |
| --- | --- |
| `nativeMessaging` | Connect the browser extension to the separately installed VABU native host on the same computer. The companion exposes a user-private Unix socket, not a network listener. |
| `scripting` | Run bundled code to inspect selected documents and interact with their controls. |
| `debugger` (Chrome) | Send tab-scoped input in Chrome, capture the viewport of an owned tab without switching tabs, and handle supported JavaScript dialogs there. The CLI does not expose arbitrary debugger commands. |
| `tabGroups` | Name and color groups for tabs opened by VABU, including named sessions. |
| `storage` | Remember the local socket name, the JavaScript execution mode and, on Chrome, whether the bridge was stopped for the browser session. |
| `webNavigation` | Check document and frame identity and invalidate stale selections after navigation. |
| HTTP(S) host access | Let the CLI open and inspect user-selected HTTP(S) sites, including background tabs, without requiring that a user first click each tab. Browser site-access settings still apply; Chrome requires separate approval for control of pre-existing tabs. |
| Optional all-sites grant (Firefox) | Firefox’s tab-ID capture API requires this for viewport screenshots. It is not granted by the CLI and can be revoked in the popup. |

The browser package contains its own implementation and does not fetch scripts from a server to execute them. Disclose `eval` separately: a local CLI caller can provide an expression for a selected, verified VABU-opened tab in its managed group, subject to the profile’s approval setting and the page’s policy. Store acceptance of this capability has not been verified; confirm it before distribution. Disclose that URLs, page content and website interactions may pass to the local CLI; do not describe it as processing only inside the browser. For AMO, the declared categories are browsing activity, website content, and website activity.

## Build and source submission

From the exact revision being submitted, use Node.js 24 and run:

```sh
node --test tests/*.test.mjs
sh scripts/build.sh dist/store
git archive --format=zip --output=dist/vabu-source.zip HEAD
```

Upload the Chrome ZIP in the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole/). Upload the Firefox ZIP as a listed desktop add-on in the [AMO Developer Hub](https://addons.mozilla.org/developers/). Do not enable Android compatibility: VABU’s native host supports macOS and Linux desktop only. Give AMO the source ZIP and these build instructions: no npm dependencies or build-time downloads are needed; `node extension/firefox/package.mjs` stages the add-on and generates `firefox/content.js` from the checked-in sources. The source ZIP is not the extension upload.

## Reviewer test (macOS or Linux)

No website account or credentials are needed. Use a disposable browser profile and a matching `install.sh` and `noahp78-vabu-<version>.tgz` from the release for the submitted revision.

1. Install the submitted extension. For Chrome, copy the ID of the installed version from `chrome://extensions`; do not use the ID of a developer’s unpacked build.
2. In the folder with the installer and archive, run `sh install.sh CHROME_EXTENSION_ID` for Chrome or `sh install.sh --firefox` for Firefox. In the extension popup, choose **Start local bridge** if it is not already running.
3. In a separate terminal, start this local test page:

   ```sh
   node --input-type=module -e "import { createServer } from 'node:http'; createServer((_, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>VABU fixture</title><h1>VABU fixture</h1><button>Test button</button>'); }).listen(8765, '127.0.0.1')"
   ```

4. Run the commands below. In Firefox, add `--socket firefox-default` immediately after the executable on each line. Use the ID returned by `open`. If the page is still loading, wait until it finishes before retrying `use`.

   ```sh
   ~/.local/bin/vabu status
   ~/.local/bin/vabu open http://127.0.0.1:8765/
   ~/.local/bin/vabu use TAB_ID
   ~/.local/bin/vabu snapshot
   ~/.local/bin/vabu release
   ```

   Expect a connected bridge and a snapshot containing “Test button”. Stop the bridge in the popup, then verify that `status` no longer connects.

Before submitting, capture listing screenshots using this fixture (not a real account), verify the exact upload packages and test the store-installed Chrome ID and signed Firefox build when available. Chrome supports [deferred publishing](https://developer.chrome.com/docs/webstore/publish#deferred-publishing-option) if you want to review the approved build before making it public.
