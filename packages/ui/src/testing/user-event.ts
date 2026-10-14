import { type UserEvent, userEvent } from '@testing-library/user-event';

export type { UserEvent };

/**
 * The user-event session for tests of pages built with this package: the extension's and the server's web app. Test
 * code only; no page imports it.
 *
 * It types and clicks without a timer between steps. The default (`delay: 0`) waits a `setTimeout` after every key and
 * pointer step, which on Windows lasts a whole timer tick (about 15 ms), so a test that types an address and a code
 * spends most of its time asleep and runs past its timeout on a loaded machine. Each event still goes through React's
 * `act`, so what it changes at once is on the page before the next step.
 */
export function setupUser(): UserEvent {
  return userEvent.setup({ delay: null });
}
