import { useSyncExternalStore } from "react";

/**
 * Light, dark, or the system's choice. The choice is a per-viewer convenience,
 * kept in this browser's local storage; the page works the same without it.
 */
export type ThemeChoice = "system" | "light" | "dark";

const KEY = "oneway-theme";
const listeners = new Set<() => void>();

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let current: ThemeChoice = typeof window === "undefined" ? "system" : read();

function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export function initTheme(): void {
  apply(current);
}

export function setTheme(choice: ThemeChoice): void {
  current = choice;
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage blocked: the choice still applies to this visit.
  }
  apply(choice);
  for (const l of listeners) l();
}

/** Light, dark, system, light… */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return choice === "system" ? "light" : choice === "light" ? "dark" : "system";
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
