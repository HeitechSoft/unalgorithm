/**
 * A stand-in for the native modal dialog in jsdom, for tests of pages that use this package's `Dialog`. Test code only,
 * loaded by a test setup file for its side effect; no page imports it.
 *
 * jsdom implements neither `HTMLDialogElement.showModal` nor `close`, so `Dialog` throws a TypeError there, and it has no
 * modal focus trap and no Escape to cancel. Installed only when `showModal` is missing, this does what a browser does
 * for the parts a unit test can see:
 * - `showModal()` opens the dialog and focuses its `[autofocus]` element, else its first focusable element (the dialog
 *   focusing steps);
 * - `close()` closes it, puts focus back where it was before `showModal()`, and fires `close`;
 * - a `cancel` event nobody cancelled closes the dialog, which is what the Escape key does in a browser. A test presses
 *   Escape by dispatching `new Event('cancel', { cancelable: true })` on the dialog.
 *
 * The focus trap itself and the Escape key are a browser's to prove (the extension's Playwright specs).
 */

const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

if (typeof HTMLDialogElement !== 'undefined' && typeof HTMLDialogElement.prototype.showModal !== 'function') {
  /** What had focus when each open dialog was shown, to go back to when it closes. */
  const focusedBefore = new WeakMap<HTMLDialogElement, Element | null>();
  const proto = HTMLDialogElement.prototype;

  proto.showModal = function showModal(this: HTMLDialogElement) {
    if (!this.isConnected) throw new DOMException('The dialog is not in a document.', 'InvalidStateError');
    if (this.open) return;
    focusedBefore.set(this, this.ownerDocument.activeElement);
    this.open = true;
    const target = this.querySelector<HTMLElement>('[autofocus]') ?? this.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
  };

  proto.close = function close(this: HTMLDialogElement, returnValue?: string) {
    if (!this.open) return;
    this.open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    const before = focusedBefore.get(this);
    focusedBefore.delete(this);
    if (before instanceof HTMLElement && before.isConnected) before.focus();
    this.dispatchEvent(new Event('close'));
  };

  // After every listener has run, as a browser decides after firing `cancel` whether Escape closes the dialog.
  const dispatchEvent = EventTarget.prototype.dispatchEvent;
  proto.dispatchEvent = function dispatchCancelable(this: HTMLDialogElement, event: Event) {
    const result = dispatchEvent.call(this, event);
    if (event.type === 'cancel' && event.target === this && !event.defaultPrevented) this.close();
    return result;
  };
}
