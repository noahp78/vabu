# Firefox

Build an unpacked staging directory from the repository root:

```sh
node extension/firefox/package.mjs                                  # dist/firefox/
node extension/firefox/package.mjs /path/to/disposable/vabu-firefox # optional custom output
```

The destination must not exist. The **root of the staged extension** is `dist/firefox/` (or the custom output), not the source `extension/firefox/` directory. It contains:

| Staged path | Source |
| --- | --- |
| `manifest.json` | `extension/firefox/manifest.json` (copied verbatim) |
| `shared/` | Runtime modules, popup, SVG logo and PNG toolbar icons from `extension/shared/`, plus the packaged [browser instructions](browser-instructions.md) |
| `firefox/background.mjs`, `firefox/frame-read.mjs` | Same names from `extension/firefox/` |
| `firefox/content.js` | Generated classic isolated-world script: `install` from `content.mjs` plus the shared in-page interaction, inspection, scoped snapshot, text wait, and element read functions; no runtime eval or web-accessible module |

Use the staged root's `manifest.json` when temporarily loading the unpacked add-on into a disposable Firefox Developer Edition profile. For a temporary package, archive the contents of that root with `manifest.json` at the archive root. This is not a signing, publishing, or regular-profile installation workflow. The manifest requires Firefox 140+ for Firefox’s built-in data consent. VABU declares browsing activity, website content and website activity because requested data is passed to the local CLI. The bridge starts only when you choose **Start local bridge**; you can stop it from the same popup. Iframe reads and screenshots require the document verification APIs added in Firefox 153; older versions do not get a fallback. See [development](development.md) for test guidance.

## Native transport contract

The fixed add-on ID is `vabu@local.invalid` and the host name is `local.vabu`. The Firefox host registration must use `type: "stdio"` and `allowed_extensions: ["vabu@local.invalid"]`, **not** Chrome's `allowed_origins`. Run `node install.mjs --firefox` from the checkout to register it in `~/.mozilla/native-messaging-hosts/` on Linux or `~/Library/Application Support/Mozilla/NativeMessagingHosts/` on macOS. The installer prints the manifest path. See [installation](installation.md) for launcher and runtime paths and keeping the browser and CLI environments in sync. The native host and CLI share the same private Unix socket scheme across browsers. Firefox defaults to `firefox-default`, so use `vabu --socket firefox-default status`. To run more than one Firefox profile, stop the bridge and save a distinct socket name per profile (for example, `firefox-adwise`). The popup’s **Settings** view shows the effective name and CLI command. See the [installation guide](installation.md#use-more-than-one-browser-or-profile) for reconnect and collision guidance. Firefox uses the shared popup to explicitly start and stop the bridge; it does not inherit Chrome's auto-start policy. The green dot appears after the host's readiness response. Do not register a host against a regular profile/HOME for staging validation.

## Capability matrix

| Capability | Firefox baseline |
| --- | --- |
| `status`, `tabs`, `open URL`, `use TAB_ID`, `release` | Available. Opens an inactive tab in an existing normal, non-private window. Regular opens are grouped in a purple VABU group in the workspace's chosen window when supported; grouping failures or unavailable APIs return `group: null`. Existing tabs are not grouped or activated. Select once the tab has loaded and Firefox has granted site access. |
| `tab-navigate TAB_ID URL`, `tab-show TAB_ID`, `tab-close TAB_ID` | Navigate in place, show, or close one eligible VABU-owned tab in the matching workspace. See below for safeguards. |
| `session-start NAME`, `session-list`, `--session ID open/tabs/use/tab-navigate/tab-show/tab-close/status/session-status/session-end` | Named sessions are available and bridge-local. Scoped `release` and existing Firefox page commands use only that session's selection. See below for ownership and grouping. |
| HTTP(S) host access | Requested by default, subject to Firefox's grants and restricted-site rules. No incognito, browser UI, URL credentials, or file schemes. `tabs` reports matching browser grants, not whether Firefox will allow injection on every listed site. |
| Virtual cursor | Visible purple pointer with click preview on visible tabs. `release`, navigation, port loss or permission removal end the selection. The browser's hardware pointer does not move. |
| `eval EXPRESSION` | Firefox 153+ only, in a VABU-created tab that is still in its VABU group. The profile’s JavaScript execution setting controls approval. Page policy can block execution. See [JavaScript expressions](usage.md#javascript-expressions). |
| `get styles @iREF` | Firefox 153+ only. Read-only computed styles for a fresh main-document inspection ref in a VABU-created tab that is still in its VABU group. See [computed styles](usage.md#computed-styles). |
| `js timing` | Firefox 153+ only. Reads navigation timing from the verified main document of a VABU-opened tab. No `eval` approval needed. Console recording is not available. |
| `url`, `tab-info` | Read the verified selection’s URL or `{ tab, origin, window, active }` without changing focus or granting control. |
| `title`, `snapshot`, `inspect-query`, `inspect-element`, `inspect-wait` | Main document only; wait supports `visible`, `hidden`, `domcontentloaded`, `load`. Take a fresh snapshot after document changes and use refs from the latest snapshot/query. `inspect-*` can also target a verified direct same-origin iframe via `--frame FRAME_ID DOCUMENT_ID` on Firefox 153+. These commands cannot access browser dialogs. |
| `snapshot --within SELECTOR [--role ROLE]` | One unambiguous main-document scope, using bounded tag, ID, class, descendant and child selectors. A successful snapshot replaces the current refs. |
| `find role ROLE --name NAME click` | One exact normalized name match among clickable main-document controls. Rechecks uniqueness and element identity before synthetic click; leaves existing snapshot refs alone. |
| `get text\|href @rN` | Reads rendered text or a same-origin HTTP(S) link URL without credentials from a current, visible snapshot ref. Does not read protected/editable targets. |
| `wait --text TEXT [--timeout MS]` | Waits for text in the selected top document; navigation cancels the wait. |
| `wait --url URL [--timeout MS]` | Observes the exact URL of the same tab after loading, on the selected origin only. Navigation still releases input and snapshot refs; run `use` and take a new snapshot to resume. Cross-origin navigation, lost access, or closing the tab aborts the wait. |
| `move`, `hover`, `click`, `scroll`, `type` and the shared interaction adapter verbs | Guarded synthetic DOM input only; a site can ignore untrusted events. No protected file controls, frames, native drag/drop, OS shortcuts, or trusted typing. |
| `frame-list`, `frame-read FRAME_ID` | Direct iframe text on Firefox 153+ in the selected VABU-opened tab, in its owning bridge/workspace only. See below. |
| `screenshot [NEW_FILE.png\|jpg]` | Selected VABU-opened HTTP(S) viewport on Firefox 153+, with explicit optional all-sites access. See below. |
| Page feedback | Annotate and submit comments on an active HTTP(S) page with site access on Firefox 153+. See [page feedback](usage.md#page-feedback). |
| `frames`, `inspect-click --frame FRAME_ID DOCUMENT_ID REF` | Verified direct same-origin iframes on Firefox 153+ in an owned tab. Use a fresh inspection ref. Clicks are synthetic. |
| JavaScript dialogs | Not supported. |
| Chrome tab-group/window tools, session handoff/restore/result/audit, integrations | Not provided by this Firefox baseline. |

## Direct iframe text

`open` and then `use` the loaded tab. Run `frame-list` for an array of `{id, origin}` and `frame-read ID` for `{text, truncated}`. For named sessions, pass `--session ID` to all four commands. Existing tabs selected with `use` are not eligible, even if their sites are granted. The tab need not become active.

Both the parent and iframe need Firefox host grants; restricted pages still cannot be injected. Firefox's `webNavigation` permission supplies frame and navigation metadata. The add-on uses it to invalidate selections/handles and to check the current frame slot, document ID and parent document ID. The content port and isolated scripts are bound to exact document IDs, and injection results must report the expected IDs. Firefox does not expose Chrome's frame type/lifecycle fields or reliable `errorOccurred` metadata. The probes instead verify light-DOM iframe ownership from the current top document and check the child's origin, ancestor origin, URL and completed HTML document before and after reading. There is no frame-ID-only or same-origin DOM fallback. Unsupported ownership layouts (such as shadow-tree iframes) fail closed; nested, opaque-origin and ungranted children are not listed.

IDs are opaque, not browser frame IDs or URLs. A new list, selection change, navigation transition (including same-URL reload and history changes), permission removal, or bridge stop invalidates old IDs. Run `frame-list` again after a stale result; if the top document changed, `use` it again first. Reads are bounded to 4,000 characters and omit protected subtrees such as forms, editables, hidden content and embedded documents. This is not a general frame DOM, snapshot, or selector API.

## Viewport screenshots

In the Firefox VABU popup, open **Settings** and click **Enable screenshots**. The popup closes so you can approve Firefox's prompt. The optional `<all_urls>` grant expands origin access for the entire add-on, including eligible non-HTTP(S) schemes, not just one capture or tab. The existing HTTP(S) grants do not unlock Firefox's capture API. Click **Revoke screenshot access** in the same settings view to remove the grant; stopping the bridge does not remove it. Neither opening the popup nor running any CLI command prompts for this grant.

After `open URL` and `use TAB_ID` on the loaded tab, run `vabu --socket firefox-default screenshot NEW_FILE.jpg`. Use the same `--session ID` for all three commands if in a named workspace. The CLI writes a new private PNG or JPEG and refuses to overwrite existing files. The viewport includes visible cross-origin iframe pixels; this does not authorize iframe DOM reads. Do not capture or share sensitive views.

VABU checks bridge/workspace ownership, selection, site authorization and the exact loaded HTTP(S) root document before and after [`tabs.captureTab(tabId)`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureTab). Firefox targets a tab, not a document atomically: VABU discards results on detected invalidation, including transient root navigation or permission loss reported during verification. Reselect after navigation or revocation. If secure checks or tab-ID capture are unavailable, it fails closed; it never switches tabs or falls back to `captureVisibleTab`.

## JavaScript dialogs

Firefox WebExtensions cannot observe or respond to browser-managed `alert`, `confirm`, `prompt`, or `beforeunload` dialogs. Handle them yourself in the browser. Page-controlled HTML `<dialog>` elements are different.

## Named sessions

`session-start NAME` returns a `sessionId`. Use `--session ID` with `open`, `tabs`, `use`, `tab-navigate`, `tab-show`, `tab-close`, `status`, `session-status`, `release`, `session-end`, and supported page commands. Scoped `tabs` lists only tabs opened by that session that still pass Firefox's site-access checks. Regular `tabs` still lists granted tabs, but regular `use` cannot select a tab owned by a live named session. A named session cannot adopt existing or other sessions' tabs. Firefox's site grants, restricted-page rules and document checks still apply; there is no new approval prompt or permission.

The first `open` pins each workspace, including the unscoped workspace, to its chosen normal window for the bridge/session lifetime. If the window disappears, the next open chooses the last focused normal window again. Opens remain in the background by default; a named session is recommended per task.

Keep tabs for separate purposes (for example, storefront and CMS), and follow links within each tab. Use `tab-navigate TAB_ID URL` for a known HTTP(S) destination in an owned tab without opening or activating it. Both source and destination need Firefox site access. `{ tab, requested: true }` confirms only the request. If the tab was selected, control is released; run `use TAB_ID` again when the destination has loaded and verify it with a fresh snapshot.

Use `tab-show TAB_ID` to focus the window and activate an eligible tab without changing the automation selection. Its `{ tab, window, active, focused }` response reports observed state; report if focus was not granted. Use `tab-close TAB_ID` to close one unused eligible tab; success returns `{ tab, closed: true }`. Closing refuses active or pinned tabs and checks that another tab remains. Avoid cleanup while tabs in that window are being closed or moved. All three commands require a VABU-created tab in the current bridge and matching workspace, in a normal non-private window with site access. `tab-show` never waits for the load to finish. `tab-close` and `tab-navigate` accept `--wait-load` to wait up to five seconds for the current page; by default they can act while the committed page is still loading. They do not replace a pending URL change reported by the browser. Failures may require manual action. Before `session-end`, close unused owned tabs when appropriate, preserving the result, questionable tabs and user tabs; there is no bulk cleanup.

Only one tab is controlled across the whole bridge. Switching selection disconnects the previous document, without activating either tab. Navigation or permission loss still releases control; use the tab again once loaded and take a fresh snapshot. `session-end` releases only that session's selection and forgets its ID. It leaves tabs and groups in place, and the tabs can be selected normally again if granted. Stopping the bridge forgets all session IDs.

When Firefox exposes the grouping APIs, named opens use a separate purple group titled with the session name in the chosen window. VABU reuses only a tracked group with the expected title and exclusively owned members; otherwise it creates a new group without modifying the old one. With no grouping APIs, `open` returns `group: null`. If grouping throws, the error includes the already-opened tab ID; the tab still belongs to the session.

### Live smoke test

Stage and load the add-on in a disposable Developer Edition profile/HOME, register the native host in that disposable HOME, grant access to a loopback HTTP fixture, and start the bridge from the popup. Use a normal Firefox window and keep an unrelated tab active. Substitute the returned session and tab IDs:

```sh
ff() { node cli.mjs --socket firefox-default "$@"; }
ff session-start Checkout                       # A
ff session-start Catalog                        # B
ff session-list
ff --session A open http://localhost:8000/       # TAB_A; open again to check group reuse
ff --session B open http://localhost:8000/       # TAB_B
ff --session A tabs
ff --session A use TAB_A                        # once loaded
ff --session A snapshot
ff --session A status
ff --session B use TAB_A                        # must fail; unscoped use TAB_A must also fail
ff --session B use TAB_B
ff --session A session-status                   # tab: null; scoped snapshot must fail
ff --session B session-end
```

Check that the groups are separately named and purple, the active tab never changes, and ending B leaves its tabs and group in place. For a navigation check, reselect A's tab, reload it in Firefox, then verify its `session-status` reports `tab: null` and `snapshot` fails until you run `use` again.
