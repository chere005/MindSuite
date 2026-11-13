# Browser requests and DOM updates

Render untrusted text with `textContent`. Use the project's HTML sanitizer when markup is required. Event delegation can simplify dynamic lists; ensure the matched control belongs to the intended container. Removed nodes can be garbage-collected; per-node listeners are not inherently a leak.

## Form example

Keep a working plain form as the baseline. Once JavaScript intercepts a write, an error response is not proof the write was rejected. This example retains input and reports an unconfirmed outcome without submitting again:

```js
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (form.dataset.saving) return;
  const body = new FormData(form); // includes the existing CSRF field
  const button = event.submitter;
  if (button?.name) body.append(button.name, button.value);
  form.dataset.saving = '1';
  if (button) button.disabled = true;
  try {
    const response = await fetch(form.action, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      body,
    });
    if (!response.ok) throw new Error('Save not confirmed');
    const state = await response.json();
    render(state); // validate the application's response shape here
    showStatus('Saved.');
  } catch {
    showStatus('Save not confirmed. Check the current state before retrying.');
  } finally {
    delete form.dataset.saving;
    if (button) button.disabled = false;
  }
});
```

`render` and `showStatus` are application functions. Production code should distinguish confirmed validation failures from uncertain network/server outcomes. Use a server-enforced idempotency key when a mutation must be retryable. An abort cancels the client's wait, not necessarily the server's write.

For reads, ignore stale responses or cancel superseded requests. For local storage, namespace keys and handle parse/storage exceptions; it is never an authorization boundary. Reuse the consumer's PWA navigation and safe-area behavior when that surface exists.

Sources: [HTTP idempotency](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2), [Fetch error handling](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch), [FormData](https://developer.mozilla.org/en-US/docs/Web/API/FormData/FormData).
