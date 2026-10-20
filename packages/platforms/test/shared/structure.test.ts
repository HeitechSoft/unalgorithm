import { describe, expect, it } from 'vitest';
import {
  anatomyScore,
  chooseStrategy,
  type ItemAnatomy,
  jaccard,
  MAX_LIST_ANCHORS,
  NO_STRATEGY,
  repeatedList,
  type StrategyChoice,
  scoreModel,
} from '../../src/index.ts';

/** A feed: `<main><div><ul>` with `n` posts, each with a menu and a Repost button, and a comment thread in the first. */
function feed(n: number): { main: HTMLElement; list: HTMLElement; anchors: Element[] } {
  document.body.innerHTML = '';
  const main = document.createElement('main');
  const wrapper = main.appendChild(document.createElement('div'));
  const list = wrapper.appendChild(document.createElement('ul'));
  for (let i = 0; i < n; i++) {
    const item = list.appendChild(document.createElement('li'));
    item.innerHTML = `<div class="card"><div class="actor"><button class="menu">…</button></div><p>Post ${i}</p><div class="bar"><button class="repost">Repost</button></div></div>`;
  }
  // Comments have their own repeated structure, but no post menu or Repost button.
  list.firstElementChild?.insertAdjacentHTML('beforeend', '<ol class="comments"><li>a</li><li>b</li><li>c</li><li>d</li></ol>');
  document.body.appendChild(main);
  return { main, list, anchors: Array.from(main.querySelectorAll('.menu, .repost')) };
}

describe('repeatedList', () => {
  it('test_finds_the_feed_list', () => {
    const { main, list, anchors } = feed(6);
    const found = repeatedList(main, anchors);
    expect(found?.list).toBe(list);
    expect(found?.items).toEqual(Array.from(list.children));
    // Two posts' anchors (a menu and a Repost button each) aren't a list yet.
    expect(repeatedList(main, anchors.slice(0, 4))).toBeNull();
  });

  it('test_needs_enough_items', () => {
    const { main, anchors } = feed(2);
    expect(repeatedList(main, anchors)).toBeNull();
    expect(repeatedList(main, anchors, 2)?.items).toHaveLength(2);
    expect(repeatedList(main, [])).toBeNull();
  });

  it('test_ignores_anchors_outside_and_caps_the_walk', () => {
    const { main, list, anchors } = feed(5);
    const outside = document.body.appendChild(document.createElement('aside'));
    for (let i = 0; i < 10; i++) outside.appendChild(document.createElement('button'));
    expect(repeatedList(main, [...Array.from(outside.children), ...anchors])?.list).toBe(list);
    expect(repeatedList(main, [main, ...anchors])?.list).toBe(list);
    const long = feed(120);
    const menus = Array.from(long.main.querySelectorAll('.menu'));
    expect(repeatedList(long.main, menus)?.items).toHaveLength(MAX_LIST_ANCHORS);
  });

  it('test_a_tie_goes_to_the_outer_list', () => {
    // Three outer items, each holding an inner list of three anchors: both levels hold three.
    document.body.innerHTML = `<main id="m"><section id="outer">${'<div><div class="inner"><a></a><a></a><a></a></div></div>'.repeat(3)}</section></main>`;
    const main = document.getElementById('m') as HTMLElement;
    const found = repeatedList(main, Array.from(main.querySelectorAll('a')));
    expect(found?.list.id).toBe('outer');
  });
});

describe('scores', () => {
  const post: ItemAnatomy = { author: true, actionBar: true, ageSlot: true, menu: true, text: true };
  const blank: ItemAnatomy = { author: false, actionBar: false, ageSlot: false, menu: false, text: false };

  it('test_jaccard', () => {
    expect(jaccard([1, 2, 3], [3, 2, 1])).toBe(1);
    expect(jaccard([1, 2], [3, 4])).toBe(0);
    expect(jaccard([1, 2], [2, 3])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(1);
    expect(jaccard([1], [])).toBe(0);
  });

  it('test_anatomy_score', () => {
    expect(anatomyScore(post)).toBe(1);
    expect(anatomyScore(blank)).toBe(0);
    expect(anatomyScore({ ...blank, author: true, actionBar: true })).toBe(0.5);
    // A comment: an author and text, but no action bar, age slot or menu of a post.
    expect(anatomyScore({ ...blank, author: true, text: true })).toBe(0.4);
  });

  it('test_score_model', () => {
    expect(scoreModel([post, post])).toBe(0);
    expect(scoreModel([post, post], 2)).toBe(1);
    expect(scoreModel([post, post, blank, blank])).toBe(0.5);
    // Only the first ten items are sampled.
    expect(scoreModel([...Array(10).fill(post), ...Array(10).fill(blank)])).toBe(1);
  });
});

describe('chooseStrategy', () => {
  const scores = (...pairs: Array<[string, number]>) => pairs.map(([id, score]) => ({ id, score }));
  const run = (state: StrategyChoice, ...ticks: Array<Array<{ id: string; score: number }>>) =>
    ticks.reduce((s, tick) => chooseStrategy(s, tick), state);

  it('test_first_discovery_takes_the_best_cheapest_first', () => {
    expect(chooseStrategy(NO_STRATEGY, scores(['card-key', 0.9], ['anatomy', 0.8])).current).toBe('card-key');
    expect(chooseStrategy(NO_STRATEGY, scores(['card-key', 0.2], ['anatomy', 0.8])).current).toBe('anatomy');
    // A tie goes to the cheaper strategy (listed first).
    expect(chooseStrategy(NO_STRATEGY, scores(['card-key', 0.8], ['anatomy', 0.8])).current).toBe('card-key');
    // Nothing found yet: keep waiting.
    expect(chooseStrategy(NO_STRATEGY, scores(['card-key', 0], ['anatomy', 0]))).toEqual(NO_STRATEGY);
    expect(chooseStrategy(NO_STRATEGY, [])).toEqual(NO_STRATEGY);
  });

  it('test_switches_only_after_two_clear_wins', () => {
    const start = chooseStrategy(NO_STRATEGY, scores(['card-key', 0.9], ['anatomy', 0.7]));
    const once = chooseStrategy(start, scores(['card-key', 0.2], ['anatomy', 0.9]));
    expect(once).toEqual({ current: 'card-key', challenger: 'anatomy', streak: 1 });
    expect(chooseStrategy(once, scores(['card-key', 0.2], ['anatomy', 0.9]))).toEqual({
      current: 'anatomy',
      challenger: null,
      streak: 0,
    });
    // One good tick between two bad ones resets the run.
    const reset = run(
      start,
      scores(['card-key', 0.2], ['anatomy', 0.9]),
      scores(['card-key', 0.9], ['anatomy', 0.9]),
      scores(['card-key', 0.2], ['anatomy', 0.9]),
    );
    expect(reset).toEqual({ current: 'card-key', challenger: 'anatomy', streak: 1 });
    // A different challenger starts its own run.
    const other = run(
      start,
      scores(['card-key', 0.2], ['anatomy', 0.9], ['sr', 0.5]),
      scores(['card-key', 0.2], ['anatomy', 0.5], ['sr', 0.9]),
    );
    expect(other).toEqual({ current: 'card-key', challenger: 'sr', streak: 1 });
  });

  it('test_margin', () => {
    const start: StrategyChoice = { current: 'card-key', challenger: null, streak: 0 };
    const twice = (current: number, rival: number) =>
      run(start, scores(['card-key', current], ['anatomy', rival]), scores(['card-key', current], ['anatomy', rival])).current;
    expect(twice(0.6, 0.74)).toBe('card-key');
    expect(twice(0.6, 0.75)).toBe('anatomy');
    // A strategy that vanished from the scores counts as 0.
    expect(run(start, scores(['anatomy', 0.2]), scores(['anatomy', 0.2])).current).toBe('anatomy');
    expect(run(start, scores(['anatomy', 0.1]), scores(['anatomy', 0.1])).current).toBe('card-key');
  });
});
