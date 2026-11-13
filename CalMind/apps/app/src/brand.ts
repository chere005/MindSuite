/**
 * The app's display name and mark colour, for the few places that say them.
 *
 * Read from this app's own app.json rather than written into each screen, so
 * the screens that use them are the same bytes in every app that carries them.
 * `expo.name` ("CalMind", "ChefMind") is the name the app is built and
 * installed under, and the one the shared build tools put on the failed-boot
 * screen and the web manifest (tools/app-identity.mjs), so there is nothing to
 * keep in step by hand. `expo.extra.iconColor` is optional: an app that wants
 * its in-app mark in a colour other than the theme accent sets it there.
 */
import app from '../app.json';

export const APP_NAME: string = app.expo.name;

export const APP_ICON_COLOR: string | undefined = (
  app.expo as { extra?: { iconColor?: string } }
).extra?.iconColor;
