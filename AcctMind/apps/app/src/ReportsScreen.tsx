/**
 * The Reports tab — the owner, 2026-11-21: "a visualization tab that's similar
 * to some basic features from ynab so i can see spending/income by month,
 * year, category". Three of YNAB's reports: Spending (by group, a tap to its
 * lines), Trends (spending per month) and Income vs expense (per month or
 * year, with net).
 *
 * Plumbing only, and READ-ONLY by construction: nothing here takes `commit`,
 * so it works the same in the browser's read-only copy as in the apps. What
 * a row counts as, every bucket, total, share and axis is core's
 * (`reports.ts`); this file draws them and remembers which report is open.
 *
 * `ReportsBody` is shared by the phone screen below and the wide pane
 * (`wide/WideReports.tsx`); `wide` only changes how much sits side by side.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  categoryFilterLabel, categoryOptions, DEFAULT_REPORT_PERIOD, formatAmount, incomeExpense, live, liveAccountFilter,
  liveCategoryFilter, monthShort, NO_CATEGORY, NO_CATEGORY_COLOR, periodLabel, periodRange, REPORT_PERIODS, reportRows,
  reportYears, sameCategoryFilter, shareLabel, spendingBreakdown, spendingTrend, today, toggleReportAccount, yearPeriod,
  type BreakdownRow, type CategoryFilter, type ReportPeriod, type Store,
} from '@acctmind/core';
import { Dot } from './Dot';
import { ColumnChart, Donut, type Column } from './ReportCharts';
import { useReadOnly } from './readonly';
import { TopBar } from './TopBar';
import { SPACE, T, TAP } from './theme';

type Report = 'spending' | 'trends' | 'flow';
const REPORTS: readonly { id: Report; label: string }[] = [
  { id: 'spending', label: 'Spending' },
  { id: 'trends', label: 'Trends' },
  { id: 'flow', label: 'Income vs expense' },
];

/** What the tab is showing. A view choice, so it is this session's, not the ledger's. */
type ReportView = {
  report: Report;
  period: ReportPeriod;
  accounts: string[] | null;
  category: CategoryFilter;
  /** Trends: one bar per month, or stacked by group. */
  stacked: boolean;
  /** Income vs expense: per month, or per year. */
  byYear: boolean;
  /** Spending: the group whose lines are open, or null for the groups. */
  drill: string | null;
};
const START: ReportView = {
  report: 'spending', period: DEFAULT_REPORT_PERIOD, accounts: null, category: null,
  stacked: false, byYear: false, drill: null,
};
/**
 * Kept across the tab being left and come back to (the phone unmounts a tab
 * it is not showing), for this run of the app only.
 */
let remembered: ReportView = START;

function useReportView(): [ReportView, (patch: Partial<ReportView>) => void] {
  const [view, setView] = useState(remembered);
  useEffect(() => { remembered = view; }, [view]);
  return [view, (patch) => setView((v) => ({ ...v, ...patch }))];
}

/** Lines of one group share its colour; these tell them apart in the ring and the bars. */
const SHADES = [1, 0.72, 0.5, 0.34] as const;
const monthYear = (m: string) => `${monthShort(m)} ${m.slice(0, 4)}`;

export function ReportsBody({ store, wide = false }: { store: Store; wide?: boolean }) {
  const [view, set] = useReportView();
  const [width, setWidth] = useState(0);
  const [picking, setPicking] = useState(false);
  const day = today();

  const rows = useMemo(() => reportRows(store), [store]);
  const accounts = useMemo(() => live(store.accounts).sort((a, b) => a.order - b.order), [store.accounts]);
  const accountIds = accounts.map((a) => a.id);
  const picked = liveAccountFilter(view.accounts, accountIds);
  const category = liveCategoryFilter(view.category, store);
  const range = periodRange(view.period, day, rows);
  const scope = { range, accounts: picked, category };
  const label = periodLabel(view.period, range);
  const periods = [
    ...REPORT_PERIODS,
    ...reportYears(rows, day).map((y) => ({ period: yearPeriod(y), label: String(y) })),
  ];
  const colors = useMemo(() => new Map(store.categories.map((c) => [c.id, c.color])), [store.categories]);
  const colorOf = (group: string) => (group === NO_CATEGORY ? NO_CATEGORY_COLOR : colors.get(group) ?? NO_CATEGORY_COLOR);

  const chips = (children: ReactNode, testID: string) => wide
    ? <View style={styles.wrap} testID={testID}>{children}</View>
    : <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scrollRow} testID={testID}>{children}</ScrollView>;

  return (
    <View style={styles.body} onLayout={(e) => setWidth(e.nativeEvent.layout.width)} testID="reports">
      {/* WHICH REPORT, then the period and filters it is read over. */}
      <View style={styles.segments} accessibilityRole="tablist">
        {REPORTS.map((r) => (
          <Pressable
            key={r.id} onPress={() => set({ report: r.id })} style={[styles.segmentHit, r.id === 'flow' && styles.segmentWide]}
            accessibilityRole="tab" accessibilityState={{ selected: view.report === r.id }} testID={`report-tab-${r.id}`}
          >
            <View style={[styles.segment, view.report === r.id && styles.segmentOn]}>
              <Text style={[styles.segmentText, view.report === r.id && styles.segmentTextOn]} numberOfLines={1}>{r.label}</Text>
            </View>
          </Pressable>
        ))}
      </View>

      {chips(periods.map((p) => (
        <Chip key={p.period} label={p.label} on={view.period === p.period}
          onPress={() => set({ period: p.period, drill: null })} testID={`report-period-${p.period}`} />
      )), 'report-periods')}

      {accounts.length > 1 && chips(
        <>
          <Chip label="All accounts" on={picked === null} onPress={() => set({ accounts: null })} testID="report-account-all" />
          {accounts.map((a) => (
            <Chip key={a.id} label={a.name || 'Untitled'} dot={a.color}
              on={picked !== null && picked.includes(a.id)}
              onPress={() => set({ accounts: toggleReportAccount(picked, a.id, accountIds) })}
              testID={`report-account-${a.id}`} />
          ))}
        </>,
        'report-accounts',
      )}

      {view.report !== 'flow' && (
        <View>
          <Pressable
            onPress={() => setPicking(!picking)} style={styles.pickHit} accessibilityRole="button"
            accessibilityState={{ expanded: picking }} testID="report-category"
          >
            <Text style={styles.pickText} numberOfLines={1}>
              <Text style={styles.dim}>Category </Text>{categoryFilterLabel(category, store)}
            </Text>
            <Text style={styles.caret}>{picking ? '⌃' : '⌄'}</Text>
          </Pressable>
          {picking && (
            <View style={styles.pickList} testID="report-category-list">
              {categoryOptions(store).map((o) => (
                <Pressable
                  key={o.filter === null ? 'all' : 'group' in o.filter ? `g${o.filter.group}` : `l${o.filter.line}`}
                  onPress={() => { set({ category: o.filter, drill: null }); setPicking(false); }}
                  style={[styles.pickRow, o.depth === 1 && styles.pickIndent, sameCategoryFilter(o.filter, category) && styles.pickRowOn]}
                  accessibilityRole="button" testID="report-category-option"
                >
                  {o.color !== '' && <Dot colors={[o.color]} size={o.depth === 0 ? 10 : 8} />}
                  <Text style={[styles.pickRowText, o.depth === 0 && styles.bold]} numberOfLines={1}>{o.label}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      )}

      <Text style={styles.period} testID="report-period-label">{label}</Text>

      {view.report === 'spending' && (
        <SpendingReport
          breakdown={spendingBreakdown(rows, scope, store)} drill={view.drill} onDrill={(drill) => set({ drill })}
          wide={wide} width={width}
        />
      )}
      {view.report === 'trends' && (() => {
        const trend = spendingTrend(rows, scope, store);
        const stack = view.stacked && category === null;
        const single = category === null ? T.accent
          : 'group' in category ? colorOf(category.group)
          : colorOf(store.lines.find((l) => l.id === category.line)?.category ?? NO_CATEGORY);
        const columns: Column[] = trend.months.map((m, i) => ({
          key: m.month, label: monthShort(m.month),
          sub: i === 0 || m.month.endsWith('-01') ? m.month.slice(0, 4) : undefined,
          bars: [stack ? m.groups.map((g) => ({ amount: g.amount, color: colorOf(g.id) })) : [{ amount: m.total, color: single }]],
        }));
        const legend = stack
          ? [...new Set(trend.months.flatMap((m) => m.groups.map((g) => g.id)))]
          : [];
        const names = new Map(store.categories.map((c) => [c.id, c.name || 'Untitled']));
        return (
          <View style={styles.report}>
            <View style={styles.figures}>
              <Figure label="Total" testID="report-trend-total">{formatAmount(trend.total)}</Figure>
              <Figure label="Average a month" testID="report-trend-average">{formatAmount(trend.average)}</Figure>
            </View>
            {category === null && (
              <Toggle label="Stack by group" on={view.stacked} onPress={() => set({ stacked: !view.stacked })} testID="report-stack" />
            )}
            <ColumnChart width={chartWidth(width)} height={wide ? 260 : 200} columns={columns} testID="report-trend-chart" />
            {legend.length > 0 && (
              <View style={styles.legend}>
                {legend.map((id) => (
                  <View key={id} style={styles.legendItem}>
                    <Dot colors={[colorOf(id)]} size={9} />
                    <Text style={styles.legendText}>{id === NO_CATEGORY ? 'No Category' : names.get(id) ?? ''}</Text>
                  </View>
                ))}
              </View>
            )}
            <Table
              head={['Month', 'Spending']}
              rows={trend.months.map((m) => ({ key: m.month, cells: [monthYear(m.month), formatAmount(m.total)] }))}
              narrow
              testID="report-trend-row"
            />
          </View>
        );
      })()}
      {view.report === 'flow' && (() => {
        const flow = incomeExpense(rows, scope);
        const buckets = view.byYear ? flow.years : flow.months;
        const columns: Column[] = buckets.map((b, i) => ({
          key: b.key,
          label: view.byYear ? b.key : monthShort(b.key),
          sub: !view.byYear && (i === 0 || b.key.endsWith('-01')) ? b.key.slice(0, 4) : undefined,
          bars: [[{ amount: b.income, color: T.positive }], [{ amount: b.spending, color: T.accent }]],
          marker: b.net,
        }));
        return (
          <View style={styles.report}>
            <View style={styles.figures}>
              <Figure label="Income" tone={T.positive} testID="report-flow-income">{formatAmount(flow.total.income)}</Figure>
              <Figure label="Spending" testID="report-flow-spending">{formatAmount(flow.total.spending)}</Figure>
              <Figure label="Net" tone={flow.total.net < 0 ? T.danger : T.text} testID="report-flow-net">{formatAmount(flow.total.net)}</Figure>
            </View>
            <View style={styles.toggles}>
              <Chip label="By month" on={!view.byYear} onPress={() => set({ byYear: false })} testID="report-flow-by-month" />
              <Chip label="By year" on={view.byYear} onPress={() => set({ byYear: true })} testID="report-flow-by-year" />
            </View>
            <ColumnChart width={chartWidth(width)} height={wide ? 260 : 200} columns={columns} testID="report-flow-chart" />
            <View style={styles.legend}>
              <LegendKey color={T.positive} label="Income" />
              <LegendKey color={T.accent} label="Spending" />
              <LegendKey color={T.gold} label="Net" round />
            </View>
            <Table
              head={[view.byYear ? 'Year' : 'Month', 'Income', 'Spending', 'Net']}
              rows={buckets.map((b) => ({
                key: b.key,
                cells: [view.byYear ? b.key : monthYear(b.key), formatAmount(b.income), formatAmount(b.spending), formatAmount(b.net)],
                negLast: b.net < 0,
              }))}
              foot={['Total', formatAmount(flow.total.income), formatAmount(flow.total.spending), formatAmount(flow.total.net)]}
              footNeg={flow.total.net < 0}
              testID="report-flow-row"
            />
          </View>
        );
      })()}
    </View>
  );
}

/** Charts stop growing at a reading width; tables under them are capped the same. */
const CHART_MAX = 920;
const chartWidth = (w: number) => Math.min(Math.max(0, w), CHART_MAX);

function SpendingReport({ breakdown, drill, onDrill, wide, width }: {
  breakdown: ReturnType<typeof spendingBreakdown>; drill: string | null; onDrill: (id: string | null) => void;
  wide: boolean; width: number;
}) {
  const open = drill === null ? undefined : breakdown.groups.find((g) => g.id === drill && g.lines.length > 0);
  const list: readonly BreakdownRow[] = open ? open.lines : breakdown.groups;
  const shade = (i: number) => (open ? SHADES[i % SHADES.length] : 1);
  const max = list.reduce((n, r) => Math.max(n, r.amount), 0);
  const beside = wide && width >= 720;
  const ring = (
    <Donut
      size={beside ? 200 : 160}
      slices={list.map((r, i) => ({ key: r.id, amount: r.amount, color: r.color, opacity: shade(i) }))}
      testID="report-donut"
    />
  );
  return (
    <View style={styles.report}>
      <View style={styles.figures}>
        <Figure label={open ? open.name : 'Spending'} testID="report-spending-total">
          {formatAmount(open ? open.amount : breakdown.total)}
        </Figure>
        {open && <Figure label="Of all spending">{shareLabel(open.share) || '—'}</Figure>}
      </View>
      {open && (
        <Pressable onPress={() => onDrill(null)} style={styles.back} accessibilityRole="button" testID="report-drill-back">
          <Text style={styles.backText}>‹ All groups</Text>
        </Pressable>
      )}
      {list.length === 0 ? (
        <Text style={styles.empty} testID="report-empty">No spending in this period.</Text>
      ) : (
        <View style={[beside && styles.beside]}>
          {wide && <View style={beside ? styles.ringBeside : styles.ringAbove}>{ring}</View>}
          <View style={[styles.bars, beside && styles.grow]}>
            {list.map((r, i) => {
              const drills = !open && (breakdown.groups.find((g) => g.id === r.id)?.lines.length ?? 0) > 0;
              const row = (
                <>
                  <View style={styles.barHead}>
                    <View style={{ opacity: shade(i) }}><Dot colors={[r.color]} size={10} /></View>
                    <Text style={styles.barName} numberOfLines={1} testID="report-row-name">{r.name}</Text>
                    <Text style={styles.barShare} testID="report-row-share">{shareLabel(r.share)}</Text>
                    <Text style={[styles.barAmount, r.amount < 0 && styles.pos]} testID="report-row-amount">{formatAmount(r.amount)}</Text>
                    <Text style={styles.chev}>{drills ? '›' : ''}</Text>
                  </View>
                  <View style={styles.track}>
                    {r.amount > 0 && max > 0 && (
                      <View style={[styles.barFill, { width: `${(r.amount / max) * 100}%`, backgroundColor: r.color, opacity: shade(i) }]} />
                    )}
                  </View>
                </>
              );
              return drills ? (
                <Pressable key={r.id} onPress={() => onDrill(r.id)} style={styles.barRow} accessibilityRole="button"
                  accessibilityLabel={`${r.name}, show its lines`} testID="report-row">
                  {row}
                </Pressable>
              ) : (
                <View key={r.id} style={styles.barRow} testID="report-row">{row}</View>
              );
            })}
          </View>
        </View>
      )}
    </View>
  );
}

function Chip({ label, on, onPress, dot, testID }: {
  label: string; on: boolean; onPress: () => void; dot?: string; testID?: string;
}) {
  return (
    <Pressable onPress={onPress} style={styles.chipHit} accessibilityRole="button" accessibilityState={{ selected: on }} testID={testID}>
      <View style={[styles.chip, on && styles.chipOn]}>
        {dot !== undefined && <Dot colors={[dot]} size={8} />}
        <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>{label}</Text>
      </View>
    </Pressable>
  );
}

function Toggle({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable onPress={onPress} style={styles.toggle} accessibilityRole="checkbox" accessibilityState={{ checked: on }} testID={testID}>
      <View style={[styles.box, on && styles.boxOn]}>{on && <Text style={styles.tick}>✓</Text>}</View>
      <Text style={styles.toggleText}>{label}</Text>
    </Pressable>
  );
}

function Figure({ label, tone, testID, children }: { label: string; tone?: string; testID?: string; children: ReactNode }) {
  return (
    <View style={styles.figure}>
      <Text style={styles.figureLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.figureValue, tone !== undefined && { color: tone }]} testID={testID}>{children}</Text>
    </View>
  );
}

function LegendKey({ color, label, round = false }: { color: string; label: string; round?: boolean }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.key, round && styles.keyRound, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

/** First column left, the rest right-aligned figures; the last goes red when `negLast`. */
function Table({ head, rows, foot, footNeg = false, narrow = false, testID }: {
  head: readonly string[];
  rows: readonly { key: string; cells: readonly string[]; negLast?: boolean }[];
  foot?: readonly string[]; footNeg?: boolean;
  /** Two columns: kept close together rather than at either edge of a wide pane. */
  narrow?: boolean;
  testID: string;
}) {
  const cell = (text: string, i: number, n: number, neg: boolean, bold = false) => (
    <Text key={i} numberOfLines={1}
      style={[i === 0 ? styles.tdFirst : styles.td, bold && styles.bold, i === n - 1 && neg && styles.neg]}>
      {text}
    </Text>
  );
  return (
    <View style={[styles.table, narrow && styles.tableNarrow]}>
      <View style={[styles.tr, styles.thead]}>
        {head.map((h, i) => <Text key={h} style={[i === 0 ? styles.tdFirst : styles.td, styles.th]}>{h}</Text>)}
      </View>
      {rows.map((r) => (
        <View key={r.key} style={styles.tr} testID={testID}>
          {r.cells.map((c, i) => cell(c, i, r.cells.length, r.negLast === true))}
        </View>
      ))}
      {foot && (
        <View style={[styles.tr, styles.tfoot]} testID={`${testID}-total`}>
          {foot.map((c, i) => cell(c, i, foot.length, footNeg, true))}
        </View>
      )}
    </View>
  );
}

/** The phone's Reports tab: the bar, the read-only banner when there is one, and the body. */
export function ReportsScreen({ store, menu }: { store: Store; menu: ReactNode }) {
  const { banner } = useReadOnly();
  return (
    <View style={styles.fill}>
      <TopBar title="Reports" titleTestID="reports-title" menu={menu} />
      {banner}
      <ScrollView contentContainerStyle={styles.phoneList}>
        <ReportsBody store={store} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  phoneList: { paddingHorizontal: SPACE.lg, paddingBottom: SPACE.xl },
  body: { gap: SPACE.xs },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 6 },
  scrollRow: { flexDirection: 'row', gap: 6, paddingRight: SPACE.lg },
  segments: {
    flexDirection: 'row', backgroundColor: T.card, borderRadius: 10, padding: 3, marginBottom: SPACE.xs,
    borderWidth: StyleSheet.hairlineWidth, borderColor: T.cardEdge, maxWidth: 520,
  },
  segmentHit: { flex: 1, minHeight: TAP - 6, justifyContent: 'center' },
  segmentWide: { flex: 1.5 },
  segment: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 6, alignItems: 'center' },
  segmentOn: { backgroundColor: T.accent },
  segmentText: { color: T.dim, fontSize: 13, fontWeight: '500' },
  segmentTextOn: { color: '#ffffff', fontWeight: '600' },
  chipHit: { minHeight: TAP, justifyContent: 'center' },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 16,
    backgroundColor: T.card, borderWidth: StyleSheet.hairlineWidth, borderColor: T.cardEdge,
  },
  chipOn: { backgroundColor: 'rgba(10,132,255,0.22)', borderColor: T.accent },
  chipText: { color: T.dim, fontSize: 13 },
  chipTextOn: { color: T.text, fontWeight: '600' },
  pickHit: {
    minHeight: TAP, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, alignSelf: 'flex-start', maxWidth: '100%',
  },
  pickText: { color: T.text, fontSize: 14, flexShrink: 1 },
  caret: { color: T.accent, fontSize: 14 },
  pickList: {
    backgroundColor: T.card, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: T.cardEdge,
    maxWidth: 420, marginBottom: SPACE.sm, overflow: 'hidden',
  },
  pickRow: {
    minHeight: TAP, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.lineSoft,
  },
  pickIndent: { paddingLeft: SPACE.xl + SPACE.sm },
  pickRowOn: { backgroundColor: 'rgba(10,132,255,0.2)' },
  pickRowText: { color: T.text, fontSize: 14, flexShrink: 1 },
  period: { color: T.text, fontSize: 14, fontWeight: '600', marginTop: SPACE.xs },
  report: { gap: SPACE.md, maxWidth: CHART_MAX },
  figures: { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.lg, rowGap: SPACE.sm },
  figure: { gap: 2 },
  figureLabel: { color: T.dim, fontSize: 12 },
  figureValue: { color: T.text, fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'] },
  back: { minHeight: TAP - 8, justifyContent: 'center', alignSelf: 'flex-start' },
  backText: { color: T.accent, fontSize: 15 },
  empty: { color: T.dim, fontSize: 14, paddingVertical: SPACE.lg },
  beside: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.xl },
  ringBeside: { paddingTop: SPACE.xs },
  ringAbove: { alignItems: 'center', paddingBottom: SPACE.sm },
  grow: { flex: 1, minWidth: 0 },
  bars: { gap: 2 },
  barRow: { paddingVertical: 7, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.lineSoft },
  barHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  barName: { flex: 1, color: T.text, fontSize: 15 },
  barShare: { color: T.dim, fontSize: 13, minWidth: 38, textAlign: 'right', fontVariant: ['tabular-nums'] },
  barAmount: { color: T.text, fontSize: 15, fontWeight: '500', minWidth: 92, textAlign: 'right', fontVariant: ['tabular-nums'] },
  chev: { color: T.dim, fontSize: 16, width: 10 },
  pos: { color: T.positive },
  track: { height: 6, borderRadius: 3, backgroundColor: T.card, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },
  toggles: { flexDirection: 'row', gap: 6 },
  toggle: { minHeight: TAP, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, alignSelf: 'flex-start' },
  box: {
    width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: T.faint,
    alignItems: 'center', justifyContent: 'center',
  },
  boxOn: { backgroundColor: T.accent, borderColor: T.accent },
  tick: { color: '#ffffff', fontSize: 13, fontWeight: '700', lineHeight: 15 },
  toggleText: { color: T.text, fontSize: 14 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.lg, rowGap: SPACE.xs },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendText: { color: T.dim, fontSize: 12 },
  key: { width: 10, height: 10, borderRadius: 2 },
  keyRound: { borderRadius: 5 },
  table: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.cardEdge },
  tableNarrow: { maxWidth: 480 },
  tr: {
    flexDirection: 'row', alignItems: 'center', minHeight: 34, gap: SPACE.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.lineSoft,
  },
  thead: { minHeight: 30 },
  tfoot: { borderBottomWidth: 0, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.cardEdge },
  th: { color: T.dim, fontSize: 12, fontWeight: '500' },
  tdFirst: { flex: 1.1, color: T.text, fontSize: 14 },
  td: { flex: 1, color: T.text, fontSize: 14, textAlign: 'right', fontVariant: ['tabular-nums'] },
  bold: { fontWeight: '600' },
  neg: { color: T.danger },
  dim: { color: T.dim },
});
