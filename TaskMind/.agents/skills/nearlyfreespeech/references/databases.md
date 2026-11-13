# Managed databases on NearlyFreeSpeech

The documented managed product is MySQL/MariaDB, separate from the website. The host documentation reviewed here does not establish managed PostgreSQL support; do not promise it or invent panel setup steps. SQLite is available as a file-based option when the application's locking and storage requirements fit.

- Create the managed process through the member panel. Use its connection hostname/DSN; `localhost` points at the web process's host, not the database process.
- Create a least-privilege application user. Do not put the database administrator credentials in the application. Keep credentials outside the public web root and tracked files.
- Managed database processes use private addresses. SSH port forwarding is permitted for interactive setup/administration, not automated application access; check the host's current restrictions before arranging access.
- Test backup and restore using the current engine's dump tools. Protect dumps as sensitive data. Before removing a database process, verify a recoverable export and confirm the deletion is authorized.
- Check current pricing before adding or removing a process. File-based storage still consumes storage resources; it is not a reason to describe hosting as free.

For application queries see [PDO guidance](../../web-dev/references/databases.md).

Sources checked 2026-10-22: [database support](https://faq.nearlyfreespeech.net/section/technology/sql), [MySQL administration and access](https://faq.nearlyfreespeech.net/section/mysql/-).
