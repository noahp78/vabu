# VACU — Virtual Agentic Chrome User

A local browser extension and Node.js CLI for Chrome and Firefox. It uses Native Messaging and a user-private Unix socket; Chrome additionally uses `chrome.debugger`. No ChatGPT extension, MCP server, TCP listener or remote-debugging port is required. Native-host registration currently targets macOS.

## Setup

1. Clone the repository. In Chrome go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension/` folder in the clone. Copy the new extension ID.
2. In Terminal, register that exact ID:

   ```sh
   node install.mjs CHROME_EXTENSION_ID
   ```

3. After registering the native host, open **VACU** from the Chrome Extensions menu to check bridge status. Chrome starts the bridge automatically; use **Start local bridge** if the host was registered after the first attempt. There is no per-domain approval in the popup; Chrome’s HTTP(S) site access settings still apply.
4. Run `node cli.mjs status` from the clone. If you want the `vacu` command, symlink `cli.mjs` into a directory on your `PATH` under that name. Pi users can additionally install `SKILL.md` as a skill; it is not required for the CLI.

**Stop local bridge** disconnects VACU and suppresses automatic restart for the rest of the Chrome session, even if the extension worker restarts. **Start local bridge** resumes it. You do not need to re-register a native host when updating with the same extension ID.

For the staged Firefox build, see [Firefox packaging and capability limits](extension/firefox/README.md). Firefox currently requires manual bridge startup. Chrome and Firefox share one private socket per user, so run only one bridge at a time.

Upgrading from Pi Chrome: keep the same unpacked extension path and native host. The Chrome extension ID stays the same; Chrome may ask you to approve the expanded site access. `pi-chrome` still works as an alias for `vacu`.

## Build and test

No npm dependencies are required. Run `node --test tests/*.test.mjs` from the clone. Chrome loads `extension/` directly; for Firefox, build an unpacked directory with `node extension/firefox/package.mjs dist/firefox` after creating `dist/`. For Firefox native registration, use `node install.mjs --firefox`. See the [Firefox guide](extension/firefox/README.md) for testing and limitations.

## Example

```sh
node cli.mjs status
node cli.mjs tabs
node cli.mjs open https://github.com/
node cli.mjs use TAB_ID
node cli.mjs snapshot
node cli.mjs click @r1
node cli.mjs release
```

`open` creates a background tab without changing your selection. Run `use TAB_ID` with the returned ID before `wait`, `snapshot` or other page commands. Use the actual tab ID from `tabs` or `open`, and use only refs from the latest snapshot. VACU does not activate tabs for `click` or `find … click`. On Chrome, a background click uses a guarded synthetic click (`trusted: false`), so sites that require trusted input may ignore it. Some actions, such as links targeting a new tab, require you to select the tab manually first. `dispatched: true` means the mouse events were sent, not that a site navigated. Use a fresh `snapshot` to verify the result. The CLI does not move the hardware pointer. Chrome shows its own debug banner while a tab is selected. Website behaviour can still open a dialog or switch/open a tab. Tabs opened by Pi are placed in a purple **VACU** group. While Pi controls one, the group label changes to **VACU actief**. Existing user tabs and tab groups stay in place; for those tabs Pi temporarily prefixes the title with **🟣 VACU actief** (not visible on pinned tabs). `move`, `hover @rN`, and `click` show the purple virtual pointer in the page. For Chrome’s `click`, the cursor animates only if the tab was already active and the page has focus, unless reduced motion is enabled. Otherwise it jumps to the target without an animation delay. A click is cancelled if the target changed. `scroll DY [@rN]` sends a wheel event over a control or at the cursor, so it also works inside scrollable panels. `release` resets the label or title and removes the pointer, but leaves the tab group and tabs in place. If Chrome forcibly unloads the extension, reload an affected page or rename a leftover group manually. The first version handles main-frame content, not frames, file uploads, password entry, browser UI or incognito. A cross-origin navigation releases the selected tab; select it again only if Chrome grants access to the new site.

For named sessions, the agent chooses a short, descriptive name without asking the user, then runs `vacu session-start 'Checkout testen'` and retain the returned `sessionId`. Run `vacu --session ID open URL`, `vacu --session ID use TAB_ID` and `vacu --session ID snapshot`. New tabs join that session’s named purple group in their window. Multiple sessions can stay open, but only one tab is controlled at a time: after switching, run `use` and `snapshot` again. `vacu session-list` lists IDs; `vacu --session ID session-end` forgets the session without closing tabs or changing groups. IDs only last while the bridge runs. VACU shows the virtual cursor as soon as it selects a tab. In named groups, VACU temporarily prefixes the controlled tab’s title with **🟣 VACU actief**. Favicon marking is not supported: Chrome for Testing kept reporting the original icon with both tested approaches.

VACU emits compact JSON by default, without dropping any fields. Use `vacu --pretty snapshot` for indented JSON, or `vacu snapshot --brief` for a short preview (up to 480 characters and 20 `[ref, role, name]` rows). To search controls with clickable refs, use `vacu snapshot --find 'winkelwagen'`. This matches a literal substring of the control name (case-insensitive, whitespace normalized), returns at most 20 matches from the regular snapshot, and does not print the page text. For alternatives or anchors, use `vacu snapshot --regex '^(bestel|toevoegen)'` (case-insensitive Unicode regex, without `/` delimiters). Use `vacu snapshot --role input` for input elements or combine filters, e.g. `vacu snapshot --role button --regex '^(bestel|toevoegen)'`. Role matching is exact (e.g. `input`, `textarea`, `select`, `button`, `a`, or an explicit ARIA role). `count: 0` only means no match among the captured controls. For a known target, `vacu inspect-query --brief LOCATOR_JSON` shows up to 10 `[ref, role, name, visible, enabled]` rows and the match count. Inspection refs are not click refs. `truncated` flags omissions; for snapshots they describe the brief view relative to the already bounded full snapshot. Use the full command if a preview omits what you need. With named sessions, put `--pretty` before `--session ID` and `--brief` after the command name. These options reduce CLI output, not bridge traffic, and do not change how refs are assigned or how errors are reported.

Chrome and Firefox support `snapshot --within main --role link` (restricted CSS, exactly one section, filters before the capture limit), `find role button --name 'In winkelwagen' click` (exact name, must match once), `get text @r1` / `get href @r1` (latest snapshot, bounded text or same-origin HTTP(S) link), and `wait --url URL` / `wait --text TEXT` (default 5 seconds, `--timeout MS` up to 15 seconds). URL waits use an exact same-origin URL; text waits stay in the selected document. Chrome’s user-tab approval still expires on a full navigation: select and approve the new document before continuing. In Firefox, a URL wait can observe same-origin navigation but does not preserve input authority. A direct `find … click` replaces the current refs, and dispatch does not guarantee navigation. Firefox’s direct click is synthetic; sites can ignore untrusted events.

In this staging copy, use `node cli.mjs help` for the new commands. Interaction adapters dispatch synthetic events to the approved main document; browser shortcuts, trusted typing and native drag-and-drop are not provided. Chrome and Firefox can inspect and click visible, unsandboxed same-origin iframes. Run `vacu frames`, then `vacu inspect-query --frame ID DOCUMENT_ID LOCATOR_JSON` and `vacu inspect-click --frame ID DOCUMENT_ID @iREF`. Use the returned `@i` ref only for that frame and document. Clicks are synthetic and never activate the tab; form submissions, new-tab links and cross-origin links are not supported. Re-run `frames` and query after navigation. Chrome can also inspect cross-origin HTTP(S) frames when it can verify the document chain and has every required host grant. Cross-origin clicks, frame typing and coordinate input are not supported.

For inspection, pass a typed JSON locator such as `'{"all":[{"by":"role","value":"button"}]}'` or CSS shorthand such as `vacu inspect-query --brief '{"css":"[data-ctp-configurator] input[type=radio][name^=bundle_option]"}'` (`selector` is an alias for `css`). CSS supports tags, IDs, classes, descendant/child combinators, `[data-*]` presence and input type/name-prefix matching with simple tokens. Arbitrary attribute values and pseudo-classes are not supported. Adapter commands reject stale documents. Session markers and audit are in memory; manual approval and handoff UI for file, clipboard and sign-in actions are not connected. No file, incognito, or browser-internal page permissions are added.

## Screenshots (Chrome)

`vacu screenshot [SELECTOR] [PATH]` saves a PNG or JPEG of the selected tab. It takes the same options as `agent-browser screenshot`:

```sh
vacu screenshot                          # viewport, saved to a temporary directory
vacu screenshot ./page.png               # viewport, saved to ./page.png
vacu screenshot --full ./full-page.jpg   # full page; format follows the extension
vacu screenshot @r3 ./button.png         # one control from the latest snapshot
vacu screenshot '.hero' ./hero.png       # one element (restricted CSS, must match exactly one visible element)
vacu screenshot --annotate ./page.png    # takes a new snapshot and labels each control [N] = @rN
vacu screenshot --if-changed             # don't write a file if nothing changed since the last capture
vacu screenshot --threshold 0.01         # treat up to 1% changed pixels as unchanged (implies --if-changed)
vacu screenshot --screenshot-dir ./shots --screenshot-format jpeg --screenshot-quality 70
```

Without `PATH`, files go to `--screenshot-dir`, `VACU_SCREENSHOT_DIR`, or `vacu-screenshots` in the system temp directory. `VACU_SCREENSHOT_FORMAT` and `VACU_SCREENSHOT_QUALITY` set defaults. Output is JSON: `path`, `format`, `annotations` (with `--annotate`), `clipped` (full pages are capped at 16384 CSS pixels per side) and `changedRatio`/`unchanged` (with `--if-changed`). `--json` is accepted for compatibility. Files are written with mode 0600, and an existing `PATH` is overwritten.

Capture uses `Page.captureScreenshot` through the already-attached debugger, so background tabs are captured without being activated. The virtual cursor is hidden while capturing. Because a raster image includes every frame on the page, VACU lists all frames before and after the capture. It refuses if any frame is not an HTTP(S) document Chrome grants VACU access to (or an inherited `about:blank`/`about:srcdoc` frame). It discards the image if any frame document changed during capture. `data:`, extension (such as the PDF viewer) and other non-web frames therefore block screenshots of that page. `--if-changed` keeps the last image per tab in extension memory only. Firefox does not support `screenshot` yet.

By default, access covers all HTTP(S) domains, including subdomains and localhost. The socket is only accessible to processes running as your user (or with OS privileges). A local process running as you could control any web tab Chrome grants VACU access to while the bridge is running. Stop the bridge when finished. Page content and screenshots can contain private information; don't publish them or authorize access to sensitive sites by default.

If the extension reports a socket already in use, stop other VACU bridges first. After a crash, if no bridge is running, remove stale `~/.pi-chrome/chrome.sock` and try again. To uninstall, remove the unpacked extension, its host manifest (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/local.pi_chrome.json`), the CLI symlink, and the Pi skill.
