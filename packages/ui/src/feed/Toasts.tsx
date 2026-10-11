export interface ToastModel {
  id: string;
  title: string;
  action?: { label: string; onAction(): void };
}

/** Page-level toasts (bottom-left). Polite live region; each toast closes itself after a few seconds. */
export function ToastRegion({ toasts, onDismiss }: { toasts: ToastModel[]; onDismiss: (id: string) => void }) {
  return (
    <div className="ua-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="ua-toast">
          <span>{t.title}</span>
          {t.action ? (
            <button
              type="button"
              className="ua-btn"
              onClick={() => {
                t.action?.onAction();
                onDismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
