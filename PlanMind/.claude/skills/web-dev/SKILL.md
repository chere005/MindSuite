---
name: web-dev
description: Implement or review plain PHP pages and vanilla browser JavaScript, including forms, authentication boundaries and PDO queries.
---

# Plain PHP web work

Follow the target repository's architecture and checks. AgentSuite contains guidance, not the site's application files; names such as `e()`, `store_read()` and `require_login()` refer to helpers only when the target defines them.

- Escape for the output context: HTML text/attributes, JavaScript and URL components need different handling. Sanitize deliberately supported HTML with the project's sanitizer.
- Validate input and authorize the affected resource on every request. Cookie-authenticated writes need the project's CSRF protection; a hidden UI control is not authorization.
- Preserve the existing storage and authentication boundary. Parameterize SQL values and allowlist identifiers. Never interpret failed loads as empty data.
- A write may succeed before its response is lost. Do not automatically replay POSTs as an error fallback. Keep the input available and report uncertainty; use server-supported idempotency when retries are required.
- Run the affected server and browser checks. A PHP HTTP suite does not prove JavaScript interactions work.

Read only what the task needs:

- [PHP](references/php.md): sessions, output contexts, redirects and file updates.
- [JavaScript](references/javascript.md): form submission, request failure and DOM updates.
- [Databases](references/databases.md): PDO, transactions, migrations and engine-specific constraints.

Keep house style in the consumer's instructions. Do not impose procedural pages, inline scripts, a particular login helper or a fixed test command on another project.
