import Svg, { Path } from 'react-native-svg';
import { T } from '../theme';

/** The month-pie, in the mark's language. No calendar here uses it; kept
 *  because it is part of the mark's family and costs nothing. */
export function PieIcon({ size = 22, color = T.accent }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M 12 12 L 12 2 A 10 10 0 0 1 21.5 8.9 Z" fill={color} />
      <Path d="M 12 12 L 21.5 8.9 A 10 10 0 1 1 12 2 Z" fill="none" stroke={color} strokeWidth={2.2} />
    </Svg>
  );
}
