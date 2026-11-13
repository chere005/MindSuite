<?php
// What PlanMind reads from the site's private config (the site library's config.php, through app_config()). A sample only: never
// loaded, never packaged (tools/package.mjs ships server/public and server/lib alone). The real file lives on the server and changes
// only through the site's own config tool, never by hand and never from this repository.
return [
    // The household's two accounts, by role (server/lib/people.php). Both must be present, distinct, lowercase login names, and
    // neither a role word nor a view name. Without that every planner call is a 503 `unavailable` that writes nothing, the page
    // shows no sign-in form, and the public health answer (api.php?health) says {"peopleConfigured": false}. Stored data (lists,
    // owners, authors, note keys, preferences, CalMind's records-<id>.json) stays keyed by these ids; nothing migrates it.
    'people' => ['owner' => 'alex', 'partner' => 'sam'],
    // Sign-in accounts (bcrypt hashes). PlanMind admits only the two people above, and only when they are configured here.
    'users' => ['alex' => '$2y$10$replace.with.a.real.bcrypt.hash.................', 'sam' => '$2y$10$replace.with.a.real.bcrypt.hash.................'],
    // The household's day: the open to-do cap counts what the Day view carries over to today in this zone.
    'timezone' => 'America/Chicago',
];
