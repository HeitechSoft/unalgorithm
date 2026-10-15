/**
 * The jsdom stand-in for the native modal dialog (`@unalgorithm/ui/test-support/dialog`): what the web app's and the
 * extension's dialog tests rely on behaves as a browser's dialog does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../test-support/dialog.ts';

/** A dialog in the page with `html` inside, after a button that has the focus. */
function setup(html: string) {
  document.body.innerHTML = `<button id="opener">Open</button><dialog>${html}</dialog>`;
  const opener = document.getElementById('opener') as HTMLButtonElement;
  opener.focus();
  return { opener, dialog: document.querySelector('dialog') as HTMLDialogElement };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('dialog stand-in', () => {
  it('showModal opens and focuses the first control, close goes back and fires close', () => {
    const { opener, dialog } = setup('<h2>Title</h2><p>Text</p><button disabled>Off</button><button>Cancel</button>');
    const onClose = vi.fn();
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    expect(dialog.open).toBe(true);
    expect(document.activeElement?.textContent).toBe('Cancel');
    dialog.close('done');
    expect(dialog.open).toBe(false);
    expect(dialog.returnValue).toBe('done');
    expect(document.activeElement).toBe(opener);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Closing a closed dialog does nothing.
    dialog.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an [autofocus] control wins, and a dialog outside the document cannot open', () => {
    const { dialog } = setup('<button>Cancel</button><button autofocus>Go</button>');
    dialog.showModal();
    expect(document.activeElement?.textContent).toBe('Go');
    expect(() => document.createElement('dialog').showModal()).toThrow(DOMException);
  });

  it('a cancel event closes the dialog unless a listener prevents it', () => {
    const { dialog } = setup('<button>Cancel</button>');
    const keep = (event: Event) => event.preventDefault();
    dialog.addEventListener('cancel', keep);
    dialog.showModal();
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(dialog.open).toBe(true);
    dialog.removeEventListener('cancel', keep);
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(dialog.open).toBe(false);
  });
});
