/**
 * The balance notice (P3-72): one wording for every list, from `listBalance`'s plain-words warnings. The list problems
 * notice: a list UnEcho Chamber can't use until it is fixed, with each problem in plain words and a way to it.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FEATURE_NAMES, LEAN_BUCKETS, BUCKET_LABELS as PROTOCOL_BUCKET_LABELS } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BalanceNotice, BUCKET_LABELS, ListProblemsNotice } from '../src/index.ts';

afterEach(cleanup);

describe('balance notice', () => {
  it('test_balance_notice_states', () => {
    const balanced = render(<BalanceNotice name="unAlgorithm Cloud's list" empty={false} warnings={[]} />);
    expect(balanced.container.innerHTML).toBe('');
    balanced.unmount();

    const warnings = ['No outlets in Right.', 'Left and Leans left have 4 outlets, Leans right and Right have 1.'];
    render(<BalanceNotice name="Your list" empty={false} warnings={warnings} />);
    const notice = screen.getByRole('status');
    expect(within(notice).getByText("Your list isn't balanced")).toBeTruthy();
    expect(
      within(notice)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(warnings);
    expect(notice.className).toContain('ua-banner--warning');
    cleanup();

    render(<BalanceNotice name="Your list" empty={true} warnings={[]} />);
    const empty = screen.getByRole('status');
    expect(empty.className).toContain('ua-banner--warning');
    expect(
      within(empty).getByText(`Your list has no outlets with a lean, so ${FEATURE_NAMES.perspectives} can't use it.`),
    ).toBeTruthy();
    expect(within(empty).queryByRole('list')).toBeNull();
  });

  it('test_list_problems_notice', () => {
    const none = render(<ListProblemsNotice name="Your list" problems={[]} />);
    expect(none.container.innerHTML).toBe('');
    none.unmount();

    const onFix = vi.fn();
    const onAction = vi.fn();
    render(
      <ListProblemsNotice
        name="Your list"
        problems={[
          {
            id: 'domain-taken b',
            text: 'FX Daily: another outlet already lists one of its web addresses.',
            fix: { label: 'Edit FX Daily', onFix },
          },
          { id: 'too-many-outlets', text: 'The list has more than 300 outlets.' },
        ]}
        action={{ label: 'Fix your list', onAction }}
      />,
    );
    const notice = screen.getByRole('status');
    expect(notice.className).toContain('ua-banner--warning');
    expect(within(notice).getByText(`Your list needs fixing, so ${FEATURE_NAMES.perspectives} can't use it.`)).toBeTruthy();
    const items = within(notice).getAllByRole('listitem');
    expect(items.map((li) => li.firstChild?.textContent)).toEqual([
      'FX Daily: another outlet already lists one of its web addresses.',
      'The list has more than 300 outlets.',
    ]);
    // Only a problem about one outlet has a way to it.
    expect(within(items[1] as HTMLElement).queryByRole('button')).toBeNull();
    fireEvent.click(within(items[0] as HTMLElement).getByRole('button', { name: 'Edit FX Daily' }));
    expect(onFix).toHaveBeenCalledTimes(1);
    fireEvent.click(within(notice).getByRole('button', { name: 'Fix your list' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('test_bucket_labels_in_protocol', () => {
    expect(LEAN_BUCKETS.map((b) => PROTOCOL_BUCKET_LABELS[b])).toEqual(['Left', 'Leans left', 'Center', 'Leans right', 'Right']);
    expect(Object.keys(PROTOCOL_BUCKET_LABELS)).toHaveLength(LEAN_BUCKETS.length);
    expect(Object.isFrozen(PROTOCOL_BUCKET_LABELS)).toBe(true);
    // One map: the sheet, the notice's callers and the e2e fixture read the same object.
    expect(BUCKET_LABELS).toBe(PROTOCOL_BUCKET_LABELS);
  });
});
