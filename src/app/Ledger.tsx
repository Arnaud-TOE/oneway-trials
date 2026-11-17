import { privacyGuard } from "../engine/privacy";
import type { RecordLevel } from "../engine/types";
import { session, useLedger } from "./session";

function seconds(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}

/**
 * The privacy ledger. Left lane: what stayed on the device. Right lane: every
 * request that left it, with the exact text that was sent, open to inspection.
 */
export function Ledger({ level, replay = false, remember = false }: { level: RecordLevel; replay?: boolean; remember?: boolean }) {
  const entries = useLedger();
  const device = entries.filter((e) => e.lane === "device");
  const modelCalls = device.filter((e) => e.kind !== "file" && e.kind !== "ocr" && e.kind !== "memory");
  const files = device.filter((e) => e.kind === "file").length;
  const quickReadings = device.filter((e) => e.kind === "ocr").length;
  const outbound = entries.filter((e) => e.lane === "outbound");
  const leaking = outbound.filter((e) => e.payload && privacyGuard.containsPrivateText(e.payload)).length;
  const deviceMs = modelCalls.reduce((sum, e) => sum + (e.ms ?? 0), 0);

  return (
    <aside className="ledger no-print" aria-labelledby="ledger-title">
      <h2 id="ledger-title">Privacy ledger{replay ? " (recorded)" : ""}</h2>

      {level === "private" ? (
        <p className={`ledger-proof ${leaking === 0 ? "is-clean" : "is-leak"}`} role="status">
          {outbound.length === 0
            ? "Nothing has left this device."
            : leaking === 0
              ? `${outbound.length} ${outbound.length === 1 ? "request has" : "requests have"} left this device. None contains text from your record.`
              : `${leaking} outbound ${leaking === 1 ? "request contains" : "requests contain"} text from your record.`}
        </p>
      ) : (
        <p className="ledger-proof is-sample" role="status">
          Fictional patient: not treated as private, so the cloud model may read it.
        </p>
      )}

      <section className="lane lane-device">
        <h3>
          Stayed on this device <span className="count">{device.length}</span>
        </h3>
        {device.length === 0 ? (
          <p className="lane-empty">Documents you open and model calls that read your record will be listed here. Their content is never stored.</p>
        ) : (
          <>
            <ul>
              {device.slice(-6).map((e) => (
                <li key={e.id}>
                  <span>{e.label}</span>
                  <span className="lane-time">{seconds(e.ms)}</span>
                </li>
              ))}
            </ul>
            <p className="lane-total">
              {[
                files > 0 ? `${files} ${files === 1 ? "document" : "documents"} opened here` : "",
                quickReadings > 0 ? `${quickReadings} quick ${quickReadings === 1 ? "text recognition" : "text recognitions"}` : "",
                modelCalls.length > 0
                  ? `${modelCalls.length} on-device model ${modelCalls.length === 1 ? "call" : "calls"}, ${seconds(deviceMs)} of local computing`
                  : "",
                "0 bytes sent.",
              ]
                .filter(Boolean)
                .join(", ")}
            </p>
          </>
        )}
      </section>

      <section className="lane lane-out">
        <h3>
          Left this device <span className="count">{outbound.length}</span>
        </h3>
        {outbound.length === 0 ? (
          <p className="lane-empty">
            Every request that carries content (cloud model, registry search, shared cache) will be listed here with the exact text it
            carried.
          </p>
        ) : (
          <ul>
            {outbound.map((e) => (
              <li key={e.id}>
                <details>
                  <summary>
                    <span className="dest">{e.destination}</span>
                    <span>{e.label}</span>
                  </summary>
                  <pre className="payload">{e.payload}</pre>
                </details>
              </li>
            ))}
          </ul>
        )}
        {outbound.length > 0 && (
          <p className="lane-total">
            Not listed: Firebase's own background traffic, which comes with any cloud request. App Check security tokens (Google
            reCAPTCHA checks that this is a real browser), the anonymous sign-in, the cache connection and the app's settings (Remote
            Config: which cloud model to use). OneWay puts nothing from your record in it.
          </p>
        )}
      </section>

      {remember && !replay && (
        <section className="lane lane-kept">
          <h3>Kept on this computer</h3>
          <p>Your record, results and list are in this browser's storage, for your next visit. They are never sent.</p>
          <button
            className="link"
            onClick={() => {
              if (window.confirm("Delete your record, your results and your list from this computer? This cannot be undone.")) void session.forgetEverything();
            }}
          >
            Delete everything kept here
          </button>
        </section>
      )}
    </aside>
  );
}
