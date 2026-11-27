# Install and configure

VABU supports Linux and macOS with Node.js 22 or newer. Chrome and Chromium require version 124 or newer. See [Firefox](firefox.md) for version and signing limits. Use a matching release for initial installation. Browser instructions ship with the extension; new browser-side commands need no CLI or native-host update when the bridge protocol and any required client-side options are unchanged.

## Install from a release

Download `install.sh` and `noahp78-vabu-<version>.tgz` from the same [GitHub release](https://github.com/noahp78/vabu/releases) into an otherwise empty directory. Verify the source of both downloads and review the script before running `sh install.sh`; it does not authenticate the archive. It installs the local archive without running npm lifecycle scripts and adds `vabu` to `~/.local/bin`. Add that directory to `PATH` or use the full command path.

The installer prints the unpacked Chrome folder. In `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, select that folder, and copy the extension ID shown. Register the ID and check the bridge:

```sh
vabu setup CHROME_EXTENSION_ID
vabu status
```

On Linux, `vabu setup ID` defaults to Google Chrome. For Chromium or a custom user-data directory, pass `--config-dir /absolute/browser/config-root`, not a profile subdirectory such as `Default`.

For Firefox, download the matching `vabu-firefox-<version>.zip` and load it with **Load Temporary Add-on** in `about:debugging#/runtime/this-firefox`. Run `sh install.sh --firefox` instead of the Chrome setup. Open the popup, click **Start local bridge**, then run `vabu --socket firefox-default status`. The unsigned add-on must be loaded again after Firefox restarts.

## Install from source

For Chrome or Chromium, run `node extension/chrome/package.mjs`, load `dist/chrome/` as described above, then register its exact ID:

```sh
node install.mjs CHROME_EXTENSION_ID
node cli.mjs status
```

The direct `install.mjs` command defaults to Google Chrome on macOS and Chromium on Linux (`${XDG_CONFIG_HOME:-$HOME/.config}/chromium`). Use `--config-dir` for a different browser root. On Linux, Google Chrome typically uses `${XDG_CONFIG_HOME:-$HOME/.config}/google-chrome`.

For Firefox, run `node extension/firefox/package.mjs`, temporarily load `dist/firefox/manifest.json`, and register the bridge with `node install.mjs --firefox`. Firefox requires manual bridge startup. See the [Firefox guide](firefox.md).

On Chrome, open VABU from the Extensions menu. The bridge starts automatically; use **Start local bridge** if the first attempt failed. **Stop local bridge** also suppresses automatic restart for the rest of the Chrome session. The optional Pi [skill](../SKILL.md) is not required for the CLI. It fetches guidance from the loaded extension with `vabu --socket NAME instructions`; you do not need to reinstall it for each browser update. If a bridge does not recognize `instructions`, reload or update that profile’s extension.

## Upgrade or migrate an unpacked installation

If you installed the old release package, stop the bridge and run `npm uninstall --global --prefix "$HOME/.local" @noahp78/vacu` before installing the new archive. Both packages install a `vabu` executable, so remove the old package first to avoid a conflict. Replace `vacu` in scripts with `vabu` and rename any `VACU_SCREENSHOT_*` variables to `VABU_SCREENSHOT_*`. Keep `install.sh` and the archive from the same release; older downloads retain their original filenames.

Upgrading from VACU requires loading the new add-on and re-registering the native host: the host is now `local.vabu`, the Firefox add-on ID is `vabu@local.invalid`, and the CLI uses the named sockets described below. The upgrade does not remove `local.pi_chrome.json` or migrate old extension settings. Keep the old registrations only if you still need the old build.

Chrome derives the ID from the absolute path of an unpacked extension without a manifest key. `extension/` is now a source directory, not a loadable build. `vabu setup` prints a fresh staged directory when the build contents change; repeated setup of the same build returns the same directory.

1. Record the old loaded path and ID from `chrome://extensions`, the browser config root, and any custom socket name or site-access settings. Stop the old bridge and disable the old extension before loading the new build.
2. Load the new staged directory and copy the ID. Register that ID for each browser root you use, even if the ID did not change. Each root's `local.vabu` manifest allows one Chromium ID; changing it affects all profiles using that root. Re-register Firefox too if you upgrade it from a different install location.
3. Reapply your site-access settings and custom socket name, then verify `status`. Remove the disabled old extension only after verification. To roll back, use the old add-on files and installer together; they must still be available at the old paths.

When building from source at an already loaded path, close the browser, move the old build aside, and rebuild at the same absolute path to retain the ID. The packager never overlays an existing directory.

## Use more than one browser or profile

When the bridge is online, its green badge in the VABU popup shows the active socket name. Click the badge to copy the name. Open **Settings** to see and copy the CLI command. Chrome defaults to `chrome-default`; Firefox defaults to `firefox-default`. If you use more than one profile of the same browser, choose distinct names. Stop the bridge on the main popup view, edit and save the name in **Settings**, then go back and start the bridge. Clear the field to restore the default. Names are 1–32 lowercase ASCII letters, digits or hyphens, starting with a letter and ending with a letter or digit.

```sh
vabu status                                  # default Chrome socket
vabu --socket chrome-work status             # custom Chromium profile
vabu --socket firefox-default status         # default Firefox socket
```

Put `--socket NAME` before the command (and before `--session ID` if using a named session). Stopping the bridge releases the selection and invalidates its session IDs and references.

In **Settings → JavaScript execution**, choose whether to disable `eval`, ask each time, or allow it without prompting on eligible VABU-created tabs that are still in their VABU group. This choice is saved per browser profile. Keep the default **Ask every time** if you do not want local callers to run code without explicit approval.

## Transport and troubleshooting

- The CLI and native host use `$XDG_RUNTIME_DIR/vabu/<name>.sock` if `XDG_RUNTIME_DIR` is an absolute path. Otherwise they use `${XDG_CACHE_HOME:-$HOME/.cache}/vabu/<name>.sock`, ignoring relative XDG paths. The runtime root must be owned by you and have mode `0700`; the cache root must be owned by you and not writable by others. The roots and private `vabu` directory must not be symlinks. If the socket pathname is too long, use a shorter name or a shorter compliant XDG path.
- The host inherits the browser process environment. If the popup says connected but the CLI cannot reach it, check that both use the same socket name and have matching runtime/cache paths. A full browser restart may be needed after changing the environment.
- If two bridges use the same socket name, rename one or stop it. After stopping a bridge, give its host a moment to exit. After a crash, remove a matching stale socket only after verifying no process owns it.
- Site access covers HTTP(S) by default, subject to browser grants and tab safeguards. Socket names are not authentication: processes running as your OS user can access any running bridge. Stop bridges when finished and do not grant access to sensitive sites by default.

To uninstall, remove the extension, the corresponding `local.vabu.json` native-host registration (the installer prints the path), and any CLI symlink or optional skill. For a release install, uninstall the npm package with `npm uninstall --global --prefix "$HOME/.local" @noahp78/vabu`. Once no browser uses VABU, you may remove its launcher and staged builds from `${XDG_DATA_HOME:-$HOME/.local/share}/vabu`.
