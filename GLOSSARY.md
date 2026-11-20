# Glossary

## Purchase Orders

**PO History**
The full chronological record of everything that happened to a Purchase Order, starting the moment it is entered. It is made up of History Entries.
_Avoid_: event log, audit log, PO events

**History Entry**
One recorded happening in a PO History: who did it, when it was recorded, and what happened. A change to a PO field produces one History Entry per field, showing the old and new value. These also produce History Entries: linking or unlinking a shipment (including because a shipment was deleted), adding a note, ETA changes on the PO's shipments, delivery appointment and received-date changes on its containers, containers being added to or removed from its shipments, shipment status changes, tracking starting or failing, and Tracking Events on its shipments.
History Entries are permanent. Nobody can edit, hide or delete one. A mistake is fixed by making another change, which adds its own entry.
_Avoid_: event (reserved for Tracking Event)

**Cancelled (PO)**
The final state of a PO that won't go ahead. POs are never deleted, so their history is never lost.

**Payment Status**
One of exactly three values: Not paid, Deposit paid, Paid.

**Shipment note / PO note**
A Shipment note is written on a shipment and appears in the PO History of every PO on that shipment. A PO note is written on one PO and appears only in that PO's history.

**Recorded time / Occurred time**
Recorded time is when the app learned of something. History Entries are ordered by recorded time. A Tracking Event also shows its occurred time: when it happened in the real world.

**Activity Feed**
A view of History Entries across all POs, filterable (e.g. every Payment Status change this month).

**Imported entry**
The first History Entry for any PO that existed before PO History began. It records the PO's values at that moment, attributed to "system". Notes and Tracking Events the app already had before then are also brought into the PO History, marked as pre-history.

**Deposit Paid Date / Paid Date**
The date the money actually moved, recorded on the PO itself. Separate from when someone recorded the payment status change in the app.

## Tracking

**Tracking Event**
A milestone reported by the carrier or terminal through tracking (e.g. vessel departed, discharged). It belongs to a Shipment or Container, not to a PO.
_Avoid_: event, when you mean a History Entry

**Milestone**
A step on a container's journey: PO placed, Cargo ready, Booked, Loaded, Departed, Transshipment, Arrived, Discharged, On hold, Available, Out-gated, Delivered, Received. Many Tracking Events can map to the same Milestone.

**Origin departure**
The moment the vessel leaves the port of loading. In PO History, every Tracking Event before this point is shown. The departure itself, and everything after it, is shown as Milestone changes: one per Milestone passed, starting with Departed.
