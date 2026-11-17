import { useSyncExternalStore } from "react";

/** Short confirmations shown at the bottom of the screen for a few seconds. */
export interface Toast {
  id: number;
  text: string;
  tone: "info" | "success" | "celebrate";
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function toast(text: string, tone: Toast["tone"] = "info", ms = 3200): void {
  const t = { id: nextId++, text, tone };
  // Never more than three at once: the oldest goes first.
  toasts = [...toasts, t].slice(-3);
  emit();
  setTimeout(() => dismissToast(t.id), ms);
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
  );
}
