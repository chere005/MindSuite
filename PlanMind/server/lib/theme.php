<?php
declare(strict_types=1);
namespace PlanMind;

/**
 * The setTheme action: the person's color theme. It does not touch the planner store. The theme is the account library's
 * own per-user preference (theme_set() / theme_get(), the prefs file CalMind and the rest of the suite read), so a pick here
 * is the pick everywhere and a reload of the page (api.php's GET carries theme_get()) shows it.
 *
 * The account library is passed in, so the case file can try the real one and a failing one: `$themes` is the list of theme
 * names it knows, `$set` writes a name and `$get` reads the stored one back. theme_set() cannot be trusted to say whether
 * the file was written (store_write() returns nothing and ignores a failed write), so the answer is the read-back: the
 * theme is only claimed saved when the stored theme is the one asked for.
 *
 * @param callable(string): mixed $set
 * @param callable(): string $get
 * @return array{theme: string}
 */
function op_set_theme(array $input, string $user, array $themes, callable $set, callable $get): array {
    if (!in_array($user, pm_person_lists(), true)) { throw new RequestError('Access denied.', 403, 'forbidden'); }
    $name = $input['theme'] ?? null;
    if (!is_string($name) || !in_array($name, $themes, true)) { throw new RequestError('That is not one of the themes.', 400, 'invalid'); }
    // A warning from a failed write (full disk, read-only directory) is a failure here, not noise on the response.
    set_error_handler(static function (int $level, string $message): bool { throw new \ErrorException($message, 0, $level); });
    try { $set($name); $saved = $get() === $name; }
    catch (\Throwable $e) { error_log('PlanMind theme write failed: ' . get_class($e)); $saved = false; }
    finally { restore_error_handler(); }
    if (!$saved) { throw new RequestError('Your theme could not be saved.', 503, 'unavailable'); }
    return ['theme' => $name];
}
