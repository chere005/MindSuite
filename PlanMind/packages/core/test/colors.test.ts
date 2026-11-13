import { describe, it, expect } from 'vitest';
import { THEMES } from '../../../app/theme';
import {
  COLOR_HUES, COLOR_KEYS, CUSTOM_COLOR_CYCLE, DEFAULT_COLORS, MIN_CONTRAST, contrastRatio, itemColor, nextCustomColor, people, personalSettings, tint,
  type ColorKey, type ListRecord, type Settings,
} from '../src/planner';

const stamp = { revision: 1, updatedAt: '2026-10-30T00:00:00Z' };
const person = (id: string, color: ColorKey, order: number): ListRecord => ({ id, kind: 'person', name: id, color, order, ...stamp });
const custom = (n: number, color: ColorKey): ListRecord => ({ id: `${n}`.repeat(8) + '-0000-4000-8000-000000000000', kind: 'custom', name: `L${n}`, color, order: n + 1, ...stamp });
const base = [person(people().partner, DEFAULT_COLORS.partner, 0), person(people().owner, DEFAULT_COLORS.owner, 1)];
const settings: Settings = { bothColor: DEFAULT_COLORS.both, revision: 1, updatedAt: '2026-10-30T00:00:00Z' };
const hex = /^#[0-9a-f]{6}$/;

describe('default colors', () => {
  it('are by role: the partner yellow, the owner green, Both purple', () => {
    expect(Object.entries(DEFAULT_COLORS)).toEqual([['owner', 'green'], ['partner', 'yellow'], ['both', 'purple']]);
    expect(COLOR_KEYS).toHaveLength(9);
    expect(Object.keys(COLOR_HUES).sort()).toEqual([...COLOR_KEYS].sort());
  });
});

describe('itemColor', () => {
  it('one owner takes that list color, so a recolor shows at once', () => {
    expect(itemColor(['sam'], base, settings)).toBe('yellow');
    expect(itemColor(['alex'], base, settings)).toBe('green');
    expect(itemColor(['alex'], [base[0], person('alex', 'red', 1)], settings)).toBe('red');
    expect(itemColor([custom(1, 'teal').id], [...base, custom(1, 'teal')], settings)).toBe('teal');
  });
  it('a linked item uses the Both color, whatever the person colors are', () => {
    expect(itemColor(['sam', 'alex'], base, settings)).toBe('purple');
    expect(itemColor(['sam', 'alex'], base, { ...settings, bothColor: 'pink' })).toBe('pink');
    expect(itemColor(['sam', 'alex'], [person('sam', 'pink', 0), person('alex', 'pink', 1)], settings)).toBe('purple');
  });
  it('an owner that is not in the lists still gets a color: the person default, else gray', () => {
    expect(itemColor(['sam'], [], settings)).toBe('yellow');
    expect(itemColor(['alex'], [], settings)).toBe('green');
    expect(itemColor(['66666666-6666-4666-8666-666666666666'], base, settings)).toBe('gray');
  });
});

describe('nextCustomColor', () => {
  it('starts with the first cycle color', () => {
    expect(nextCustomColor(base)).toBe(CUSTOM_COLOR_CYCLE[0]);
    expect(nextCustomColor([])).toBe(CUSTOM_COLOR_CYCLE[0]);
  });
  it('walks the cycle, one unused color at a time', () => {
    let lists: ListRecord[] = [...base];
    const picked: ColorKey[] = [];
    for (let n = 1; n <= CUSTOM_COLOR_CYCLE.length; n++) {
      const color = nextCustomColor(lists);
      picked.push(color);
      lists = [...lists, custom(n, color)];
    }
    expect(picked).toEqual([...CUSTOM_COLOR_CYCLE]);
  });
  it('wraps around once every cycle color is taken, then fills the second round in cycle order', () => {
    let lists: ListRecord[] = [...base];
    const picked: ColorKey[] = [];
    for (let n = 1; n <= CUSTOM_COLOR_CYCLE.length * 2; n++) {
      const color = nextCustomColor(lists);
      picked.push(color);
      lists = [...lists, custom(n, color)];
    }
    expect(picked).toEqual([...CUSTOM_COLOR_CYCLE, ...CUSTOM_COLOR_CYCLE]);
  });
  it('skips a color a person list was recolored to, and refills a gap left by a deleted list', () => {
    expect(nextCustomColor([person('sam', 'blue', 0), person('alex', 'green', 1)])).toBe('orange');
    const lists = [...base, custom(1, 'blue'), custom(2, 'orange'), custom(3, 'teal')];
    expect(nextCustomColor(lists.filter(l => l.color !== 'orange'))).toBe('orange');
  });
});

describe('contrastRatio', () => {
  it('matches the WCAG reference values and is symmetric', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5);
  });
  it('weighs dark greys with the sRGB curve, not the linear one, up to 0.04045', () => {
    // 0x14 = 20/255 = 0.078 is above the knee: ((0.078 + 0.055) / 1.055) ** 2.4 = 0.00699, so (0.00699 + 0.05) / 0.05 = 1.1399.
    expect(contrastRatio('#141414', '#000000')).toBeCloseTo(1.1399, 3);
    expect(contrastRatio('#000000', '#141414')).toBeCloseTo(1.1399, 3);
    // 0x0a = 10/255 = 0.039 is below the knee: 0.039 / 12.92 = 0.00303, so 1.0606.
    expect(contrastRatio('#0a0a0a', '#000000')).toBeCloseTo(1.0606, 3);
    // 0x0b = 11/255 = 0.0431 is just above it: ((0.0431 + 0.055) / 1.055) ** 2.4 = 0.00335, so 1.0670.
    expect(contrastRatio('#0b0b0b', '#000000')).toBeCloseTo(1.067, 3);
  });
  it('rejects a value that is not a hex color instead of guessing', () => {
    expect(() => contrastRatio('red', '#ffffff')).toThrow(RangeError);
    expect(() => contrastRatio('#ffffff', '#12345')).toThrow(RangeError);
  });
});

describe('tint', () => {
  it('returns hex colors that sit between the surface and the hue', () => {
    const t = tint('#ff0000', '#000000', '#ffffff');
    expect(t.bg).toMatch(hex); expect(t.fg).toMatch(hex); expect(t.line).toMatch(hex);
    expect(t.bg).not.toBe('#000000');
    expect(t.bg).not.toBe('#ff0000');
    expect(t.line).not.toBe(t.bg);
  });
  it('mixes the hue over the surface (bg 24%, line 60%) and over the text (fg 28%), rounding to the nearest step', () => {
    // red over black: 255 * 0.24 = 61.2 -> 3d, 255 * 0.6 = 153 -> 99; red over white: 255 - 255 * 0.28 = 183.6 -> b8 (not b7)
    expect(tint('#ff0000', '#000000', '#ffffff')).toEqual({ bg: '#3d0000', fg: '#ffb8b8', line: '#990000' });
    expect(tint('#2fb67c', '#1a2b3c', '#e0e8f0')).toEqual({ bg: '#1f4c4b', fg: '#aedad0', line: '#277e62' });
  });
  it('the line is the strongest part and always leans toward the hue, not back toward the surface', () => {
    const { bg, line } = tint('#ff0000', '#000000', '#ffffff');
    expect(parseInt(line.slice(1, 3), 16)).toBeGreaterThan(parseInt(bg.slice(1, 3), 16));
    expect(tint('#000000', '#ffffff', '#000000').line).toBe('#666666');
  });
  it('is pure: the same inputs give the same colors', () => {
    expect(tint('#2fb67c', '#1a1a1a', '#eeeeee')).toEqual(tint('#2fb67c', '#1a1a1a', '#eeeeee'));
  });
  it('different hues stay visibly different on one theme', () => {
    const t = THEMES.midnight;
    const bgs = COLOR_KEYS.map(k => tint(COLOR_HUES[k], t.surface, t.text).bg);
    expect(new Set(bgs).size).toBe(COLOR_KEYS.length);
    expect(bgs.every(bg => bg !== t.surface)).toBe(true);
  });
});

describe('every theme and color key reads at WCAG AA', () => {
  for (const [name, theme] of Object.entries(THEMES)) {
    it(`${name}: fg on bg for all ${COLOR_KEYS.length} keys is at least ${MIN_CONTRAST}`, () => {
      for (const key of COLOR_KEYS) {
        const { bg, fg } = tint(COLOR_HUES[key], theme.surface, theme.text);
        expect(contrastRatio(fg, bg), `${name}/${key}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
    });
    it(`${name}: the tinted background is distinguishable from the surface`, () => {
      for (const key of COLOR_KEYS) {
        const { bg, line } = tint(COLOR_HUES[key], theme.surface, theme.text);
        expect(bg, `${name}/${key}`).not.toBe(theme.surface);
        expect(line, `${name}/${key}`).not.toBe(theme.surface);
      }
    });
  }
  it('covers the four suite themes', () => {
    expect(Object.keys(THEMES).sort()).toEqual(['forest', 'midnight', 'olive', 'sage']);
  });
});

describe('personalSettings (#138: the Both color is per person)', () => {
  it('without a pick the household default stays: nothing changes until someone picks', () => {
    expect(personalSettings(settings, null)).toBe(settings);
    expect(personalSettings(settings, undefined)).toBe(settings);
    expect(personalSettings(settings, 'purple')).toBe(settings);
  });
  it('a pick replaces only bothColor, and every Both reader sees it', () => {
    const mine = personalSettings(settings, 'teal');
    expect(mine).toEqual({ ...settings, bothColor: 'teal' });
    expect(itemColor(['sam', 'alex'], base, mine)).toBe('teal');
    expect(itemColor(['sam'], base, mine)).toBe('yellow');
    expect(settings.bothColor).toBe('purple');
  });
  it('two people with different picks get different Both colors from the same household settings', () => {
    expect(itemColor(['sam', 'alex'], base, personalSettings(settings, 'red'))).toBe('red');
    expect(itemColor(['sam', 'alex'], base, personalSettings(settings, 'blue'))).toBe('blue');
    expect(itemColor(['sam', 'alex'], base, personalSettings(settings, null))).toBe('purple');
  });
  it('a value outside the palette is ignored', () => {
    expect(personalSettings(settings, 'mauve' as ColorKey)).toBe(settings);
    expect(personalSettings(settings, 7 as unknown as ColorKey)).toBe(settings);
  });
});
