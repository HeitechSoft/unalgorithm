/** The balance notice (P3-72): one wording for every list, from `listBalance`'s plain-words warnings. */
import { cleanup, render, screen, within } from '@testing-library/react';
import { FEATURE_NAMES, LEAN_BUCKETS, BUCKET_LABELS as PROTOCOL_BUCKET_LABELS } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { BalanceNotice, BUCKET_LABELS } from '../src/index.ts';

afterEach(cleanup);

describe('balance notice', () => {
  it('test_balance_notice_states', () => {
    const balanced = render(<BalanceNotice name="UnAlgorithm Cloud's list" empty={false} warnings={[]} />);
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

  it('test_bucket_labels_in_protocol', () => {
    expect(LEAN_BUCKETS.map((b) => PROTOCOL_BUCKET_LABELS[b])).toEqual(['Left', 'Leans left', 'Center', 'Leans right', 'Right']);
    expect(Object.keys(PROTOCOL_BUCKET_LABELS)).toHaveLength(LEAN_BUCKETS.length);
    expect(Object.isFrozen(PROTOCOL_BUCKET_LABELS)).toBe(true);
    // One map: the sheet, the notice's callers and the e2e fixture read the same object.
    expect(BUCKET_LABELS).toBe(PROTOCOL_BUCKET_LABELS);
  });
});
