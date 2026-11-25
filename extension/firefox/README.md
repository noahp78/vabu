# Firefox baseline (staging only)

Build an unpacked staging directory from the repository root. The destination must not exist; do not pass the path of a working extension:

```sh
node extension/firefox/package.mjs /path/to/disposable/vacu-firefox
```

The **root of the staged extension** is `/path/to/disposable/vacu-firefox`, not the source `extension/firefox/` directory. It contains:

| Staged path | Source |
| --- | --- |
| `manifest.json` | `extension/firefox/manifest.template.json` (copied verbatim) |
| `popup.html`, `popup.js`, `domains.js`, `interaction.mjs`, `inspection.mjs`, `scoped-snapshot.mjs`, `find-click.mjs`, `wait.mjs`, `get-element.mjs` | Same names from `extension/` |
| `firefox/background.mjs` | `extension/firefox/background.mjs` |
| `firefox/content.js` | Generated classic isolated-world script: `install` from `content.mjs` plus the shared in-page interaction, inspection, scoped snapshot, text wait, and element read functions; no runtime eval or web-accessible module |

Use the staged root's `manifest.json` when temporarily loading the unpacked add-on into a disposable Firefox Developer Edition profile. For a temporary package, archive the contents of that root with `manifest.json` at the archive root. This is not a signing, publishing, or regular-profile installation workflow. The manifest declares Firefox 128+; only Developer Edition 161.0b5 was exercised here.

## Native transport contract

The fixed add-on ID is `vacu@local.invalid` and the host name is `local.pi_chrome`. The Firefox host registration must use `type: "stdio"` and `allowed_extensions: ["vacu@local.invalid"]`, **not** Chrome's `allowed_origins`. Run `vacu setup --firefox` (or `node install.mjs --firefox` from a checkout) to register the host for the current user. The manifest goes in `~/Library/Application Support/Mozilla/NativeMessagingHosts/` on macOS or `~/.mozilla/native-messaging-hosts/` on Linux. Snap and Flatpak builds are not covered. The existing native host and CLI use the same private socket for both browsers: run only one bridge at a time for a given socket directory. Firefox uses the shared popup to explicitly start and stop the bridge; it does not inherit Chrome's auto-start policy. The badge turns on after the host's readiness response. Do not register a host against a regular profile/HOME for staging validation.

## Capability matrix

| Capability | Firefox baseline |
| --- | --- |
| `status`, `tabs`, `open URL`, `use TAB_ID`, `release` | Available. Opens in the background and does not activate selected tabs, group, rename, or close them. Select once the tab has loaded. |
| HTTP(S) host access | Requested by default, subject to Firefox's grants and restricted-site rules. No incognito, browser UI, URL credentials, or file schemes. `tabs` reports matching browser grants, not whether Firefox will allow injection on every listed site. |
| Virtual cursor | Visible purple pointer with click preview on visible tabs. `release`, navigation, port loss or permission removal end the selection. The browser's hardware pointer does not move. |
| `title`, `snapshot`, `inspect-query`, `inspect-element`, `inspect-wait` | Main document by default; wait supports `visible`, `hidden`, `domcontentloaded`, `load`. Take a fresh snapshot after document changes and use refs from the latest snapshot/query. No browser dialogs. |
| `frames`, `inspect-query` / `inspect-element` / `inspect-wait --frame ID DOCUMENT_ID`, `inspect-click --frame ID DOCUMENT_ID @iREF` | Explicitly scope inspection or a synthetic click to a visible, unsandboxed same-origin HTTP(S) iframe of the selected document. Use the IDs from `frames` and the ref from that exact document's latest query. Re-list and query after navigation. Clicks check coverage through every ancestor without activating the tab; transformed or zoomed frames, protected targets, form actions, downloads, and cross-origin or new-tab links are rejected. |
| `snapshot --within SELECTOR [--role ROLE]` | One unambiguous main-document scope, using bounded tag, ID, class, descendant and child selectors. A successful snapshot replaces the current refs. |
| `find role ROLE --name NAME click` | One exact normalized name match among clickable main-document controls. Rechecks uniqueness and element identity before synthetic click; leaves existing snapshot refs alone. |
| `get text\|href @rN` | Reads rendered text or a same-origin HTTP(S) link URL without credentials from a current, visible snapshot ref. Does not read protected/editable targets. |
| `wait --text TEXT [--timeout MS]` | Waits for text in the selected top document; navigation cancels the wait. |
| `wait --url URL [--timeout MS]` | Observes the exact URL of the same tab after loading, on the selected origin only. Navigation still releases input and snapshot refs; run `use` and take a new snapshot to resume. Cross-origin navigation, lost access, or closing the tab aborts the wait. |
| `move`, `hover`, `click`, `scroll`, `type` and the shared interaction adapter verbs | Guarded synthetic DOM input only; a site can ignore untrusted events. No protected password/file controls, frames, native drag/drop, OS shortcuts, or trusted typing. |
| Screenshots, cross-origin frames, dialog handling, Chrome tab-group/window/session tools, integrations | Explicitly unsupported; no debugger, native capture, or cross-browser fallback. |

Validation used loopback HTTP and HTTPS fixtures and isolated Firefox Developer Edition 161 with a disposable profile and HOME. The toolbar popup started and stopped the actual native host, and the CLI over a private socket opened, selected, inspected and interacted with fixture tabs. HTTPS trusted a test CA only in the disposable Firefox profile. Automatic startup, signing, older Firefox versions, and real-site behavior were not tested.

The parity checks used Developer Edition 161.0 (build `20261118090429`) headless on loopback HTTP, with the staged add-on, disposable profile/HOME, and actual native bridge on a private socket. Scoped refs were read without changing them during find; exactly one synthetic click reached the fixture. Duplicate, partial, protected, replaced, and navigated-away targets did not click. Stale reads and cross-origin links were rejected. A delayed text wait and a same-origin navigation wait matched; a password value timed out, a cross-origin navigation aborted, and input stayed released after navigation. These parity checks did not cover HTTPS, older versions, live sites, or permission revocation in the Firefox UI.
