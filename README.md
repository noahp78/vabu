# VABU — Virtual Agentic Browser User

VABU connects a local CLI to Chrome, Chromium or Firefox. Open and inspect tabs, interact with page controls, and keep tasks in separate named sessions. The bridge uses browser Native Messaging and a user-private Unix socket, not a TCP listener or a remote debugger.

## Get started

1. Follow the [installation guide](docs/installation.md) to load the extension and register the native host on Linux or macOS.
2. Open the VABU popup to check the connection. On Firefox, click **Start local bridge**.
3. From the checkout, run `node cli.mjs status` for Chrome or `node cli.mjs --socket firefox-default status` for Firefox. The popup shows the command for your profile.

Only select pages you want the CLI to access. Other processes running as your OS user can access a running bridge. Stop it from the popup when you are finished.

## Documentation

- [Installation, upgrades and multiple profiles](docs/installation.md)
- [Browser commands and capability limits](docs/usage.md)
- [Firefox setup, permissions and differences](docs/firefox.md)
- [Privacy and local data handling](docs/privacy.md)
- [Development, architecture and testing](docs/development.md)
- [Repository guidance for agents](AGENTS.md) and [optional Pi browser skill](SKILL.md)
