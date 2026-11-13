import { COLOR_KEYS, CUSTOM_COLOR_CYCLE, DEFAULT_COLORS, type ColorKey, type CoreFunctions } from './model';
import { roleOf } from './people';

/**
 * How much of the hue goes into each part, over the theme's own surface and text. One formula for
 * every theme; colors.test.ts holds fg on bg to MIN_CONTRAST for all themes and keys, so tune these
 * numbers (never the theme) if a hue ever fails. The lowest ratio today is Sage with yellow, about 5.
 */
const BG_SHARE = 0.24;
const FG_SHARE = 0.28;
const LINE_SHARE = 0.6;

function parseHex(color: string): [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) throw new RangeError(`Not a hex color: ${color}`);
  const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
const toHex = (c: number[]) => '#' + c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
/** `amount` of `to` over `from`, per channel in sRGB. */
const mix = (from: string, to: string, amount: number) => {
  const a = parseHex(from), b = parseHex(to);
  return toHex(a.map((v, i) => v + (b[i] - v) * amount));
};

export const tint: CoreFunctions['tint'] = (hue, surface, text) => ({
  bg: mix(surface, hue, BG_SHARE),
  fg: mix(text, hue, FG_SHARE),
  line: mix(surface, hue, LINE_SHARE),
});

function luminance(color: string): number {
  const [r, g, b] = parseHex(color).map(v => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG 2.x contrast ratio, 1 to 21, symmetric in its arguments. */
export const contrastRatio: CoreFunctions['contrastRatio'] = (fg, bg) => {
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

export const personalSettings: CoreFunctions['personalSettings'] = (settings, mine) =>
  typeof mine === 'string' && COLOR_KEYS.includes(mine) && mine !== settings.bothColor ? { ...settings, bothColor: mine } : settings;

export const itemColor: CoreFunctions['itemColor'] = (owners, lists, settings) => {
  if (owners.length > 1) return settings.bothColor;
  const id = owners[0];
  const list = lists.find(l => l.id === id);
  if (list) return list.color;
  const role = roleOf(id);
  return role ? DEFAULT_COLORS[role] : 'gray';
};

/** The first cycle color no list uses; once all are used, the least used one, earliest in the cycle. */
export const nextCustomColor: CoreFunctions['nextCustomColor'] = lists => {
  const used = (key: ColorKey) => lists.filter(l => l.color === key).length;
  return CUSTOM_COLOR_CYCLE.reduce((best, key) => (used(key) < used(best) ? key : best), CUSTOM_COLOR_CYCLE[0]);
};
