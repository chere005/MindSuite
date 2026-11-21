/**
 * The transaction form, shared by the phone's modal (AddTransaction) and the
 * wide layout's detail pane (TxnEditor).
 *
 * The form holds a `Draft` and asks core whether it is any good; it never
 * decides that itself. `useTxnForm` owns the state and `submit`; the two
 * callers only choose where the fields and the buttons sit.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  amountDigits, amountField, amountInput, amountKeyed, amountSeed, draftOf, emptyDraft,
  autoCategory, formatAmount, formatDay, isValid, signedCents, today, validateDraft,
  type Account, type AmountMode, type Category, type CategoryChoice, type CategoryRule, type Draft, type DraftErrors, type Txn,
} from '@acctmind/core';
import { CategoryPick } from './CategoryPick';
import { DayPicker } from './DayPicker';
import { Toggle } from './Toggle';
import { SPACE, T, TAP } from './theme';

export type TxnFormProps = {
  /** Is the form on screen? A false-to-true change reseeds it. */
  active: boolean;
  onSave: (draft: Draft, cleared: boolean) => void;
  editing?: Txn | undefined;
  account: string;
  category?: string | null | undefined;
  categories: readonly Category[];
  lines: readonly CategoryChoice[];
  rules: readonly CategoryRule[];
  mode: AmountMode;
  /** The wide pane's Account field. */
  accounts?: readonly Account[];
};

export function useTxnForm({
  active, onSave, editing, mode, account, category = null, categories, lines, rules, accounts = [],
}: TxnFormProps) {
  const seed = (): Draft => (editing === undefined ? emptyDraft(today(), account, category) : draftOf(editing));
  const [draft, setDraft] = useState<Draft>(seed);
  const [cleared, setCleared] = useState(editing?.cleared === true);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [picking, setPicking] = useState(false);
  const [pickedCategory, setPickedCategory] = useState(false);
  /**
   * What has actually been typed, and the sign held beside it.
   *
   * TWO pieces of state, not one string with a `-` on the front. The owner,
   * 2026-08-21: "don't show the - in the input field and only allow numbers
   * to be typed." The field draws digits; the − button draws the sign; core's
   * `signedCents` is the only place they meet.
   *
   * Both kept separately from `draft.amount`, which holds a CANONICAL string
   * (`-4.50`) that `validateDraft` and `parseAmount` understand without
   * knowing this screen exists. Two representations, one direction: typing
   * updates both, and core never sees the half-finished one.
   */
  const [digits, setDigits] = useState(() => (editing === undefined ? '' : amountSeed(seed().amount, mode)));
  const [negative, setNegative] = useState(() => (editing === undefined ? true : seed().amount.trimStart().startsWith('-')));
  
  // Opening is a fresh form, dated today. Computed on the transition rather
  // than in an effect, so the first render already has the right values and
  // there is no frame showing the last transaction's text.
  const [wasVisible, setWasVisible] = useState(active);
  if (active !== wasVisible) {
    setWasVisible(active);
    if (active) {
      setCleared(editing?.cleared === true);
      const start = editing === undefined
        ? emptyDraft(today(), account, category)
        : draftOf(editing);
      setDraft(start);
      setPickedCategory(false);
      setErrors({});
      setPicking(false);
      /*
       * A NEW transaction starts negative — the owner, 2026-08-21.
       *
       * Almost everything in a ledger is money going out; income is a handful
       * of rows a month. Starting positive means tapping − on nearly every
       * entry, and the one that gets forgotten is a payment recorded as
       * income, which is wrong by twice its own size.
       *
       * A lone '-' is not an amount, so the form still says "Amount is
       * required" until something is typed — the sign is a default, not a
       * value.
       *
       * An EDIT is seeded from the canonical string instead: '4.50' carries
       * its own dot and so reads the same under either entry mode, where
       * '450' would reopen at $4.50 having saved $450.00. Core's
       * `amountSeed` makes the one exception: a round amount under Whole
       * dollars opens as '1450', drawn '$1,450', so the next key is dollars
       * rather than a third decimal.
       */
      setDigits(amountSeed(start.amount, mode));
      setNegative(editing === undefined ? true : start.amount.trimStart().startsWith('-'));
    }
  }

  const set = (field: keyof Draft) => (text: string) => {
    setDraft((d) => ({ ...d, [field]: text }));
    // Clear a field's complaint as soon as it is touched — leaving it up
    // while someone fixes it reads as the app not noticing.
    setErrors((e) => (e[field] === undefined ? e : { ...e, [field]: undefined }));
  };

  /** Every route into the amount — the keys and the − button. */
  const setAmount = (rawText: string, sign: boolean) => {
    const text = amountDigits(rawText);
    setDigits(text);
    setNegative(sign);
    const cents = signedCents(text, sign, mode);
    /*
     * There are two ways to have no amount, and they deserve different
     * sentences.
     *
     *  · Nothing typed, or only a sign or a dot -> an EMPTY draft amount, so
     *    core says "Amount is required". True of a field nobody has finished.
     *  · Digits that do not make an amount — `1.005`, which this app refuses
     *    to round — -> hand core the RAW text so `parseAmount` judges it and
     *    says "That is not an amount". Reporting that one as "required" would
     *    be telling someone who typed something that they typed nothing.
     *
     * When it IS an amount the draft gets the CANONICAL string, never the raw
     * text: `1234` in cents mode is $12.34, and `parseAmount('1234')` is
     * $1,234.00. Handing the raw text over would silently multiply by a
     * hundred at the last step.
     */
    const anyDigits = /[0-9]/.test(text);
    setDraft((d) => ({
      ...d,
      amount: cents !== null ? amountInput(cents) : anyDigits ? text : '',
    }));
    setErrors((e) => (e.amount === undefined ? e : { ...e, amount: undefined }));
  };

  const cents = signedCents(digits, negative, mode);
  const categoryValue = editing === undefined && !pickedCategory ? autoCategory(draft, rules) : draft.category;

  const submit = () => {
    const found = validateDraft(draft);
    setErrors(found);
    // Every bad field at once. A form that reports one at a time costs a
    // round trip per mistake.
    if (isValid(found)) onSave({ ...draft, category: categoryValue }, cleared);
  };


  const dayPicker = (
    <DayPicker
      visible={picking}
      value={draft.date}
      onPick={(day) => { set('date')(day); setPicking(false); }}
      onCancel={() => setPicking(false)}
    />
  );

  /** The phone's fields, in the phone's order. */
  const phoneFields = (
    <>
            <Field label="Name" error={errors.name}>
              <View style={styles.nameRow}>
              <TextInput
                value={draft.name}
                onChangeText={set('name')}
                style={[styles.input, styles.nameField]}
                placeholder="Coffee"
                placeholderTextColor={T.faint}
                autoFocus
                /*
                 * Return SAVES — the owner, 2026-08-21, from the Mac.
                 *
                 * On a keyboard the form is three fields and a button, and
                 * reaching for the mouse to finish something you have just
                 * typed is the slowest part of entering a transaction. It was
                 * `next`, which on a desktop does nothing anyone asked for.
                 *
                 * Wired the same on every surface rather than only on the
                 * one that asked. Six surfaces disagreeing about what Return
                 * does is a rule written five different ways; and on a phone
                 * "done" is a better key than "next" here anyway, because the
                 * amount is the only field left and it opens its own keypad.
                 */
                returnKeyType="done"
                onSubmitEditing={submit}
                testID="name-input"
              />
              {/*
                The date, as a calendar next to the name. It starts on today
                and most transactions are entered on the day they happen, so
                it earns a glyph rather than a field: the day it shows is the
                answer nearly every time, and it is one tap when it is not.
              */}
              <Pressable
                onPress={() => setPicking(true)}
                style={styles.calBtn}
                accessibilityRole="button"
                accessibilityLabel={`Date, ${formatDay(draft.date)}`}
                testID="date-button"
              >
                <CalendarIcon day={draft.date} />
                {/* The date reads INSIDE the button that changes it. It used
                    to be a line of dim text under the whole field — an
                    unlabelled `Aug 21` floating below the name box, which is
                    a thing to wonder about rather than a thing to read. Next
                    to the icon it is the button's own caption. */}
                <Text style={styles.calDate} testID="date-value">{formatDay(draft.date)}</Text>
              </Pressable>
              </View>
            </Field>

            <Field label="Category">
              <CategoryPick
                categories={categories}
                lines={lines}
                value={categoryValue}
                onPick={(id) => {
                  setPickedCategory(true);
                  setDraft((d) => ({ ...d, category: id }));
                }}
              />
            </Field>

            <Field label="Description" error={errors.description}>
              <TextInput
                value={draft.description}
                onChangeText={set('description')}
                style={[styles.input, styles.multiline]}
                placeholder="Optional"
                placeholderTextColor={T.faint}
                multiline
                testID="description-input"
              />
            </Field>

            <Field label="Amount" error={errors.amount}>
              <View style={styles.amountRow}>
                {/* Left of the field: the sign is read before the number,
                    so it is reached before the number too. */}
                <Toggle
                  label="−"
                  on={negative}
                  onPress={() => setAmount(digits, !negative)}
                  accessibilityLabel="Negative"
                  testID="sign-toggle"
                />
                <TextInput
                  /*
                   * What the digits MEAN, drawn in the cell, and UNSIGNED —
                   * the − to the left of it is what says negative. Core's
                   * `amountField` draws it and `amountKeyed` reads the next
                   * keystroke back off that drawing, and the pair is held to
                   * one property (spec/money.json `key`): the drawing reads
                   * back as the same amount, in the same mode.
                   *
                   * That property is the fix for the owner's "whole dollars is
                   * broken on macos", 2026-09-30. This cell drew
                   * `formatAmount` in both modes, so Whole dollars drew `1`
                   * as `$1.00`, the next key arrived as `$1.004`, and the
                   * digits read off it were $1,004.00 — 1, 4, 5, 0 typed by
                   * hand was $1,004,005,000.00. Every Whole-dollars test
                   * filled the field wholesale, which is why none saw it. Whole
                   * dollars now draws `$1,450`, and a typed dot as typed
                   * (`$12.3`); cents mode draws exactly what it always did.
                   *
                   * Which is why the reader is handed `digits` too: cents
                   * draws a typed `12.` as `$12.00`, and only the digits can
                   * say those zeros are padding. Read off the drawing alone,
                   * 1, 2, ., 5 was $120.05 — and Backspace on `$0.01` drew
                   * `$0.00` for ever, never the placeholder.
                   *
                   * The raw digits stay in `digits` and are what the rules
                   * read; this is only what is drawn.
                   */
                  value={amountField(digits, mode)}
                  // The sign is not typed and is not read back out of the
                  // text: it rides along untouched from the button.
                  onChangeText={(next) => setAmount(amountKeyed(next, digits, mode), negative)}
                  style={[styles.input, styles.amountField]}
                  placeholder={mode === 'whole' ? '0' : '0.00'}
                  placeholderTextColor={T.faint}
                  // A NUMBER pad, which has no minus key — and now that the
                  // sign lives entirely in the − button, a minus key would be
                  // one that does nothing. The note that used to sit here
                  // said the opposite, back when a leading '-' was a second
                  // supported way to enter an expense.
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  returnKeyType="done"
                  onSubmitEditing={submit}
                  testID="amount-input"
                />
              </View>
              {/* Kept for the tests and the screen reader: the whole amount,
                  signed and with its cents — `-$1,450.00` where Whole dollars
                  draws `$1,450` in the cell beside the − button. */}
              <Text
                style={styles.previewHidden}
                accessibilityElementsHidden
                testID="amount-preview"
              >
                {cents === null ? '' : formatAmount(cents)}
              </Text>
            </Field>

    </>
  );

  /** The detail pane's fields: Name, Amount, Date, Account, Category, Description, Cleared. */
  const wideFields = (
    <>
      <Field label="Name" error={errors.name}>
        <TextInput
          value={draft.name}
          onChangeText={set('name')}
          style={[styles.input, styles.inputWide]}
          placeholder="Coffee"
          placeholderTextColor={T.faint}
          autoFocus={editing === undefined}
          returnKeyType="done"
          onSubmitEditing={submit}
          testID="name-input"
        />
      </Field>
      <Field label="Amount" error={errors.amount}>
        <View style={styles.amountRow}>
          <Toggle
            label="−"
            on={negative}
            onPress={() => setAmount(digits, !negative)}
            accessibilityLabel="Negative"
            testID="sign-toggle"
            style={styles.toggleWide}
          />
          <TextInput
            value={amountField(digits, mode)}
            onChangeText={(next) => setAmount(amountKeyed(next, digits, mode), negative)}
            style={[styles.input, styles.inputWide, styles.amountField, styles.right]}
            placeholder={mode === 'whole' ? '0' : '0.00'}
            placeholderTextColor={T.faint}
            keyboardType="decimal-pad"
            inputMode="decimal"
            returnKeyType="done"
            onSubmitEditing={submit}
            testID="amount-input"
          />
        </View>
        <Text style={styles.previewHidden} accessibilityElementsHidden testID="amount-preview">
          {cents === null ? '' : formatAmount(cents)}
        </Text>
      </Field>
      <Field label="Date">
        <View style={styles.dateRow}>
          <Pressable
            onPress={() => setPicking(true)}
            style={styles.pill}
            accessibilityRole="button"
            accessibilityLabel={`Date, ${formatDay(draft.date)}`}
            testID="date-button"
          >
            <Text style={styles.pillText} testID="date-value">{formatDay(draft.date)}</Text>
          </Pressable>
          <Pressable onPress={() => set('date')(today())} style={styles.pill} accessibilityRole="button" testID="date-today">
            <Text style={styles.pillText}>Today</Text>
          </Pressable>
        </View>
      </Field>
      {accounts.length > 0 && (
        <Field label="Account" error={errors.account}>
          <AccountSelect accounts={accounts} value={draft.account} onPick={set('account')} />
        </Field>
      )}
      <Field label="Category">
        <CategoryPick
          categories={categories}
          lines={lines}
          compact
          value={categoryValue}
          onPick={(id) => {
            setPickedCategory(true);
            setDraft((d) => ({ ...d, category: id }));
          }}
        />
      </Field>
      <Field label="Description" error={errors.description}>
        <TextInput
          value={draft.description}
          onChangeText={set('description')}
          style={[styles.input, styles.inputWide, styles.multilineWide]}
          placeholder="Optional"
          placeholderTextColor={T.faint}
          multiline
          testID="description-input"
        />
      </Field>
      <Pressable
        onPress={() => setCleared((c) => !c)}
        style={styles.clearedRow}
        accessibilityRole="switch"
        accessibilityState={{ checked: cleared }}
        accessibilityLabel="Cleared"
        testID="cleared-switch"
      >
        <Text style={styles.pillText}>Cleared</Text>
        <View style={[styles.track, cleared && styles.trackOn]}>
          <View style={[styles.knob, cleared && styles.knobOn]} />
        </View>
      </Pressable>
    </>
  );

  return { submit, phoneFields, wideFields, dayPicker };
}

/** A short list of accounts, open in place. */
function AccountSelect({ accounts, value, onPick }: {
  accounts: readonly Account[]; value: string; onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = accounts.find((a) => a.id === value);
  return (
    <View>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        style={styles.select}
        accessibilityRole="button"
        accessibilityLabel="Account"
        testID="account-select"
      >
        <Text style={[styles.pillText, styles.grow]} numberOfLines={1}>{current?.name ?? 'Pick an account'}</Text>
        <Text style={styles.chev}>⌄</Text>
      </Pressable>
      {open && (
        <View style={styles.options}>
          {accounts.map((a) => (
            <Pressable
              key={a.id}
              onPress={() => { onPick(a.id); setOpen(false); }}
              style={styles.option}
              accessibilityRole="button"
              testID={`account-opt-${a.id}`}
            >
              <Text style={styles.pillText}>{a.name}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

/** A little calendar showing the day it will file the transaction under. */
function CalendarIcon({ day }: { day: string }) {
  return (
    <View style={styles.cal}>
      <View style={styles.calTop} />
      <Text style={styles.calDay}>{Number(day.slice(8, 10))}</Text>
    </View>
  );
}

function Field({ label, error, children }: {
  label: string; error?: string | undefined; children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {error !== undefined && (
        <Text style={styles.error} testID={`error-${label.toLowerCase()}`}>{error}</Text>
      )}
    </View>
  );
}

export const styles = StyleSheet.create({
  inputWide: { fontSize: 14, minHeight: 36, paddingVertical: 6, borderRadius: 8 },
  multilineWide: { minHeight: 72, textAlignVertical: 'top' },
  right: { textAlign: 'right', fontVariant: ['tabular-nums'] },
  toggleWide: { width: 36, height: 36, borderRadius: 8 },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  pill: {
    minHeight: 32, paddingHorizontal: SPACE.md, borderRadius: 16, justifyContent: 'center',
    backgroundColor: T.card, borderWidth: StyleSheet.hairlineWidth, borderColor: T.cardEdge,
  },
  pillText: { color: T.text, fontSize: 14 },
  grow: { flex: 1 },
  chev: { color: T.dim, fontSize: 13 },
  select: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 36, borderRadius: 8,
    paddingHorizontal: SPACE.md, backgroundColor: T.card,
    borderWidth: StyleSheet.hairlineWidth, borderColor: T.cardEdge,
  },
  options: {
    marginTop: 4, borderRadius: 8, overflow: 'hidden', backgroundColor: T.card,
    borderWidth: StyleSheet.hairlineWidth, borderColor: T.cardEdge,
  },
  option: { minHeight: 34, justifyContent: 'center', paddingHorizontal: SPACE.md },
  clearedRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36 },
  track: { width: 40, height: 24, borderRadius: 12, backgroundColor: T.faint, padding: 2, justifyContent: 'center' },
  trackOn: { backgroundColor: T.positive },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  knobOn: { alignSelf: 'flex-end' },
  fill: { flex: 1, backgroundColor: T.bg },
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: T.cardEdge,
  },
  barBtn: { minHeight: TAP, minWidth: 72, justifyContent: 'center', paddingHorizontal: SPACE.sm },
  barText: { color: T.accent, fontSize: 16 },
  barSave: { fontWeight: '700', textAlign: 'right' },
  barTitle: { color: T.text, fontSize: 17, fontWeight: '600' },
  body: { padding: SPACE.lg, gap: SPACE.lg },
  field: { gap: SPACE.xs },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  nameField: { flex: 1 },
  calBtn: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.xs,
    minHeight: TAP, paddingHorizontal: SPACE.sm, borderRadius: 10,
    backgroundColor: T.card, borderWidth: StyleSheet.hairlineWidth, borderColor: T.cardEdge,
  },
  calDate: { color: T.text, fontSize: 14, fontWeight: '600' },
  cal: {
    width: 26, height: 26, borderRadius: 5, overflow: 'hidden',
    borderWidth: 1.5, borderColor: T.dim, alignItems: 'center', justifyContent: 'flex-end',
  },
  calTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 6, backgroundColor: T.dim },
  calDay: { color: T.text, fontSize: 13, fontWeight: '700', lineHeight: 17 },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  amountField: { flex: 1 },
  // A non-breaking space holds the line's height when there is nothing to
  // show, so the form does not jump on the first keystroke.
  previewHidden: { height: 0, opacity: 0 },
  label: { color: T.dim, fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.6 },
  input: {
    backgroundColor: T.card, color: T.text, fontSize: 17, borderRadius: 10,
    paddingHorizontal: SPACE.md, paddingVertical: SPACE.md, minHeight: TAP,
    borderWidth: StyleSheet.hairlineWidth, borderColor: T.cardEdge,
  },
  multiline: { minHeight: TAP * 2, textAlignVertical: 'top' },
  dateBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dateText: { color: T.text, fontSize: 17 },
  dateHint: { color: T.accent, fontSize: 15 },
  error: { color: T.danger, fontSize: 13 },
});
