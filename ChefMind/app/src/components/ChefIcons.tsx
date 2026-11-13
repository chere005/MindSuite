/**
 * ChefMind-only tab icons (basket, pantry), split out of KindIcons so that
 * file can stay byte-equal to the canon copy.
 */
import Svg, { Path, Rect } from 'react-native-svg';
import { T } from '../theme';

/**
 * A shopping basket, in the same drawing language as the rest of the bar: a
 * tapered body, the rim across the top, and the two handles arcing over it.
 * Stroked at 2, like PageIcon, so it reads at the same weight beside it.
 */
export function BasketIcon({ size = 20, color = T.dim }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {/* ONE ARC over the top, not two straight handles. The two-handle
          version read as a waste bin at tab-bar size — which, next to a list
          of things you are about to buy, is the worst possible misread. A
          single semicircular handle is the shape a picnic basket has and
          nothing else does. */}
      <Path d="M 8 9 A 4 4 0 0 1 16 9" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
      <Path d="M 3.5 9 H 20.5 L 18.4 19.2 A 1.6 1.6 0 0 1 16.8 20.5 H 7.2 A 1.6 1.6 0 0 1 5.6 19.2 Z"
            fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
    </Svg>
  );
}

/**
 * The pantry: a shelved cupboard with two jars on it.
 *
 * It has to be legible at 20px next to a BASKET, and the two must not be
 * confusable — one is what you are about to buy, the other is what you already
 * have, and mixing them up is the whole failure mode of this pair of tabs. The
 * basket is one round arc over an open taper; this is square, has a shelf line
 * across the middle, and is closed. Nothing they share reads the same.
 */
export function PantryIcon({ size = 20, color = T.dim }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={3.5} y={3} width={17} height={18} rx={2.5} fill="none" stroke={color} strokeWidth={2} />
      {/* The shelf. Full width, so it reads as a cupboard rather than as a
          label bar across a jar. */}
      <Path d="M 3.5 12 H 20.5" stroke={color} strokeWidth={2} />
      {/* Two jars on the top shelf — squat, with lids, drawn at a lighter
          weight so the cupboard stays the shape you see first. */}
      <Rect x={7} y={6.5} width={3.6} height={5.5} rx={0.8} fill="none" stroke={color} strokeWidth={1.4} />
      <Rect x={13.4} y={6.5} width={3.6} height={5.5} rx={0.8} fill="none" stroke={color} strokeWidth={1.4} />
    </Svg>
  );
}
