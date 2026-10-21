/**
 * The rest of the Pricing page (PA-06, decisions PD4–PD6, PD9, PD14): the starter credit, the amounts people can buy and
 * the auto-reload caps, each with its figures now and an "Edit" form that says when its change applies, then the
 * history of every price change with when and which admin. Admins only: the history is never published (PD9).
 *
 * As on the task prices (PA-05), the page decides nothing the server doesn't check again: each form runs PA-02's
 * `priceBookChangeIssues` on the book its save would make, at the server's clock, says why in the rules' own plain
 * words and keeps "Save" disabled while they refuse. Saves go through the page's own handler (`onSend`), which says a
 * refusal and loads the page again. Everything shown is a text node; the history shows no id.
 */
import { formatBalance, formatPrice, priceIssuesText, REFERENCE_MODEL_LABELS, TASK_PRICE_NAMES } from '@unalgorithm/core';
import {
  type AutoReloadCaps,
  type CreditPriceCard,
  type CreditTask,
  PRICE_BOUNDS,
  type PriceBook,
  type PriceChange,
  type PriceChangeRequest,
  type PriceChangeValue,
  type PurchaseRules,
  priceBookChangeIssues,
  starterCreditAt,
  TASK_UNITS,
  withStarterCredit,
} from '@unalgorithm/protocol';
import { Button, Dialog, ListGroup, ListRow, Pencil, TextField } from '@unalgorithm/ui';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { dollarsInput, parseDollars } from './money.ts';
import { AddRow, Section } from './ui.tsx';

// Draft copy for Tom (decision PD14).
const STARTER_APPLIES = 'Applies to accounts created from now on. Accounts made earlier keep the amount they were offered.';
const PURCHASE_APPLIES =
  'Applies at once to new purchases. A payment already started still adds what was paid, and auto-reload keeps the ' +
  'amount each person agreed to.';
const AUTO_RELOAD_APPLIES =
  'Lowering a cap applies at once to everyone with auto-reload on. Raising one applies only to people who turn ' +
  'auto-reload on, or change it, from now on.';
const ENTER_AMOUNT = 'Enter an amount in dollars, like 1.00.';
const ENTER_DOLLARS = 'Enter whole dollars, like 10.';
const ENTER_PICKS = 'Enter whole dollars separated by commas, like 5, 10, 25.';
const PICK_PRESELECTED = 'Pick the preselected amount.';
const SHIPPED = 'No changes yet. These are the prices this server shipped with.';

/** Days as the account page writes them, in UTC: "Dec 3, 2026". */
const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const day = (iso: string): string => DATE.format(new Date(iso));
/** When a change was made: "Nov 2, 2026, 12:00 UTC". */
const madeAt = (iso: string): string => `${day(iso)}, ${new Date(iso).toISOString().slice(11, 16)} UTC`;
/** Whole dollars as people read them: "$5", "$1,000" (cents only when there are any). */
const usd = (micros: number): string => formatPrice(micros).replace(/\.00$/, '');
/** An amount as a whole-dollar field holds it: 5,000,000 → "5". */
const dollarsField = (micros: number): string => String(micros / 1_000_000);
/** "$5, $10 and $25". */
const listed = (items: readonly string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const topUps = (perDay: number): string => `${perDay} top-up${perDay === 1 ? '' : 's'} a day`;

/** "10" or "$10.00" → 10,000,000: an amount in whole dollars (`parseDollars`), or null for anything else. */
function parseWholeDollars(text: string): number | null {
  const micros = parseDollars(text);
  return micros !== null && micros % 1_000_000 === 0 ? micros : null;
}

/** "5, 10, 25" → whole dollars in the order typed (none for an empty field), or null when one isn't. */
function parseDollarList(text: string): number[] | null {
  if (text.trim() === '') return [];
  const amounts = text.split(',').map(parseWholeDollars);
  return amounts.every((micros) => micros !== null) ? (amounts as number[]) : null;
}

/** The part of the book a section sets: also its change request's action. */
export type SettingsPart = 'starter' | 'purchase' | 'auto-reload';

export interface SettingsSectionProps {
  book: PriceBook;
  version: string;
  /** The server's clock when it answered. */
  now: Date;
  /** This section's form is open. */
  open: boolean;
  /** Nothing is open or in flight, so "Edit" may open the form. */
  idle: boolean;
  /** This section's save is in flight. */
  busy: boolean;
  /** The refusal to show above the open form. */
  notice: ReactNode;
  onOpen(): void;
  onClose(): void;
  onSend(req: PriceChangeRequest): Promise<void>;
}

/** What a form's "Save" would do: the book it makes, and the request that asks for it. */
interface Change {
  head: PriceBook;
  request: PriceChangeRequest;
}

/**
 * A section of the page: its heading, the figures now and "Edit", which opens the section's form (`children`) in a
 * sheet titled `edit`.
 */
function SettingsSection({
  title,
  figures,
  edit,
  props,
  children,
}: {
  title: string;
  figures: string;
  /** The "Edit" row's accessible name and the sheet's title. */
  edit: string;
  props: SettingsSectionProps;
  children: ReactNode;
}) {
  const { open, idle, busy, onOpen, onClose } = props;
  return (
    <Section title={title}>
      <ListGroup>
        <ListRow title={figures} />
        <AddRow icon={Pencil} label="Edit" accessibleLabel={edit} disabled={!idle} onSelect={onOpen} />
      </ListGroup>
      <Dialog open={open} onOpenChange={(next) => (next || busy ? undefined : onClose())} className="web-sheet" title={edit}>
        {open ? children : null}
      </Dialog>
    </Section>
  );
}

/**
 * A section's form, mounted when it opens so it starts from the figures now: its fields, the "applies" line, the rules'
 * words for the book the save would make, "Save" (disabled until there is a change the rules allow) and "Cancel".
 * `change` is null while a field isn't readable or nothing would change.
 */
function SettingsForm({
  title,
  applies,
  change,
  props,
  children,
}: {
  title: string;
  applies: string;
  change: Change | null;
  props: SettingsSectionProps;
  children: ReactNode;
}) {
  const { book, now, busy, notice, onClose, onSend } = props;
  const issueText = change ? priceIssuesText(priceBookChangeIssues(book, change.head, now)) : '';
  const ready = change !== null && issueText === '';

  function onSave(e: FormEvent) {
    e.preventDefault();
    if (busy || !ready || !change) return;
    void onSend(change.request);
  }

  return (
    <form noValidate aria-label={title} onSubmit={onSave}>
      {notice}
      {children}
      <p className="web-form-note">{applies}</p>
      {issueText ? <p className="web-form-error">{issueText}</p> : null}
      <div className="web-form-actions">
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={busy || !ready}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** A native select with its label, as the task price form's reference model. */
function SelectField({
  label,
  value,
  error,
  onChange,
  children,
}: {
  label: string;
  value: string;
  error?: string;
  onChange(value: string): void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="ua-field">
      <label htmlFor={id} className="ua-field-label">
        {label}
      </label>
      <select
        id={id}
        className="ua-select"
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      {error ? (
        <div id={`${id}-error`} className="ua-field-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** The starter credit new accounts get, set from the moment it is saved (decision PD4). */
export function StarterCreditSection(props: SettingsSectionProps) {
  const starter = starterCreditAt(props.now, props.book);
  return (
    <SettingsSection
      title="Starter credit"
      figures={`New accounts get ${formatBalance(starter.amountMicros)} of starter credit, for ${starter.expiresAfterDays} days.`}
      edit="Edit the starter credit"
      props={props}
    >
      <StarterCreditForm {...props} />
    </SettingsSection>
  );
}

function StarterCreditForm(props: SettingsSectionProps) {
  const { book, version, now } = props;
  const [text, setText] = useState(() => dollarsInput(starterCreditAt(now, book).amountMicros));
  const amount = parseDollars(text);
  // `withStarterCredit` answers the book itself for the amount already set: nothing to save.
  const head = amount === null ? book : withStarterCredit(book, amount, now);
  const change: Change | null =
    amount === null || head === book
      ? null
      : { head, request: { action: 'starter', baseVersion: version, amountMicros: amount } };
  return (
    <SettingsForm title="Starter credit" applies={STARTER_APPLIES} change={change} props={props}>
      <TextField
        label="Amount"
        autoFocus
        inputMode="decimal"
        autoComplete="off"
        value={text}
        hint="In dollars, whole cents."
        error={amount === null ? ENTER_AMOUNT : undefined}
        onChange={(e) => setText(e.target.value)}
      />
    </SettingsForm>
  );
}

/** The amounts people can buy: the least, the most, the quick picks and the one preselected (decision PD5). */
export function PurchaseSection(props: SettingsSectionProps) {
  const rules = props.book.purchase;
  const picks = rules.presetsMicros.map(usd);
  return (
    <SettingsSection
      title="Buying credit"
      figures={
        `Any amount from ${usd(rules.minMicros)} to ${usd(rules.maxMicros)}. ` +
        `Quick ${picks.length === 1 ? 'pick' : 'picks'} ${listed(picks)}, with ${usd(rules.defaultMicros)} preselected.`
      }
      edit="Edit the buying credit amounts"
      props={props}
    >
      <PurchaseForm {...props} />
    </SettingsSection>
  );
}

const samePurchase = (a: PurchaseRules, b: PurchaseRules): boolean =>
  a.minMicros === b.minMicros &&
  a.maxMicros === b.maxMicros &&
  a.defaultMicros === b.defaultMicros &&
  a.presetsMicros.join() === b.presetsMicros.join();

function PurchaseForm(props: SettingsSectionProps) {
  const { book, version } = props;
  const rules = book.purchase;
  const [leastText, setLeastText] = useState(() => dollarsField(rules.minMicros));
  const [mostText, setMostText] = useState(() => dollarsField(rules.maxMicros));
  const [picksText, setPicksText] = useState(() => rules.presetsMicros.map(dollarsField).join(', '));
  const [preselected, setPreselected] = useState(rules.defaultMicros);
  const least = parseWholeDollars(leastText);
  const most = parseWholeDollars(mostText);
  const presets = parseDollarList(picksText);
  // The preselected amount stays chosen while it is among the picks typed.
  const chosen = presets?.includes(preselected) ? preselected : null;
  const purchase: PurchaseRules | null =
    least !== null && most !== null && presets !== null && chosen !== null
      ? { minMicros: least, maxMicros: most, presetsMicros: presets, defaultMicros: chosen }
      : null;
  const change: Change | null =
    purchase === null || samePurchase(purchase, rules)
      ? null
      : { head: { ...book, purchase }, request: { action: 'purchase', baseVersion: version, purchase } };
  return (
    <SettingsForm title="Buying credit" applies={PURCHASE_APPLIES} change={change} props={props}>
      <TextField
        label="Least"
        autoFocus
        inputMode="numeric"
        autoComplete="off"
        value={leastText}
        hint="Whole dollars."
        error={least === null ? ENTER_DOLLARS : undefined}
        onChange={(e) => setLeastText(e.target.value)}
      />
      <TextField
        label="Most"
        inputMode="numeric"
        autoComplete="off"
        value={mostText}
        hint="Whole dollars."
        error={most === null ? ENTER_DOLLARS : undefined}
        onChange={(e) => setMostText(e.target.value)}
      />
      <TextField
        label="Quick picks"
        autoComplete="off"
        value={picksText}
        hint="Whole dollars, separated by commas, smallest first."
        error={presets === null ? ENTER_PICKS : undefined}
        onChange={(e) => setPicksText(e.target.value)}
      />
      <SelectField
        label="Preselected"
        value={chosen === null ? '' : String(chosen)}
        error={presets !== null && chosen === null ? PICK_PRESELECTED : undefined}
        onChange={(value) => setPreselected(Number(value))}
      >
        {chosen === null ? <option value="">Pick one</option> : null}
        {(presets ?? []).map((micros, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: picks may repeat while typed (the rules then refuse them)
          <option key={i} value={String(micros)}>
            {usd(micros)}
          </option>
        ))}
      </SelectField>
    </SettingsForm>
  );
}

/** The caps on automatic purchases: the most a person may set a month, and top-ups a day (decision PD6). */
export function AutoReloadSection(props: SettingsSectionProps) {
  const caps = props.book.autoReload;
  return (
    <SettingsSection
      title="Auto-reload"
      figures={`Auto-reload: at most ${usd(caps.monthlyLimitMaxMicros)} a month and ${topUps(caps.perDay)}.`}
      edit="Edit the auto-reload caps"
      props={props}
    >
      <AutoReloadForm {...props} />
    </SettingsSection>
  );
}

function AutoReloadForm(props: SettingsSectionProps) {
  const { book, version } = props;
  const caps = book.autoReload;
  const [monthlyText, setMonthlyText] = useState(() => dollarsField(caps.monthlyLimitMaxMicros));
  const [perDay, setPerDay] = useState(caps.perDay);
  const monthly = parseWholeDollars(monthlyText);
  const autoReload: AutoReloadCaps | null = monthly === null ? null : { monthlyLimitMaxMicros: monthly, perDay };
  const change: Change | null =
    autoReload === null || (monthly === caps.monthlyLimitMaxMicros && perDay === caps.perDay)
      ? null
      : { head: { ...book, autoReload }, request: { action: 'auto-reload', baseVersion: version, autoReload } };
  // 1 to the bound; a stored figure outside it stays shown as it is, and the rules ask for another.
  const counts = Array.from({ length: PRICE_BOUNDS.perDay.max }, (_, i) => i + 1);
  if (!counts.includes(perDay)) counts.push(perDay);
  return (
    <SettingsForm title="Auto-reload caps" applies={AUTO_RELOAD_APPLIES} change={change} props={props}>
      <TextField
        label="Most a month"
        autoFocus
        inputMode="numeric"
        autoComplete="off"
        value={monthlyText}
        hint="Whole dollars: the most one person may set."
        error={monthly === null ? ENTER_DOLLARS : undefined}
        onChange={(e) => setMonthlyText(e.target.value)}
      />
      <SelectField label="Top-ups a day" value={String(perDay)} onChange={(value) => setPerDay(Number(value))}>
        {counts.map((n) => (
          <option key={n} value={String(n)}>
            {n}
          </option>
        ))}
      </SelectField>
    </SettingsForm>
  );
}

const isCard = (v: PriceChangeValue): v is CreditPriceCard => typeof v === 'object' && v !== null && 'multiplier' in v;
const isPurchase = (v: PriceChangeValue): v is PurchaseRules => typeof v === 'object' && v !== null && 'presetsMicros' in v;
const isCaps = (v: PriceChangeValue): v is AutoReloadCaps => typeof v === 'object' && v !== null && 'perDay' in v;

/** One part of a change: its name, its value before and after, and what follows the values. */
type Part = readonly [name: string, before: string, after: string, rest?: string];
/** "multiplier 2× → 2.5×; at most $0.40 → $0.50": the parts that differ, in order; "no change" when none does. */
function differences(parts: readonly Part[]): string {
  const changed = parts.filter(([, before, after]) => before !== after);
  if (changed.length === 0) return 'no change';
  return changed.map(([name, before, after, rest = '']) => `${name}${before} → ${after}${rest}`).join('; ');
}

/** A card's parts as the history compares them, exact: our cost per unit, or per 1,000 posts for classify. */
function cardParts(task: CreditTask, card: CreditPriceCard) {
  const job = task !== 'classify';
  return {
    multiplier: `${card.multiplier}×`, // U+00D7
    model: REFERENCE_MODEL_LABELS[card.referenceModel] ?? card.referenceModel,
    // A job's cost per 1,000 units in micro-dollars is its cost per unit in nano-dollars.
    cost: `$${dollarsInput(card.referenceCostMicrosPer1000, job ? 9 : 6)}`,
    per: job ? ` per ${TASK_UNITS[task]}` : ' per 1,000 posts',
    cap: card.maxChargeMicros === undefined ? 'no limit' : `$${dollarsInput(card.maxChargeMicros)}`,
  };
}

/** A scheduled card in words: a first price, or the parts that differ from the card it replaces. */
function scheduleLine(task: CreditTask, when: string, before: PriceChangeValue, after: PriceChangeValue): string {
  const name = TASK_PRICE_NAMES[task];
  if (!isCard(after)) return `${name} from ${when}: a new price`;
  const is = cardParts(task, after);
  if (!isCard(before)) {
    const cap = after.maxChargeMicros === undefined ? '' : `, at most ${is.cap} for one ${TASK_UNITS[task]}`;
    return `${name} priced from ${when}: ${is.multiplier} our AI cost${cap}`;
  }
  const was = cardParts(task, before);
  return `${name} from ${when}: ${differences([
    ['multiplier ', was.multiplier, is.multiplier],
    ['reference model ', was.model, is.model],
    ['our cost ', was.cost, is.cost, is.per],
    ['at most ', was.cap, is.cap],
  ])}`;
}

/** One stored price change in words (draft copy, decision PD14): what changed, with only the parts that differ. */
export function priceChangeLine(change: PriceChange): string {
  const { action, before, after } = change;
  // Only the schedule's own changes have a task and a date; the fallbacks keep a broken row readable.
  const task = change.task ?? 'classify';
  const when = day(change.effectiveFrom ?? change.at);
  switch (action) {
    case 'seed':
      return 'Stored the prices this server shipped with';
    case 'schedule':
      return scheduleLine(task, when, before, after);
    case 'cancel':
      return `Cancelled the ${TASK_PRICE_NAMES[task]} change from ${when}`;
    case 'move':
      return `Moved the ${TASK_PRICE_NAMES[task]} change from ${when} to ${day(change.movedTo ?? change.at)}`;
    case 'starter':
      if (typeof before !== 'number' || typeof after !== 'number') return 'Starter credit changed';
      return `Starter credit: ${formatBalance(before)} → ${formatBalance(after)}`;
    case 'purchase':
      if (!isPurchase(before) || !isPurchase(after)) return 'Buying credit changed';
      return `Buying credit: ${differences([
        ['least ', usd(before.minMicros), usd(after.minMicros)],
        ['most ', usd(before.maxMicros), usd(after.maxMicros)],
        ['quick picks ', before.presetsMicros.map(usd).join(', '), after.presetsMicros.map(usd).join(', ')],
        ['preselected ', usd(before.defaultMicros), usd(after.defaultMicros)],
      ])}`;
    case 'auto-reload':
      if (!isCaps(before) || !isCaps(after)) return 'Auto-reload caps changed';
      return `Auto-reload: ${differences([
        ['at most ', usd(before.monthlyLimitMaxMicros), usd(after.monthlyLimitMaxMicros), ' a month'],
        ['', String(before.perDay), String(after.perDay), ' top-ups a day'],
      ])}`;
  }
}

/** Every price change, newest first, each with when it was made (UTC) and by which admin. Admins only (PD9). */
export function PriceHistory({ changes }: { changes: readonly PriceChange[] }) {
  return (
    <Section title="History" description="Every change, newest first, with when it was made and by whom. Only admins see it.">
      <ListGroup>
        {changes.length === 0 ? (
          <ListRow title={<span className="ua-secondary">{SHIPPED}</span>} />
        ) : (
          [...changes]
            .sort((a, b) => b.seq - a.seq)
            .map((change) => (
              <ListRow
                key={change.seq}
                title={priceChangeLine(change)}
                subtitle={`${madeAt(change.at)} · by ${change.by ?? 'a deleted account'}`}
              />
            ))
        )}
      </ListGroup>
    </Section>
  );
}
