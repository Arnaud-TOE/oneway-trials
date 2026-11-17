import { useEffect, useState } from "react";
import { clock } from "./view";

/** Time since a step started, so a slow step on a laptop visibly moves. */
export function Elapsed({ since }: { since: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since === null) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [since]);
  if (since === null) return null;
  return (
    <span className="elapsed" aria-hidden="true">
      {clock(Date.now() - since)}
    </span>
  );
}
