/**
 * /ChefMind/sw.js after the app became MealMind: a service worker whose only
 * job is to remove ChefMind's.
 *
 * CalMind's tools/sw-kill.js, changed in one place: it deletes only caches
 * named chefmind-* (ChefMind's id in tools/app-identity.json before the
 * rename). seancheren.com is ONE origin for every app in the suite, so
 * caches.keys() also lists CalMind's, PlanMind's and MealMind's own caches,
 * and the original, which deletes every key, would wipe their offline copies.
 *
 * A browser holding ChefMind's worker fetches this on its next visit to the
 * old path (served no-cache, and never redirected: .htaccess beside it), gets
 * it, deletes the old caches, unregisters, and reloads its open pages. With no
 * worker left, the reload reaches the server and the 302 to /MealMind/.
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.clients.claim()
      .then(() => caches.keys())
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('chefmind-')).map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window' }))
      // Reload what is open, so the page stops being served by a worker that
      // is on its way out and lands on the redirect.
      .then((clients) => clients.forEach((c) => c.navigate(c.url))),
  );
});

// While it is still alive, get out of the way entirely: everything goes to
// the network, so nothing ChefMind's worker cached can be served again.
self.addEventListener('fetch', () => {});
