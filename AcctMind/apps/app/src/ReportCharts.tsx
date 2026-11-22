/**
 * The Reports tab's two drawings: a column chart (grouped or stacked bars per
 * month or year, with an optional net marker) and a donut. Drawing only — the
 * buckets, the axis and its labels come from core (`reports.ts`).
 *
 * Text-first: every number a chart shows is also in the table under it, so
 * the bars carry no labels of their own and nothing here needs a tap.
 */
import { Platform, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { niceAxis, shortAmount } from '@acctmind/core';
import { T } from './theme';

export type Segment = { amount: number; color: string; opacity?: number };
export type Column = {
  key: string;
  /** Under the column: `Jan`, or a year. */
  label: string;
  /** A second line under the label (the year at January), or nothing. */
  sub?: string | undefined;
  /** Bars side by side; each is a stack of segments, bottom first. */
  bars: Segment[][];
  /** A dot at this value (net), or nothing. */
  marker?: number | undefined;
};

const AXIS_W = 46;
/** SVG text on the web falls back to a serif face; give it the stack the app's Text uses. */
const FONT = Platform.OS === 'web'
  ? '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' : undefined;
const LABEL_H = 30;
const PAD_TOP = 8;

export function ColumnChart({ width, height = 200, columns, markerColor = T.gold, testID }: {
  width: number; height?: number; columns: readonly Column[]; markerColor?: string; testID?: string;
}) {
  if (width <= AXIS_W + 20 || columns.length === 0) return <View style={{ height }} testID={testID} />;
  // The axis holds every stack's top and bottom and every marker.
  let lo = 0;
  let hi = 0;
  for (const c of columns) {
    for (const bar of c.bars) {
      let up = 0;
      let down = 0;
      for (const s of bar) { if (s.amount > 0) up += s.amount; else down += s.amount; }
      hi = Math.max(hi, up);
      lo = Math.min(lo, down);
    }
    if (c.marker !== undefined) { hi = Math.max(hi, c.marker); lo = Math.min(lo, c.marker); }
  }
  const axis = niceAxis(lo, hi, 4);
  const plotW = width - AXIS_W;
  const plotH = height - LABEL_H - PAD_TOP;
  const span = axis.top - axis.bottom || 1;
  const y = (v: number) => PAD_TOP + ((axis.top - v) / span) * plotH;
  const ticks: number[] = [];
  if (axis.step > 0) for (let v = axis.bottom; v <= axis.top; v += axis.step) ticks.push(v);
  else ticks.push(0);

  const bw = plotW / columns.length;
  const groupW = Math.min(bw * 0.72, 22 * Math.max(1, columns[0]?.bars.length ?? 1) + 8);
  // A label needs about 30 px; past that, every k-th month is named.
  const every = Math.max(1, Math.ceil(30 / bw));

  return (
    <View testID={testID}>
      <Svg width={width} height={height}>
        {ticks.map((v) => (
          <G key={v}>
            <Line x1={AXIS_W} x2={width} y1={y(v)} y2={y(v)} stroke={v === 0 ? T.faint : T.lineSoft} strokeWidth={1} />
            <SvgText fontFamily={FONT} x={AXIS_W - 6} y={y(v) + 4} fill={T.dim} fontSize={10} textAnchor="end">{shortAmount(v)}</SvgText>
          </G>
        ))}
        {columns.map((c, i) => {
          const x0 = AXIS_W + i * bw + (bw - groupW) / 2;
          const barW = Math.max(2, (groupW - (c.bars.length - 1) * 2) / c.bars.length);
          const named = i % every === 0;
          return (
            <G key={c.key}>
              {c.bars.map((bar, j) => {
                const x = x0 + j * (barW + 2);
                let up = 0;
                let down = 0;
                return <G key={j}>{bar.map((s, k) => {
                  if (s.amount === 0) return null;
                  const from = s.amount > 0 ? up : down;
                  const to = from + s.amount;
                  if (s.amount > 0) up = to; else down = to;
                  const top = y(Math.max(from, to));
                  const h = Math.max(1, Math.abs(y(from) - y(to)));
                  return (
                    <Rect
                      key={k} x={x} y={top} width={barW} height={h} rx={barW > 6 ? 2 : 0}
                      fill={s.color} fillOpacity={s.opacity ?? 1}
                      // A hairline between stacked segments, so two groups of
                      // one palette colour still read as two.
                      stroke={bar.length > 1 ? T.bg : 'none'} strokeWidth={bar.length > 1 ? 1 : 0}
                    />
                  );
                })}</G>;
              })}
              {c.marker !== undefined && (
                <Circle cx={x0 + groupW / 2} cy={y(c.marker)} r={3.5} fill={markerColor} stroke={T.bg} strokeWidth={1.5} />
              )}
              {named && (
                <SvgText fontFamily={FONT} x={AXIS_W + i * bw + bw / 2} y={height - LABEL_H + 13} fill={T.dim} fontSize={10} textAnchor="middle">
                  {c.label}
                </SvgText>
              )}
              {named && c.sub !== undefined && (
                <SvgText fontFamily={FONT} x={AXIS_W + i * bw + bw / 2} y={height - LABEL_H + 25} fill={T.faint} fontSize={9} textAnchor="middle">
                  {c.sub}
                </SvgText>
              )}
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

/** One slice of the ring: its share is `amount` over the sum of all of them. */
export type Slice = { key: string; amount: number; color: string; opacity?: number };

/** A ring of slices, clockwise from twelve o'clock. Non-positive slices are not drawn. */
export function Donut({ size = 200, thickness = 26, slices, testID }: {
  size?: number; thickness?: number; slices: readonly Slice[]; testID?: string;
}) {
  const shown = slices.filter((s) => s.amount > 0);
  const sum = shown.reduce((n, s) => n + s.amount, 0);
  const c = size / 2;
  const r = c - 1;
  const ri = r - thickness;
  const at = (rad: number, a: number) => `${c + rad * Math.sin(a)} ${c - rad * Math.cos(a)}`;
  let a0 = 0;
  return (
    <View testID={testID}>
      <Svg width={size} height={size}>
        {sum <= 0 && <Circle cx={c} cy={c} r={r - thickness / 2} stroke={T.cardEdge} strokeWidth={thickness} fill="none" />}
        {shown.map((s) => {
          const sweep = (s.amount / sum) * Math.PI * 2;
          const a1 = a0 + sweep;
          const start = a0;
          a0 = a1;
          if (sweep >= Math.PI * 2 - 1e-6) {
            return <Circle key={s.key} cx={c} cy={c} r={r - thickness / 2} stroke={s.color} strokeOpacity={s.opacity ?? 1} strokeWidth={thickness} fill="none" />;
          }
          const large = sweep > Math.PI ? 1 : 0;
          const d = `M ${at(r, start)} A ${r} ${r} 0 ${large} 1 ${at(r, a1)} L ${at(ri, a1)} A ${ri} ${ri} 0 ${large} 0 ${at(ri, start)} Z`;
          return <Path key={s.key} d={d} fill={s.color} fillOpacity={s.opacity ?? 1} stroke={T.bg} strokeWidth={1} />;
        })}
      </Svg>
    </View>
  );
}
