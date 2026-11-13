<?php
// What AcctMind's web doorway reads from the site's private config (the site library's config.php, through app_config()). A
// sample only: never loaded, never deployed (deploy.sh ships server/public alone). The real file lives on the server and changes
// only through the site's own config tool, never by hand and never from this repository.
return [
    // The two accounts the ledger belongs to, by role: the same entry PlanMind reads. Under the shared sign-in only these two open
    // the shell; any other signed-in account gets a 403 with a Sign out form. Missing or malformed (not two distinct lowercase
    // login names, or a role word) and the shared doorway serves nothing: a 503. The legacy doorway does not read it.
    'people' => ['owner' => 'alex', 'partner' => 'sam'],
];
