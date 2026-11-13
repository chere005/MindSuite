# mind-server

Origin of the shared PHP files (`lib/`: atomic, webauthn, mindsuite-auth, mindsuite-passkeys, mail; `tools/`: their tests and the fake SMTP server); CalMind, PlanMind, TaskMind and seancheren-site carry byte-identical copies as the shared-file manifest lists.
Tests run from CoreMind: `cd CoreMind && npm test` (atomic and mail suites here, the auth suite in `CoreMind/bin/test-mindsuite-auth.php`).
Never deployed from here: each app deploys its own copy.
