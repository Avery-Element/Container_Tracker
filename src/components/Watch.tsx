// Watching: a shared tag that pins a line to the top of the Shipments table and lists it on
// the Dashboard. A container line also counts as watched when any PO on its shipment is
// watched, so the watch follows a PO onto its containers once it's booked.
import { useState } from "react";
import { api, type Container, type PoRef } from "../api";
import { fmtDate } from "./ui";

type Watchable = { watched_by?: string | null; watched_at?: string | null };
type Line = { s: { pos: PoRef[] }; c: Container | null };

/** Highlight for a watched row in a table: pale route-blue fill and a route-blue bar on the left edge. */
export const WATCHED_ROW =
  "[&>td]:bg-route-50 [&>td:first-child]:shadow-[inset_3px_0_0_var(--color-route),inset_-1px_0_0_var(--color-line)]";

/** "avery, Nov 24": who ticked it (the part of the email before the @) and when. */
export function watchedBy(w: Watchable): string {
  return `${w.watched_by?.split("@")[0] ?? "someone"}, ${fmtDate(w.watched_at)}`;
}

export interface LineWatch {
  watched: boolean;
  /** The container itself is watched (or, for a shipment with no containers, nothing). */
  own: boolean;
  /** Watched POs on the shipment, which make the line watched too. */
  viaPos: PoRef[];
  /** One sentence for a tooltip or the Dashboard. */
  why: string;
}

export function lineWatch(r: Line): LineWatch {
  const own = !!r.c?.watched_at;
  const viaPos = r.s.pos.filter((p) => p.watched_at);
  const via = viaPos.map((p) => `PO ${p.po_number}`).join(", ");
  const why = own
    ? `Watched by ${watchedBy(r.c!)}`
    : viaPos.length
      ? `Watched because ${via} ${viaPos.length === 1 ? "is" : "are"} watched`
      : "";
  return { watched: own || viaPos.length > 0, own, viaPos, why };
}

/**
 * Tick or untick a container line. Ticking watches the container (or, for a shipment with no
 * containers yet, its POs). Unticking clears the container and any watched PO behind it.
 */
export async function setLineWatch(r: Line, next: boolean) {
  const w = lineWatch(r);
  if (next) {
    if (r.c) await api.patch(`/containers/${r.c.id}`, { watched: true });
    else await Promise.all(r.s.pos.map((p) => api.patch(`/pos/${p.id}`, { watched: true })));
    return;
  }
  await Promise.all([
    ...(w.own && r.c ? [api.patch(`/containers/${r.c.id}`, { watched: false })] : []),
    ...w.viaPos.map((p) => api.patch(`/pos/${p.id}`, { watched: false })),
  ]);
}

/** The Watching checkbox. Saves straight away, then calls onSaved so the page reloads. */
export function WatchBox({
  watched,
  label,
  title,
  onToggle,
  onSaved,
}: {
  watched: boolean;
  /** Read by screen readers, e.g. "Watch container TGHU5303645". */
  label: string;
  title: string;
  onToggle: (next: boolean) => Promise<unknown>;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <input
      type="checkbox"
      className={`mr-2 size-4 shrink-0 cursor-pointer align-[-3px] accent-route ${error ? "outline-2 outline-hold" : ""}`}
      aria-label={label}
      title={error ? `Couldn't save: ${error}` : title}
      checked={watched}
      disabled={busy}
      onChange={async (e) => {
        setBusy(true);
        setError(null);
        try {
          await onToggle(e.target.checked);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
          onSaved();
        }
      }}
    />
  );
}
