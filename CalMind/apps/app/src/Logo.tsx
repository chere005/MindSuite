/**
 * The CalMind mark: the one-stroke CM — a single line flows from the C into
 * the M (picked from four candidates). assets/logo.svg is the canonical
 * copy for icons and favicons. An app with a mark of its own names its path
 * in app.json's expo.extra.markPath (MealMind's MM). The stroke is the theme
 * accent unless the app's app.json sets expo.extra.iconColor (see brand.ts).
 */
import Svg, { Path } from 'react-native-svg';
import { APP_ICON_COLOR, APP_MARK_PATH } from './brand';
import { T } from './theme';

export function Logo({ size = 72 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 96 96">
      <Path
        d={APP_MARK_PATH ?? "M 58 26 A 27 27 0 1 0 58 70 L 58 44 L 69 57 L 80 44 L 80 70"}
        fill="none"
        stroke={APP_ICON_COLOR ?? T.accent}
        strokeWidth={9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
