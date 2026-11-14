<?php
/**
 * Sets one person's theme in the scratch site data, the way the site's own themes workbench does, so a screenshot shows
 * the page as that person sees it.
 *
 *   SUITE_DATA_DIR=<scratch> CALMIND_SITE_LIB=<site>/lib php theme.php <user> <midnight|sage|forest|olive>
 */
$lib = rtrim((string) getenv('CALMIND_SITE_LIB'), '/');
require $lib . '/auth.php';
$_SESSION = ['user' => (string) ($argv[1] ?? '')];
exit(theme_set((string) ($argv[2] ?? '')) ? 0 : 1);
