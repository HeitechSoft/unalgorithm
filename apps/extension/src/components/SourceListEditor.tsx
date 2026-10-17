/**
 * Your own source list for UnEcho Chamber (P3-76, decisions D100, D110): Settings → AI → Edit your list, at
 * `#/ai/sources`. It starts from a copy of UnAlgorithm Cloud's stored list (or of the candidates while the Cloud has no
 * lean); the person adds, edits and removes outlets and sets the leans, which are theirs and which no one reviews. The
 * balance warnings follow every change. Every write is one `save` of `perspectives.outlets`, which syncs entry by entry
 * with the rest of the settings. Copy is a draft (D110).
 */
import { OwnOutletSchema, type Settings } from '@unalgorithm/core';
import {
  bundledCandidates,
  domainFromInput,
  type ListProblem,
  listBalance,
  listProblems,
  listProblemText,
  ownCopyOf,
  ownSourceList,
} from '@unalgorithm/outlets';
import {
  BUCKET_LABELS,
  FEATURE_NAMES,
  LEAN_BUCKETS,
  type LeanBucket,
  MAX_LIST_OUTLETS,
  MAX_OUTLET_DOMAINS,
  uuidv7,
} from '@unalgorithm/protocol';
import { BalanceNotice, Button, ChevronLeft, EmptyState, ListGroup, ListRow, TextField } from '@unalgorithm/ui';
import { type FormEvent, useId, useState } from 'react';
import { useStorageItem } from '../lib/hooks.ts';
import { storedOfficialList } from '../lib/outlets.ts';
import { officialListItem, type StoredOfficialList } from '../lib/storage.ts';

type Save = (mutate: (s: Settings) => Settings | void) => Promise<void>;
type Outlets = Settings['perspectives']['outlets'];
/** A sound outlet, as the form gives it back. */
interface OutletDraft {
  name: string;
  domains: string[];
  bucket: LeanBucket | null;
}

const NOTHING_STORED: StoredOfficialList = { list: null, checkedAt: 0 };
const LIMIT = `Your list has ${MAX_LIST_OUTLETS} outlets, the most it can hold.`;

const problemKey = (p: ListProblem) => `${p.code} ${p.outletId}`;

/**
 * The first problem the outlet `id` (new, or an edit of one on the list) would bring to `outlets`, in words that name
 * outlets by their names; null when none. A problem the list has already is not this form's: an outlet synced from
 * another device can keep its own, and fixing it is that outlet's edit.
 */
function newProblem(outlets: Outlets, id: string, draft: { name: string; domains: string[] }): string | null {
  const others = Object.entries(outlets)
    .filter(([key]) => key !== id)
    .map(([key, o]) => ({ id: key, domains: o.domains }));
  const current = outlets[id];
  const before = new Set(listProblems(current ? [...others, { id, domains: current.domains }] : others).map(problemKey));
  const added = listProblems([...others, { id, domains: draft.domains }]).find((p) => !before.has(problemKey(p)));
  if (!added) return null;
  const name = added.outletId === id ? draft.name.trim() || 'This outlet' : (outlets[added.outletId ?? '']?.name ?? '');
  return listProblemText({ ...added, outletId: name });
}

function LeanOptions() {
  return (
    <>
      <option value="">No lean</option>
      {LEAN_BUCKETS.map((b) => (
        <option key={b} value={b}>
          {BUCKET_LABELS[b]}
        </option>
      ))}
    </>
  );
}

/** One form for adding an outlet and for editing one in its row. */
function OutletForm({
  label,
  id,
  outlets,
  initial,
  submitLabel,
  atLimit = false,
  onSubmit,
  onCancel,
}: {
  label: string;
  /** The outlet's id: fresh for one being added. */
  id: string;
  outlets: Outlets;
  initial?: OutletDraft;
  submitLabel: string;
  atLimit?: boolean;
  onSubmit(draft: OutletDraft): Promise<void>;
  onCancel?(): void;
}) {
  const fieldId = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [addresses, setAddresses] = useState(initial?.domains.join(', ') ?? '');
  const [bucket, setBucket] = useState<LeanBucket | ''>(initial?.bucket ?? '');
  const [addressesLeft, setAddressesLeft] = useState(false);
  const [busy, setBusy] = useState(false);

  const entries = addresses
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const notAddresses = entries.filter((e) => domainFromInput(e) === null);
  const domains = [...new Set(entries.map(domainFromInput).filter((d) => d !== null))];
  const parsed = OwnOutletSchema.omit({ addedAt: true }).safeParse({ name, domains, bucket: bucket || null });
  const addressError =
    addressesLeft && notAddresses.length > 0
      ? `Not a web address: ${notAddresses.join(', ')}`
      : domains.length > MAX_OUTLET_DOMAINS
        ? `An outlet has at most ${MAX_OUTLET_DOMAINS} web addresses.`
        : undefined;
  const problem = notAddresses.length === 0 && domains.length > 0 ? newProblem(outlets, id, { name, domains }) : null;
  const reason = atLimit ? LIMIT : problem;
  const ready = parsed.success && notAddresses.length === 0 && reason === null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !ready || !parsed.success) return;
    setBusy(true);
    try {
      // Once saved, the parent closes an edit and gives the add form a new key, which empties it.
      await onSubmit(parsed.data);
    } catch {
      // The settings store refused it: the form keeps what was typed.
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label={label} className="ua-stack" style={{ padding: 12 }} noValidate onSubmit={(e) => void submit(e)}>
      <TextField label="Name" autoComplete="off" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      <TextField
        label="Web addresses"
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
        hint="Separate two or more with commas."
        error={addressError}
        value={addresses}
        onChange={(e) => setAddresses(e.target.value)}
        onBlur={() => setAddressesLeft(true)}
      />
      <div className="ua-field">
        <label htmlFor={`${fieldId}-lean`} className="ua-field-label">
          Lean
        </label>
        <select
          id={`${fieldId}-lean`}
          className="ua-select"
          value={bucket}
          onChange={(e) => setBucket(e.target.value as LeanBucket | '')}
        >
          <LeanOptions />
        </select>
      </div>
      {reason ? (
        <p id={`${fieldId}-reason`} className="ua-field-error">
          {reason}
        </p>
      ) : null}
      <div className="ua-hstack ua-wrap">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!ready}
          aria-describedby={reason ? `${fieldId}-reason` : undefined}
        >
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function SourceListEditor({ settings, save }: { settings: Settings; save: Save }) {
  const outlets = settings.perspectives.outlets;
  const official = storedOfficialList(useStorageItem(officialListItem, NOTHING_STORED));
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  // A fresh id for the next outlet added; a new one once it is.
  const [newId, setNewId] = useState(uuidv7);

  const ids = Object.keys(outlets);
  const balance = listBalance(ownSourceList(outlets));
  const fromCloud = official?.outlets.some((o) => o.lean !== null) ?? false;
  const candidates = bundledCandidates();
  const q = filter.trim().toLowerCase();
  const rows = Object.entries(outlets)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .filter(([, o]) => !q || o.name.toLowerCase().includes(q) || o.domains.some((d) => d.includes(q)));

  const start = () =>
    save((s) => {
      // Only ever onto an empty list: another device may have filled it since.
      if (Object.keys(s.perspectives.outlets).length > 0) return;
      s.perspectives.outlets = ownCopyOf(official, candidates ?? { outlets: [] }, Date.now());
    });
  const add = (draft: OutletDraft) =>
    save((s) => {
      if (Object.keys(s.perspectives.outlets).length >= MAX_LIST_OUTLETS) return;
      s.perspectives.outlets[newId] = { ...draft, addedAt: Date.now() };
    }).then(() => setNewId(uuidv7()));
  const edit = (id: string, draft: OutletDraft) =>
    save((s) => {
      const entry = s.perspectives.outlets[id];
      if (entry) Object.assign(entry, draft);
    }).then(() => setEditing(null));
  const setLean = (id: string, bucket: LeanBucket | null) =>
    void save((s) => {
      const entry = s.perspectives.outlets[id];
      if (entry) entry.bucket = bucket;
    });
  const remove = (id: string) => void save((s) => void delete s.perspectives.outlets[id]);

  return (
    <>
      <div>
        <Button
          variant="plain"
          size="sm"
          icon={ChevronLeft}
          onClick={() => {
            location.hash = '#/ai';
          }}
        >
          Back to AI
        </Button>
      </div>
      <h1 className="pane-title" tabIndex={-1}>
        Your source list
      </h1>
      <p className="pane-intro">
        {FEATURE_NAMES.perspectives} searches the outlets you give a lean and shows each under that lean. This list is yours: no
        one reviews it. With sync on, it is kept with your settings.
      </p>
      {ids.length > 0 && (balance.empty || balance.warnings.length > 0) ? (
        <div style={{ marginBottom: 24 }}>
          <BalanceNotice name="Your list" empty={balance.empty} warnings={balance.warnings} />
        </div>
      ) : null}
      {ids.length === 0 ? (
        <ListGroup>
          <EmptyState
            title="Your list is empty."
            action={
              fromCloud || candidates
                ? {
                    label: fromCloud ? "Start from UnAlgorithm Cloud's list" : 'Start from the candidate list',
                    onAction: () => void start(),
                  }
                : undefined
            }
          />
        </ListGroup>
      ) : null}
      <ListGroup header="Add an outlet">
        <OutletForm
          key={newId}
          label="Add an outlet"
          id={newId}
          outlets={outlets}
          submitLabel="Add"
          atLimit={ids.length >= MAX_LIST_OUTLETS}
          onSubmit={add}
        />
      </ListGroup>
      {ids.length > 0 ? (
        <ListGroup header={`Outlets (${ids.length})`}>
          <div style={{ padding: 12 }}>
            <TextField
              label="Find an outlet"
              type="search"
              autoComplete="off"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          {rows.length === 0 ? <ListRow title="No outlet matches." /> : null}
          {rows.map(([id, o]) =>
            editing === id ? (
              <OutletForm
                key={id}
                label={`Edit ${o.name}`}
                id={id}
                outlets={outlets}
                initial={o}
                submitLabel="Save"
                onSubmit={(draft) => edit(id, draft)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <ListRow
                key={id}
                title={o.name}
                subtitle={o.domains.join(', ')}
                control={
                  <span className="ua-hstack">
                    <select
                      className="ua-select"
                      aria-label={`Lean of ${o.name}`}
                      value={o.bucket ?? ''}
                      onChange={(e) => setLean(id, (e.target.value || null) as LeanBucket | null)}
                    >
                      <LeanOptions />
                    </select>
                    <Button variant="plain" size="sm" aria-label={`Edit ${o.name}`} onClick={() => setEditing(id)}>
                      Edit
                    </Button>
                    <Button variant="destructive" size="sm" aria-label={`Remove ${o.name}`} onClick={() => remove(id)}>
                      Remove
                    </Button>
                  </span>
                }
              />
            ),
          )}
        </ListGroup>
      ) : null}
    </>
  );
}
