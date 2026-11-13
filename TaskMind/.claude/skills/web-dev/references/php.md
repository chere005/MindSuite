# PHP boundaries

Use the target application's helpers for session startup, authorization, storage and HTML sanitization.

- Start sessions before output. Regenerate the session ID on authentication/privilege changes. Configure `Secure`, `HttpOnly` and a suitable `SameSite` policy. Cookie lifetime and server-side session retention are separate settings.
- Check request field types before coercing them; an attacker can send an array where a string is expected. Validate the allowed shape and resource ownership.
- For normal forms, use POST/redirect/GET: `header('Location: '.$validatedLocalUrl, true, 303); exit;`. AJAX handlers return the documented status and JSON shape. Validate redirect destinations.
- Escape HTML text and quoted attributes with `htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8')`. Use the project's sanitizer for intentionally supported markup.
- When embedding JSON in an HTML script element, use `json_encode($value, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_THROW_ON_ERROR)`. Do not interpolate strings into JavaScript source.
- URL-encode individual query/path components rather than an entire URL. Avoid shelling out with request values; if necessary, use an argument-based process API.
- Decode stored JSON with an explicit error path, such as `JSON_THROW_ON_ERROR`. A corrupt store must not become an empty store that a later save overwrites.
- For file storage, validate identifiers before mapping them to paths. Hold a stable lock across the complete read/modify/write operation, write a temporary file in the same directory, then rename. Locking a file that is replaced by rename does not coordinate later writers; use the application's established locking protocol.
- Keep production errors in server logs, with credentials and private content excluded. Return an appropriate status and a useful public error.

Authoritative references: [PHP sessions](https://www.php.net/manual/en/features.session.security.management.php), [HTML escaping](https://www.php.net/manual/en/function.htmlspecialchars.php), [JSON encoding](https://www.php.net/manual/en/function.json-encode.php), [file locks](https://www.php.net/manual/en/function.flock.php). Consult the deployed PHP version's manual for version-dependent behavior.
