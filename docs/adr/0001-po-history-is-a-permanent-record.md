# PO History is a permanent record, written when each change happens

PO History is stored as its own append-only record. Each History Entry is written at the moment the change happens. It is not built on the fly from the purchase order, notes and tracking tables. Deleting a shipment removes its notes, Tracking Events and PO links. A PO's history must outlive that, and it must be able to prove when something like "Deposit paid" was set and by whom. So History Entries copy what they need (old and new values, note text, Tracking Event details) rather than pointing at rows that can disappear. Entries are never edited or deleted, and POs are never deleted (Cancelled is the end state), so no history is ever orphaned.

## Considered Options

- **Build history on the fly from existing tables.** No duplication, but notes and Tracking Events are lost when a shipment is deleted, and PO field changes overwrite the old value, so there is nothing to build from.
- **Allow editing or hiding entries.** Rejected: the log exists to be a trustworthy record of what happened in the app.

## Consequences

Note text and Tracking Event details exist both in their own tables and in PO History. This duplication is deliberate. Do not "clean it up".
