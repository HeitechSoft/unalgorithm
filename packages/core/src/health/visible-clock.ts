/**
 * Counts the time a page has been visible (ADR 0009 §3): every breakage check's time limit counts visible time only,
 * so a feed left in a background tab never looks stuck. The caller reports visibility changes (`visibilitychange`).
 */
export class VisibleClock {
  private total = 0;
  private since: number | null;
  private readonly now: () => number;

  constructor(visible: boolean, now: () => number = Date.now) {
    this.now = now;
    this.since = visible ? now() : null;
  }

  setVisible(visible: boolean): void {
    if (visible && this.since === null) this.since = this.now();
    else if (!visible && this.since !== null) {
      this.total += Math.max(0, this.now() - this.since);
      this.since = null;
    }
  }

  get visible(): boolean {
    return this.since !== null;
  }

  /** Visible time so far, in ms. */
  ms(): number {
    return this.total + (this.since === null ? 0 : Math.max(0, this.now() - this.since));
  }
}
