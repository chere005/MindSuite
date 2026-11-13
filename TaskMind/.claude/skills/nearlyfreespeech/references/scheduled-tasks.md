# Scheduled tasks and daemons

Use the site's **Manage Scheduled Tasks** action for periodic work. The documented minimum interval is ten minutes. Tasks can run as the site owner or `web`; choose the identity whose permissions match the job.

- Use absolute command and file paths. Do not assume an interactive shell's environment or working directory.
- Set an execution bound and coordinate overlapping runs when a job can exceed its interval. Verify completion from recorded outcomes; absent email is not proof of success.
- Output is emailed when possible, with oversized/undeliverable output diverted to `/home/logs`. Exclude credentials and private content from job output.
- Use a daemon only for work that must remain resident or react more frequently. Availability depends on server type and panel configuration; inspect the current site before choosing or changing it. Persistent processes have ongoing resource costs.
- Prefer the application's existing authenticated administration route when work belongs in an HTTP request. Creating a scheduler, daemon or public mutation endpoint is a separate design decision.

Source checked 2026-10-22: [NFSN scheduled tasks](https://faq.nearlyfreespeech.net/section/programming/cron). Confirm current daemon/server-type requirements in the member panel.
