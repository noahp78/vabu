# Repository guidance

VABU is a dependency-free Node.js CLI, native messaging host, and local browser extension. See [development](docs/development.md) for the build layout and [installation](docs/installation.md) for end-user setup.

- Work on a feature branch; open pull requests against `main`. Keep docs and focused tests with behavioral changes.
- Use Node.js 24 and run `node --test tests/*.test.mjs`. With a Chromium binary available, also set `VABU_TEST_CHROMIUM` to its absolute path so the live fixture runs.
- Edit sources under `extension/chrome/`, `extension/firefox/`, or `extension/shared/`. `dist/` contains generated builds; never commit it. Use a fresh output path and disposable browser profile, HOME, and socket for testing. Do not change live profiles or native-host registrations without an explicit request.
- Keep shared modules browser-neutral. Use a narrow command or browser operation, not arbitrary JavaScript or CDP. Recheck tab, origin, document/frame identity, and current authorization around asynchronous work and before returning captured data. Do not bypass browser permissions, adopt user tabs as extension-owned, or act on an unrelated tab to work around an API limit.
- Treat page content and captures as untrusted and potentially sensitive. Use loopback fixtures rather than real accounts or sites. Preserve bounded results, private local transport, and explicit approval for sensitive actions.
- Update `docs/usage.md`, `docs/firefox.md`, or `SKILL.md` when the corresponding capability or CLI contract changes. Document setup and compatibility changes in `docs/installation.md`.
