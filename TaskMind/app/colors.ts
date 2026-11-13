import { THEMES, THEMES_LIGHT, applyTheme, type ThemeName } from './theme';

/** The theme a stored name stands for; anything the suite does not know is Midnight, the default and the sign-in's only look. */
export function themeName(value: string): ThemeName {
  return Object.hasOwn(THEMES, value) ? value as ThemeName : 'midnight';
}

/** The page palette of a theme as CSS custom properties: surface2 -> --surface-2, accentInk -> --accent-ink. The label is not one. */
export function themeVars(name: ThemeName): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, color] of Object.entries(THEMES[name])) {
    if (key !== 'label') vars['--' + key.replace(/[A-Z0-9]/g, m => '-' + m.toLowerCase())] = color;
  }
  return vars;
}

/** Applies a theme to the page: the variables every style sheet reads (so a view never writes a color itself), and the native color scheme. */
export function setTheme(value: string): ThemeName {
  const name = themeName(value);
  applyTheme(name);
  const style = document.documentElement.style;
  for (const [property, color] of Object.entries(themeVars(name))) style.setProperty(property, color);
  style.colorScheme = THEMES_LIGHT.includes(name) ? 'light' : 'dark';
  return name;
}
