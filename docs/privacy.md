# VABU privacy policy

VABU is a browser extension and a separate local command-line tool. The developer does not receive your browser data. VABU does not send it to a VABU server, include analytics or advertising, or automatically send it to an AI service.

## What the extension shares

While the bridge is running, VABU passes the information needed to answer commands to the local CLI through Native Messaging and a private Unix socket. Depending on the command, that can include accessible tab URLs and titles, visible text and controls from a selected page, results of clicks or typing, selected viewport images, feedback notes you submit, and (on Chrome) console output or navigation timing you explicitly request. Some URLs include query strings and viewport images can show sensitive or cross-origin content. Avoid granting access to sites or opening pages you do not want to share with the CLI.

A JavaScript expression permitted by your profile’s execution setting runs in the selected site’s page context. The default asks for approval per expression; you can disable execution or allow it without prompting on eligible VABU-created grouped tabs. It can access page data, change site state, or initiate network requests within the browser’s rules. Its result goes to the local CLI. Review the code shown in the popup and do not approve code you do not trust.

The site you visit still receives your normal browsing activity, including actions taken there on your behalf. If a separate tool or agent reads VABU output, that tool may handle or forward it under its own policies. VABU does not control that tool.

## Where the data stays and how to stop sharing

VABU keeps active selections, session IDs, pending JavaScript requests and pending feedback in memory. Screenshot commands can write files to a path you choose or a local temporary directory; delete those files when you no longer need them. Tools calling VABU may independently retain its output. Other processes running as your operating-system user can access the local bridge while it runs.

Use **Stop local bridge** to stop transfers, and use the browser’s extension settings to limit site access or disable the extension. Firefox asks for consent to the declared data categories at install, and its bridge starts only on request. Firefox screenshots additionally require a separate, revocable site grant.

VABU’s use of information received from Google APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies#user-data), including the Limited Use requirements.

For privacy questions, contact the maintainers through the [VABU repository](https://github.com/noahp78/vabu). Do not post private browser data in a public issue.
