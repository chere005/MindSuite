---
name: nearlyfreespeech
description: Deploy or diagnose a NearlyFreeSpeech.NET site, including filesystem permissions, PHP configuration, managed databases and scheduled tasks.
---

# NearlyFreeSpeech.NET

Read the target repository's deployment instructions and the site's current panel settings. This skill describes the host; it does not authorize a deploy or provide a deployment login.

- Web-served content belongs in `/home/public`. Keep configuration, libraries and data outside it, normally under `/home/protected`. `/home/private` is the SSH user's private home; `/home/conf` contains site configuration.
- PHP's `web` user differs from the SSH login. Diagnose ownership and permissions before changing them. For web-owned data, use an existing authenticated application/administration path or a panel task configured as `web`; do not introduce a temporary public mutation endpoint.
- Use the repository's deployment and server-configuration tools. Preserve live data and non-deployed credentials. FreeBSD userland differs from GNU tools; validate commands on the actual host.
- Select the site's PHP version deliberately. Custom settings use `/home/conf/php.ini`; CLI PHP selection is separate. Check the current realm rather than maintaining a hardcoded version list here.
- Check alias/TLS state in the member panel. Verify the actual HTTPS response after changes; do not assume a successful upload proves the served site changed.

Read [database notes](references/databases.md) for managed MySQL and [scheduled tasks](references/scheduled-tasks.md) for periodic or persistent work.

Host facts checked against the [NFSN FAQ](https://faq.nearlyfreespeech.net/), [database support](https://faq.nearlyfreespeech.net/section/technology/sql) and [PHP CLI selection](https://faq.nearlyfreespeech.net/full/phpversion), 2026-10-22. Recheck the panel and official docs before acting on changeable host behavior.
