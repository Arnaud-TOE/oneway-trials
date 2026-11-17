import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Fonts are bundled and served by the site itself: no request to a font service.
import "@fontsource-variable/geist";
import "@fontsource/instrument-serif/latin-400-italic.css";
import { App } from "./app/App";
import { initTheme } from "./app/theme";

initTheme();

async function pick() {
  // Development-only measurement pages, kept out of the production bundle.
  if (import.meta.env.DEV && location.hash === "#spike") return (await import("./spike/Spike")).Spike;
  if (import.meta.env.DEV && location.hash === "#engine") return (await import("./spike/EngineRun")).EngineRun;
  if (import.meta.env.DEV && (location.hash === "#bench" || location.hash === "#bench-test")) return (await import("./bench/Bench")).Bench;
  if (import.meta.env.DEV && location.hash === "#warm") return (await import("./spike/Warm")).Warm;
  return App;
}

void pick().then((Page) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Page />
    </StrictMode>,
  );
});
