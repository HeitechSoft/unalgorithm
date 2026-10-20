/**
 * Topics in one list, each marked More, Less or neither: Settings → Interests and onboarding's interests step. The list
 * is every starter topic (`STARTER_TOPICS`, then `STARTER_LESS_OF`) and the person's own topics from either list. A mark
 * writes the topic to `interests.more` or `interests.less` under its id and takes it out of the other, so a topic is
 * never in both, and the stored ids, labels and sync keys (`interests.more.<id>`) are the ones the two lists always had.
 * A topic left alone is in neither. The person's own topics live only in those lists, so clearing one removes it.
 * An own topic named like one already listed (Politics typed under the old "More of", where it couldn't be picked) shows
 * as that row, so no name is listed twice; it stays stored under its own id until the row is marked again.
 */
import { type Settings, STARTER_LESS_OF, STARTER_TOPICS, type Topic } from '@unalgorithm/core';
import { uuidv7 } from '@unalgorithm/protocol';
import { Button, ListGroup, ListRow, TextField, ThumbsDown, ThumbsUp } from '@unalgorithm/ui';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';

type Interests = Settings['interests'];
type Save = (mutate: (s: Settings) => Settings | void) => Promise<void>;
export type TopicMark = 'more' | 'less';

/** What the list says, pinned by tests/topic-list.test.tsx. */
export const TOPIC_COPY = {
  intro: 'Mark any topic as more or less. Topics you leave alone change nothing.',
  footer: 'More: posts get a quiet For you highlight. Less: posts are folded away, even without AI.',
  add: 'Add your own topic, like Supply chain',
  own: 'Your topic',
  showAll: 'Show all topics',
  showFewer: 'Show fewer topics',
  none: 'none',
} as const;

const MARKS: Record<TopicMark, { label: string; icon: typeof ThumbsUp }> = {
  more: { label: 'More', icon: ThumbsUp },
  less: { label: 'Less', icon: ThumbsDown },
};

/** The longest topic name the settings take (`TopicSchema`). */
const MAX_LABEL = 40;

export interface ListedTopic {
  /** The row's id: the starter topic's, or the person's own topic's. */
  id: string;
  label: string;
  keywords: string[];
  /** One the person added, not a starter topic. */
  own: boolean;
  /** Every id stored for this row: `id`, then own topics with the same name, oldest first. */
  ids: string[];
}

const STARTERS = [...STARTER_TOPICS, ...STARTER_LESS_OF].filter((t, i, all) => all.findIndex((o) => o.id === t.id) === i);
const STARTER_IDS = new Set(STARTERS.map((t) => t.id));

/** Topic names compared the way the add field compares them: spaces tidied, case ignored. */
const sameName = (label: string) => label.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/**
 * The topics listed: the starter topics, then the person's own from either list, oldest first. An own topic with the
 * name of one listed before it shows as that row (its id goes in the row's `ids`), so no name is listed twice.
 */
export function topicCatalog(interests: Interests): ListedTopic[] {
  const list: ListedTopic[] = STARTERS.map((t) => ({ id: t.id, label: t.label, keywords: t.keywords, own: false, ids: [t.id] }));
  const byName = new Map(list.map((t) => [sameName(t.label), t]));
  const own = new Map<string, Topic>();
  for (const [id, t] of [...Object.entries(interests.more), ...Object.entries(interests.less)]) {
    if (!STARTER_IDS.has(id) && !own.has(id)) own.set(id, t);
  }
  for (const [id, t] of [...own].sort(([, a], [, b]) => a.addedAt - b.addedAt)) {
    const listed = byName.get(sameName(t.label));
    if (listed) {
      listed.ids.push(id);
      continue;
    }
    const row: ListedTopic = { id, label: t.label, keywords: t.keywords, own: true, ids: [id] };
    list.push(row);
    byName.set(sameName(t.label), row);
  }
  return list;
}

/** How a topic is marked. One in both lists (two devices marking it at once) shows as More until it's marked again. */
export function markOf(interests: Interests, topic: Pick<ListedTopic, 'ids'>): TopicMark | null {
  return topic.ids.some((id) => interests.more[id]) ? 'more' : topic.ids.some((id) => interests.less[id]) ? 'less' : null;
}

/** How many topics are marked More or Less: rows of the list, so a topic in both lists or stored twice counts once. */
export function markedCount(interests: Interests): number {
  return topicCatalog(interests).filter((t) => markOf(interests, t)).length;
}

/** The names marked More and those marked Less, in list order. */
function markedLabels(interests: Interests): Record<TopicMark, string[]> {
  const catalog = topicCatalog(interests);
  const of = (mark: TopicMark) => catalog.filter((t) => markOf(interests, t) === mark).map((t) => t.label);
  return { more: of('more'), less: of('less') };
}

/** The line above the list: "More: AI & tech, Politics · Less: none". */
export function topicSummary(interests: Interests): string {
  const { more, less } = markedLabels(interests);
  return `More: ${more.join(', ') || TOPIC_COPY.none} · Less: ${less.join(', ') || TOPIC_COPY.none}`;
}

/**
 * Marks `topic` in `s`, or clears it with null, and takes it out of the other list. A starter topic is stored with its
 * own words; the person's own topic keeps its words and the date it was added, so it stays where it is in the list.
 * Every id the row stands for is cleared, so an own topic shown as a starter row goes and the mark is the starter's.
 */
export function markTopic(s: Settings, topic: ListedTopic, mark: TopicMark | null, now = Date.now()): void {
  const stored = s.interests.more[topic.id] ?? s.interests.less[topic.id];
  for (const id of topic.ids) {
    delete s.interests.more[id];
    delete s.interests.less[id];
  }
  if (!mark) return;
  s.interests[mark][topic.id] =
    topic.own && stored ? stored : { label: topic.label, keywords: [...topic.keywords], addedAt: now };
}

export function TopicList({
  interests,
  save,
  header,
  intro,
  limit,
}: {
  interests: Interests;
  save: Save;
  header?: ReactNode;
  /** Starts with what the marks do (Settings; onboarding says it under its heading). */
  intro?: boolean;
  /** Shows only this many topics, and the marked ones, until Show all topics. */
  limit?: number;
}) {
  const uid = useId();
  const fieldId = `${uid}-add`;
  const rowId = (id: string) => `${uid}-${id}`;
  const [all, setAll] = useState(false);
  const [draft, setDraft] = useState('');
  const [said, setSaid] = useState('');
  /** The row whose first button takes focus next: the first one Show all topics revealed. */
  const [focusRow, setFocusRow] = useState<string | null>(null);
  /** Rows the shorter list showed for their mark and keeps once it's cleared, so a row never goes from under you. */
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());

  const catalog = topicCatalog(interests);
  const { more, less } = markedLabels(interests);
  const collapsed = limit === undefined ? catalog : catalog.filter((t, i) => i < limit || markOf(interests, t) || kept.has(t.id));
  const shown = all ? catalog : collapsed;

  useEffect(() => {
    if (!focusRow) return;
    document.getElementById(rowId(focusRow))?.querySelector('button')?.focus();
    setFocusRow(null);
  });

  const press = (topic: ListedTopic, mark: TopicMark) => {
    const next = markOf(interests, topic) === mark ? null : mark;
    if (!next && !topic.own && !all) setKept((k) => new Set(k).add(topic.id));
    void save((s) => markTopic(s, topic, next)).then(() => {
      // An own topic exists only while it's marked: its row is gone, so focus goes to where topics are added.
      if (topic.own && !next) document.getElementById(fieldId)?.focus();
    });
  };

  const showAll = () => {
    // The revealed rows come before this button, so focus moves to the first of them.
    if (!all) setFocusRow(catalog.find((t) => !collapsed.includes(t))?.id ?? null);
    setAll(!all);
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const label = draft.trim().replace(/\s+/g, ' ');
    if (!label) return;
    setDraft('');
    // A name already listed marks that topic, so the list never shows the same topic twice.
    const listed = catalog.find((t) => sameName(t.label) === sameName(label));
    if (listed) {
      if (markOf(interests, listed) !== 'more') void save((s) => markTopic(s, listed, 'more'));
      setSaid(`${listed.label} is marked More.`);
      return;
    }
    void save((s) => void (s.interests.more[uuidv7()] = { label, keywords: [label], addedAt: Date.now() }));
    setSaid(`Added ${label} as More.`);
  };

  return (
    <ListGroup
      header={header}
      description={
        <>
          {intro ? <p>{TOPIC_COPY.intro}</p> : null}
          <p className="topics-summary">
            <span className="topics-key">More:</span> {more.join(', ') || TOPIC_COPY.none} ·{' '}
            <span className="topics-key">Less:</span> {less.join(', ') || TOPIC_COPY.none}
          </p>
        </>
      }
      footer={TOPIC_COPY.footer}
    >
      {shown.map((t) => (
        <ListRow
          key={t.id}
          id={rowId(t.id)}
          groupLabel={t.label}
          title={t.label}
          subtitle={t.own ? TOPIC_COPY.own : undefined}
          control={<MarkButtons label={t.label} mark={markOf(interests, t)} onPress={(m) => press(t, m)} />}
        />
      ))}
      {collapsed.length < catalog.length ? (
        <div className="ua-row">
          <Button variant="plain" size="sm" className="topics-show" aria-expanded={all} onClick={showAll}>
            {all ? TOPIC_COPY.showFewer : TOPIC_COPY.showAll}
          </Button>
        </div>
      ) : null}
      <form className="ua-row" onSubmit={add}>
        <TextField
          id={fieldId}
          className="ua-grow"
          label={TOPIC_COPY.add}
          labelHidden
          placeholder={TOPIC_COPY.add}
          autoComplete="off"
          maxLength={MAX_LABEL}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={!draft.trim()}>
          Add
        </Button>
      </form>
      <p className="ua-vh" role="status">
        {said}
      </p>
    </ListGroup>
  );
}

/** A topic's two toggle buttons. Pressing the pressed one clears the mark. */
function MarkButtons({ label, mark, onPress }: { label: string; mark: TopicMark | null; onPress(mark: TopicMark): void }) {
  return (
    <span className="topic-marks">
      {(['more', 'less'] as const).map((m) => (
        <Button
          key={m}
          size="sm"
          className={`topic-mark topic-mark--${m}`}
          icon={MARKS[m].icon}
          aria-pressed={mark === m}
          aria-label={`${MARKS[m].label}: ${label}`}
          onClick={() => onPress(m)}
        >
          {MARKS[m].label}
        </Button>
      ))}
    </span>
  );
}
