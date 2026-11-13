import './styles/tones.css';
import { COLOR_HUES, COLOR_KEYS, tint } from '../packages/core/src/planner';
import { THEMES, THEMES_LIGHT, applyTheme, type ThemeName } from './theme';

/**
 * Applies a theme: the page palette as --bg, --surface, ..., and for every color key the three tints
 * --c-<key>-bg, --c-<key>-fg and --c-<key>-line, mixed from that key's hue with this theme's surface and text.
 * tones.css reads them for rows marked data-c="<key>", so a view never writes a color itself.
 */
export function setTheme(value: string): ThemeName {
  const name = Object.hasOwn(THEMES, value) ? value as ThemeName : 'midnight';
  applyTheme(name);
  const theme = THEMES[name];
  const style = document.documentElement.style;
  for (const [key, color] of Object.entries(theme)) {
    // surface2 -> --surface-2, accentInk -> --accent-ink
    if (key !== 'label') { style.setProperty('--' + key.replace(/[A-Z0-9]/g, m => '-' + m.toLowerCase()), color); }
  }
  for (const key of COLOR_KEYS) {
    const tones = tint(COLOR_HUES[key], theme.surface, theme.text);
    style.setProperty(`--c-${key}-bg`, tones.bg);
    style.setProperty(`--c-${key}-fg`, tones.fg);
    style.setProperty(`--c-${key}-line`, tones.line);
  }
  style.colorScheme = THEMES_LIGHT.includes(name) ? 'light' : 'dark';
  return name;
}
