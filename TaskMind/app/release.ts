/** The shape of a stamp, as the host gives a release directory its name. Anything else (no header, a host error page, a garbled value) is not one. */
export const STAMP = /^\d{14}-\d+$/;

/**
 * Tells an open page that the host now serves another release than the one the page started under, so it can load the new
 * app at a quiet moment instead of staying on old code (and an old idea of the data) until someone happens to reload.
 * - The first stamp seen is the page's own release; a response without a stamp (the local preview, a 503 from the host) says nothing.
 * - `changed` compares the latest stamp with the first, so a deploy that is rolled back while the page watches (A, B, A) needs no reload.
 * Nothing here touches the DOM, the clock or browser storage.
 */
export function createReleaseWatch() {
  let first: string | null = null, latest: string | null = null;
  return {
    /** The stamp a response carried, or null/empty when it had none. */
    see(stamp: string | null | undefined): void {
      if (typeof stamp !== 'string' || !STAMP.test(stamp)) { return; }
      first ??= stamp;
      latest = stamp;
    },
    /** Whether the latest stamp is not the one the page first saw. */
    get changed(): boolean { return first !== null && latest !== first; },
  };
}
export type ReleaseWatch = ReturnType<typeof createReleaseWatch>;
