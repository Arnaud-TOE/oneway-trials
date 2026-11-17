import { CheckCircle2, Info, PartyPopper, X } from "lucide-react";
import { dismissToast, useToasts } from "./toast";

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = t.tone === "success" ? CheckCircle2 : t.tone === "celebrate" ? PartyPopper : Info;
        return (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon size={18} aria-hidden="true" />
            <span>{t.text}</span>
            <button className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
