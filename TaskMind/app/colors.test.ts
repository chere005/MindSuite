import { describe, expect, it } from 'vitest';
import { themeName, themeVars } from './colors';
import { THEMES, type ThemeName } from './theme';

const channel = (hex: string, at: number) => { const v = parseInt(hex.slice(at, at + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const NAMES = Object.keys(THEMES) as ThemeName[];

describe('themes', () => {
  it('are the suite\'s four', () => {
    expect(NAMES).toEqual(['midnight', 'sage', 'forest', 'olive']);
  });
  it('fall back to Midnight for a name the suite does not know, including inherited object keys', () => {
    for (const odd of ['', 'neon', 'toString', '__proto__', 'constructor']) expect(themeName(odd), odd).toBe('midnight');
    for (const name of NAMES) expect(themeName(name)).toBe(name);
  });
  it('turn into the custom properties the style sheets read', () => {
    const vars = themeVars('sage');
    expect(vars['--bg']).toBe('#fefae0');
    expect(vars['--surface-2']).toBe(THEMES.sage.surface2);
    expect(vars['--accent-ink']).toBe(THEMES.sage.accentInk);
    expect(Object.keys(vars)).not.toContain('--label');
  });
  // The text the shell draws, against what it is drawn on, at WCAG AA for normal text (4.5:1), in every theme.
  for (const name of NAMES) {
    it(`keep the shell's text readable in ${name}`, () => {
      const t = THEMES[name];
      expect(contrast(t.text, t.bg), 'text on page').toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.dim, t.surface), 'dim on card').toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.text, t.surface), 'text on card').toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.accentInk, t.accent), 'ink on the accent button').toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.accent, t.surface), 'accent link on card').toBeGreaterThanOrEqual(3);
    });
  }
});
