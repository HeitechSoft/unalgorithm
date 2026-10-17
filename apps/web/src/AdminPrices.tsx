/**
 * The Pricing page every server serves at `/admin/prices` (PA-05, decisions PD3, PD7, PD12, PD14): an admin sees, for
 * each task, the price in effect and the scheduled changes, each with what people are shown for it; schedules a change
 * of one task's price from a day; and cancels or moves a scheduled change, through PA-03's routes. Its session flow is
 * the admin page's (`useAdminSession`).
 *
 * The page decides nothing the server doesn't check again: as the admin types it runs the same edits (PA-01) and rules
 * (PA-02's `priceBookChangeIssues`) as the server's save, at the server's clock (`now` in its answer, never the
 * browser's), says why in the rules' own plain words, and keeps "Save" disabled while they refuse. The preview is
 * `taskPriceLines`: the account page's, the website's and the extension's own wording. Every save is followed by the
 * page loading again; a refusal is said in the server's words (400) or the page's (404, 409).
 *
 * After the task prices come the starter credit, buying credit and auto-reload sections, then the history of every
 * change (PA-06, `AdminPriceSettings.tsx`); their saves go through the same handler, one open form at a time.
 */
import { priceIssuesText, REFERENCE_MODEL_LABELS, TASK_PRICE_NAMES, taskPriceLines } from '@unalgorithm/core';
import {
  ADMIN_PRICES_PAGE_PATH,
  type CardChangeKind,
  CREDIT_TASKS,
  type CreditPriceCard,
  type CreditTask,
  cancelTaskChange,
  cardChangeKind,
  earliestStart,
  moveTaskChange,
  nextMidnight,
  PRICE_NOTICE_DAYS,
  type PriceBook,
  type PriceChangeRequest,
  priceBookChangeIssues,
  priceScheduleIssues,
  REFERENCE_MODELS,
  scheduledTaskChanges,
  TASK_UNITS,
  taskPriceAt,
  withTaskCard,
} from '@unalgorithm/protocol';
import { Banner, Button, ListGroup, ListRow, TextField } from '@unalgorithm/ui';
import { type FormEvent, Fragment, type ReactNode, useId, useState } from 'react';
import { AdminGate, useAdminSession } from './Admin.tsx';
import {
  AutoReloadSection,
  PriceHistory,
  PurchaseSection,
  type SettingsPart,
  type SettingsSectionProps,
  StarterCreditSection,
} from './AdminPriceSettings.tsx';
import { ApiError, adminPrices, changePrices } from './api.ts';
import { dollarsInput, fromUtcDayInput, parseDollars, parseMultiplier, utcDayInput } from './money.ts';
import { Page } from './Page.tsx';
import { failureMessage } from './SignIn.tsx';

// Draft copy for Tom (decision PD14).
const TITLE = 'Pricing';
const INTRO =
  'What people pay on this server. A price change starts at 00:00 UTC on the day you pick. Prices in effect never ' +
  `change: a raise needs ${PRICE_NOTICE_DAYS} days' notice, and a cut can start tomorrow.`;
const NO_BILLING = "This server doesn't charge for AI, so these prices aren't used until a billing module is loaded.";
const CHANGED = 'The prices changed since you opened this page.';
const GONE = 'That scheduled change is no longer on the list.';
const ENTER_AMOUNT = 'Enter an amount in dollars, like 0.12.';
const ENTER_MULTIPLIER = 'Enter a multiplier, like 2 or 1.5.';
const PICK_DAY = 'Pick a day.';
const NO_CANCEL = `Once its date is less than ${PRICE_NOTICE_DAYS} days away, it can't be cancelled.`;
const CUT_QUESTION = `Save this cut? ${NO_CANCEL}`;

/** Days as the account page writes them, in UTC: "Dec 3, 2026". */
const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const day = (iso: string): string => DATE.format(new Date(iso));

type Card = Readonly<CreditPriceCard>;
const isJob = (task: CreditTask): task is Exclude<CreditTask, 'classify'> => task !== 'classify';

/** What the page has open, one at a time: a task's form, a scheduled change's move or cancel step, or a section's form. */
type Open =
  | { kind: 'form'; task: CreditTask }
  | { kind: 'move' | 'cancel'; task: CreditTask; effectiveFrom: string }
  | { kind: SettingsPart };
/** What the page says after a refused change; `reload` adds "Reload". */
type Notice = { title: string; reload?: boolean };

/**
 * A card as the admin set it: "2× our AI cost · Claude Haiku 5.5 · our cost $0.073 per 1,000 posts", or for a job
 * "… · our cost $0.12 per check · at most $0.40 for one check". Exact amounts, never rounded to the cent.
 */
function cardSummary(task: CreditTask, card: Card): string {
  const unit = TASK_UNITS[task];
  const parts = [`${card.multiplier}× our AI cost`, REFERENCE_MODEL_LABELS[card.referenceModel] ?? card.referenceModel]; // U+00D7
  if (!isJob(task)) return [...parts, `our cost $${dollarsInput(card.referenceCostMicrosPer1000)} per 1,000 posts`].join(' · ');
  // A job's cost per 1,000 units in micro-dollars is its cost per unit in nano-dollars.
  parts.push(`our cost $${dollarsInput(card.referenceCostMicrosPer1000, 9)} per ${unit}`);
  if (card.maxChargeMicros !== undefined) parts.push(`at most $${dollarsInput(card.maxChargeMicros)} for one ${unit}`);
  return parts.join(' · ');
}

/** What people are shown, one line each. */
function PriceLines({ lines }: { lines: readonly string[] }) {
  return (
    <>
      {lines.map((line) => (
        <span key={line} style={{ display: 'block' }}>
          {line}
        </span>
      ))}
    </>
  );
}

export function AdminPrices() {
  const session = useAdminSession(TITLE, adminPrices);
  const { info, heading, step, reload, sessionEnded } = session;
  const [open, setOpen] = useState<Open | null>(null);
  /** The request in flight: 'save', 'move' or 'cancel'. */
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  if (step.name !== 'loaded' || !info) {
    return <AdminGate session={session} intro={INTRO} returnTo={ADMIN_PRICES_PAGE_PATH} />;
  }
  const { prices, billing } = step.data;
  const book: PriceBook = prices;
  const now = new Date(step.data.now);

  /** The prices again; true when they came. A 401 ends the page's session. */
  async function refresh(): Promise<boolean> {
    try {
      await reload();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) sessionEnded();
      else setNotice({ title: failureMessage(err) });
      return false;
    }
  }

  /**
   * One change, then the prices again. A refusal is said above the open task (the form or the move field stays as
   * typed; a cancel step closes), and the prices are loaded again at once when the change is gone (404).
   */
  async function send(key: string, req: PriceChangeRequest) {
    setPending(key);
    setNotice(null);
    try {
      await changePrices(req);
      setOpen(null);
      await refresh();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 401) {
        setOpen(null);
        sessionEnded();
        return;
      }
      // The server's 400 is the rules' plain words; a 404 or a 409 is said in the page's words.
      const serverMessage = err instanceof ApiError ? err.serverMessage : undefined;
      setNotice({ title: failureMessage(err, { 400: serverMessage, 404: GONE, 409: CHANGED }), reload: status === 409 });
      setOpen((o) => (status === 404 || o?.kind === 'cancel' ? null : o));
      if (status === 404) await refresh();
    } finally {
      setPending(null);
    }
  }

  async function onReload() {
    if (await refresh()) setNotice(null);
  }

  function onOpen(next: Open) {
    setNotice(null);
    setOpen(next);
  }

  function onClose() {
    setOpen(null);
    setNotice(null);
  }

  const noticeBanner = notice ? (
    <Banner
      tone="danger"
      title={notice.title}
      action={notice.reload ? { label: 'Reload', onAction: () => void onReload() } : undefined}
    />
  ) : null;

  /** A section's props: its form open or not, and its save sent with the page's handler. */
  const settings = (part: SettingsPart): SettingsSectionProps => ({
    book,
    version: prices.version,
    now,
    open: open?.kind === part,
    idle: pending === null && open === null,
    busy: pending === part,
    notice: open?.kind === part ? noticeBanner : null,
    onOpen: () => onOpen({ kind: part }),
    onClose,
    onSend: (req) => send(part, req),
  });

  return (
    <Page info={info} heading={heading} intro={INTRO} wide>
      {billing ? null : <Banner title={NO_BILLING} />}
      <TaskPrices
        book={book}
        version={prices.version}
        now={now}
        open={open}
        pending={pending}
        notice={noticeBanner}
        onOpen={onOpen}
        onClose={onClose}
        onSend={send}
      />
      <StarterCreditSection {...settings('starter')} />
      <PurchaseSection {...settings('purchase')} />
      <AutoReloadSection {...settings('auto-reload')} />
      <PriceHistory changes={step.data.changes} />
    </Page>
  );
}

interface TaskPricesProps {
  book: PriceBook;
  version: string;
  /** The server's clock when it answered. */
  now: Date;
  open: Open | null;
  pending: string | null;
  /** The refusal to show: above the open task, or above the tasks when none is open. */
  notice: ReactNode;
  onOpen(open: Open): void;
  onClose(): void;
  onSend(key: string, req: PriceChangeRequest): Promise<void>;
}

/**
 * Each task's price, in `CREDIT_TASKS` order: the card in effect now and what people see, each scheduled change (an
 * entry that changes several tasks is listed under each) with what people will see from its date, "Move" and "Cancel",
 * then the form.
 */
function TaskPrices({ book, version, now, open, pending, notice, onOpen, onClose, onSend }: TaskPricesProps) {
  const headingId = useId();
  const idle = pending === null && open === null;
  return (
    <section className="web-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Task prices</h2>
      {open === null ? notice : null}
      {CREDIT_TASKS.map((task) => {
        const name = TASK_PRICE_NAMES[task];
        const current = taskPriceAt(now, task, book.schedule);
        const opened = open !== null && 'task' in open && open.task === task ? open : null;
        return (
          <Fragment key={task}>
            {opened ? notice : null}
            <ListGroup header={name}>
              <ListRow
                title={current.offered ? `Now: ${cardSummary(task, current.card)}` : 'Not offered yet.'}
                subtitle={<PriceLines lines={taskPriceLines(book.schedule, task, now)} />}
              />
              {scheduledTaskChanges(book.schedule, task, now).map(({ effectiveFrom, card }) => {
                const when = day(effectiveFrom);
                const step = opened?.kind !== 'form' && opened?.effectiveFrom === effectiveFrom ? opened.kind : null;
                const props = { task, book, now, version, effectiveFrom, busy: pending !== null, onSend, onBack: onClose };
                return (
                  <Fragment key={effectiveFrom}>
                    <ListRow
                      title={`From ${when} (UTC): ${card ? cardSummary(task, card) : 'not offered'}`}
                      subtitle={<PriceLines lines={taskPriceLines(book.schedule, task, new Date(effectiveFrom))} />}
                      control={
                        <div className="ua-hstack ua-wrap">
                          <Button
                            size="sm"
                            aria-label={`Move the change from ${when}`}
                            disabled={!idle}
                            onClick={() => onOpen({ kind: 'move', task, effectiveFrom })}
                          >
                            Move
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            aria-label={`Cancel the change from ${when}`}
                            disabled={!idle}
                            onClick={() => onOpen({ kind: 'cancel', task, effectiveFrom })}
                          >
                            Cancel
                          </Button>
                        </div>
                      }
                    />
                    {step === 'move' ? <MoveStep {...props} /> : null}
                    {step === 'cancel' ? <CancelStep {...props} /> : null}
                  </Fragment>
                );
              })}
              {opened?.kind === 'form' ? (
                <TaskPriceForm
                  task={task}
                  book={book}
                  now={now}
                  version={version}
                  busy={pending === 'save'}
                  onSubmit={(req) => onSend('save', req)}
                  onCancel={onClose}
                />
              ) : (
                <div className="web-form">
                  <Button disabled={!idle} onClick={() => onOpen({ kind: 'form', task })}>
                    {current.offered ? 'Change the price' : 'Set its first price'}
                  </Button>
                </div>
              )}
            </ListGroup>
          </Fragment>
        );
      })}
    </section>
  );
}

interface StepProps {
  task: CreditTask;
  book: PriceBook;
  now: Date;
  version: string;
  /** The scheduled change's date. */
  effectiveFrom: string;
  busy: boolean;
  onSend(key: string, req: PriceChangeRequest): Promise<void>;
  onBack(): void;
}

/** Why the rules refuse `schedule` as the book's new schedule at `now`, in plain words; '' when they allow it. */
function refusal(book: PriceBook, schedule: PriceBook['schedule'], now: Date): string {
  return priceIssuesText(priceBookChangeIssues(book, { ...book, schedule }, now));
}

/** "Cancel the change from Dec 3, 2026?": the change undone (PA-01's `cancelTaskChange`), and why not when the rules refuse. */
function CancelStep({ task, book, now, version, effectiveFrom, busy, onSend, onBack }: StepProps) {
  const head = cancelTaskChange(book.schedule, task, effectiveFrom);
  const blocked = head ? refusal(book, head, now) : GONE;
  return (
    <div className="web-form ua-stack">
      <p>{`Cancel the change from ${day(effectiveFrom)}?`}</p>
      {blocked ? <p className="ua-field-error">{blocked}</p> : null}
      <div className="ua-hstack ua-wrap">
        {/* Focused when the question appears: the destructive button never has the focus first. */}
        <Button size="sm" autoFocus disabled={busy} onClick={onBack}>
          Keep it
        </Button>
        <Button
          size="sm"
          variant="destructive-solid"
          loading={busy}
          disabled={busy || blocked !== ''}
          onClick={() => void onSend('cancel', { action: 'cancel', baseVersion: version, task, effectiveFrom })}
        >
          Cancel the change
        </Button>
      </div>
    </div>
  );
}

/** The change from another day (PA-01's `moveTaskChange`): a date field, set to its day, and "Save". */
function MoveStep({ task, book, now, version, effectiveFrom, busy, onSend, onBack }: StepProps) {
  const [to, setTo] = useState(() => utcDayInput(effectiveFrom));
  const target = fromUtcDayInput(to);
  const head = target === null || target === effectiveFrom ? null : moveTaskChange(book.schedule, task, effectiveFrom, target);
  const reason =
    target === null
      ? PICK_DAY
      : target === effectiveFrom
        ? ''
        : head === null
          ? `A change can't move onto or past another change of ${TASK_PRICE_NAMES[task]}.`
          : refusal(book, head, now);
  const ready = head !== null && reason === '';

  function onSave(e: FormEvent) {
    e.preventDefault();
    if (busy || !ready || target === null) return;
    void onSend('move', { action: 'move', baseVersion: version, task, effectiveFrom, to: target });
  }

  return (
    <form className="web-form ua-stack" noValidate onSubmit={onSave}>
      <TextField
        label="Move to"
        type="date"
        autoFocus
        min={utcDayInput(nextMidnight(now))}
        value={to}
        hint="From 00:00 UTC on this day."
        onChange={(e) => setTo(e.target.value)}
      />
      {reason ? <p className="ua-field-error">{reason}</p> : null}
      <div className="ua-hstack ua-wrap">
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={busy || !ready}>
          Save
        </Button>
        <Button size="sm" disabled={busy} onClick={onBack}>
          Back
        </Button>
      </div>
    </form>
  );
}

/** The kind of change, and the earliest day it can start (draft copy, PD14). */
function kindLine(kind: CardChangeKind, task: CreditTask, now: Date): string {
  switch (kind) {
    case 'raise':
      return `This is a raise: it can start on ${day(earliestStart('raise', now))} or later.`;
    case 'cut':
      return `This is a cut: it can start tomorrow. ${NO_CANCEL}`;
    case 'first':
      return `This is the first price of ${TASK_PRICE_NAMES[task]}: it can start tomorrow.`;
    case 'neutral':
      return 'This changes no price: it can start tomorrow.';
    case 'same':
      return 'This is the price already set for that day.';
  }
}

/**
 * One task's price from a day, filled with the card in effect at the default day, the next 00:00 UTC. The day is set
 * once when the form opens and never moved by the page; its earliest allowed day follows the kind of change. On every
 * change: the card from the fields, the schedule with it (`withTaskCard`), the rules (`priceBookChangeIssues`), the
 * kind (`cardChangeKind` against the stored card in effect at that day) and the preview at that day. A cut asks first.
 */
function TaskPriceForm({
  task,
  book,
  now,
  version,
  busy,
  onSubmit,
  onCancel,
}: {
  task: CreditTask;
  book: PriceBook;
  now: Date;
  version: string;
  busy: boolean;
  onSubmit(req: PriceChangeRequest): Promise<void>;
  onCancel(): void;
}) {
  const fieldId = useId();
  const name = TASK_PRICE_NAMES[task];
  const unit = TASK_UNITS[task];
  const job = isJob(task);
  const [initial] = useState(() => {
    const from = nextMidnight(now);
    const price = taskPriceAt(new Date(from), task, book.schedule);
    return { from, card: price.offered ? price.card : null };
  });
  const [multiplierText, setMultiplierText] = useState(initial.card ? String(initial.card.multiplier) : '');
  const [model, setModel] = useState(initial.card?.referenceModel ?? '');
  const [costText, setCostText] = useState(
    initial.card ? dollarsInput(initial.card.referenceCostMicrosPer1000, job ? 9 : 6) : '',
  );
  const [capText, setCapText] = useState(
    initial.card?.maxChargeMicros === undefined ? '' : dollarsInput(initial.card.maxChargeMicros),
  );
  const [dayText, setDayText] = useState(utcDayInput(initial.from));
  /** The cut's confirm step; any change to a field leaves it. */
  const [confirming, setConfirming] = useState(false);
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setConfirming(false);
  };

  const multiplier = parseMultiplier(multiplierText);
  const cost = parseDollars(costText);
  const cap = job ? parseDollars(capText) : null;
  const from = fromUtcDayInput(dayText);
  const card = ((): CreditPriceCard | null => {
    if (multiplier === null || cost === null) return null;
    if (!job) return { multiplier, referenceModel: model, referenceCostMicrosPer1000: cost };
    if (cap === null) return null;
    return { multiplier, referenceModel: model, referenceCostMicrosPer1000: cost * 1000, unit, maxChargeMicros: cap };
  })();
  const head = card && from ? withTaskCard(book.schedule, task, from, card) : null;
  const issues = head ? priceBookChangeIssues(book, { ...book, schedule: head }, now) : [];
  const before = from ? taskPriceAt(new Date(from), task, book.schedule) : null;
  const kind = card && before ? cardChangeKind(before.offered ? before.card : null, card) : null;
  // What people will see from that day, once the schedule is sound enough to price (a too-early raise still is).
  const lines = head && from && priceScheduleIssues(head).length === 0 ? taskPriceLines(head, task, new Date(from)) : [];
  const issueText = priceIssuesText(issues);
  const ready = card !== null && from !== null && issues.length === 0 && kind !== 'same';
  // A model no longer offered stays shown as it is; the rules ask for another.
  const models: readonly string[] =
    model === '' || REFERENCE_MODELS.some((m) => m === model) ? REFERENCE_MODELS : [model, ...REFERENCE_MODELS];

  async function submit() {
    if (busy || !ready || !card || !from) return;
    await onSubmit({ action: 'schedule', baseVersion: version, task, effectiveFrom: from, card });
    setConfirming(false);
  }

  function onSave(e: FormEvent) {
    e.preventDefault();
    if (busy || !ready) return;
    if (kind === 'cut') setConfirming(true);
    else void submit();
  }

  return (
    <form
      className="web-form ua-stack"
      noValidate
      aria-label={initial.card ? `Change the price of ${name}` : `Set the first price of ${name}`}
      onSubmit={onSave}
    >
      <TextField
        label="Multiplier"
        autoFocus
        inputMode="decimal"
        autoComplete="off"
        value={multiplierText}
        trailing={<span className="ua-secondary">×</span>}
        hint="Times our AI cost."
        error={multiplier === null ? ENTER_MULTIPLIER : undefined}
        onChange={(e) => edit(setMultiplierText)(e.target.value)}
      />
      <div className="ua-field">
        <label htmlFor={`${fieldId}-model`} className="ua-field-label">
          Reference model
        </label>
        <select id={`${fieldId}-model`} className="ua-select" value={model} onChange={(e) => edit(setModel)(e.target.value)}>
          {model === '' ? <option value="">Pick a model</option> : null}
          {models.map((m) => (
            <option key={m} value={m}>
              {REFERENCE_MODEL_LABELS[m] ?? m}
            </option>
          ))}
        </select>
      </div>
      <TextField
        label="Our AI cost"
        inputMode="decimal"
        autoComplete="off"
        value={costText}
        hint={job ? `per ${unit}` : 'per 1,000 posts'}
        error={cost === null ? ENTER_AMOUNT : undefined}
        onChange={(e) => edit(setCostText)(e.target.value)}
      />
      {job ? (
        <TextField
          label="At most"
          inputMode="decimal"
          autoComplete="off"
          value={capText}
          hint={`for one ${unit}`}
          error={cap === null ? ENTER_AMOUNT : undefined}
          onChange={(e) => edit(setCapText)(e.target.value)}
        />
      ) : null}
      <TextField
        label="Starts on"
        type="date"
        min={utcDayInput(earliestStart(kind ?? 'neutral', now))}
        value={dayText}
        hint="From 00:00 UTC on this day."
        error={from === null ? PICK_DAY : undefined}
        onChange={(e) => edit(setDayText)(e.target.value)}
      />
      {kind ? <p>{kindLine(kind, task, now)}</p> : null}
      {lines.length > 0 && from ? (
        <div>
          <p>{`People will see, from ${day(from)}:`}</p>
          <p className="ua-footnote">
            <PriceLines lines={lines} />
          </p>
        </div>
      ) : null}
      {issueText ? <p className="ua-field-error">{issueText}</p> : null}
      {confirming ? (
        <div className="ua-stack">
          <p>{CUT_QUESTION}</p>
          <div className="ua-hstack ua-wrap">
            <Button autoFocus disabled={busy} onClick={() => setConfirming(false)}>
              Back
            </Button>
            <Button variant="primary" loading={busy} disabled={busy || !ready} onClick={() => void submit()}>
              Save the cut
            </Button>
          </div>
        </div>
      ) : (
        <div className="ua-hstack ua-wrap">
          <Button type="submit" variant="primary" loading={busy} disabled={busy || !ready}>
            Save
          </Button>
          <Button disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </form>
  );
}
