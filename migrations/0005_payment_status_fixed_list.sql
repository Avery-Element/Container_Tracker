-- Payment Status becomes a fixed list: Not paid / Deposit paid / Paid (GLOSSARY.md).
-- Decided 2026-11-20: every PO outside the list was an old, already-received PO, so all
-- become Paid (no Paid Date: it was never recorded). Old free-text values are kept as a
-- PO note. Every change is logged in PO History, attributed to "system".

-- 1. Keep any old free-text value as a note on the PO (and in its history).
INSERT INTO notes (po_id, author, body)
SELECT id, 'system',
  'Payment status was "' || payment_status || '" before it became a fixed list (Not paid / Deposit paid / Paid). Set to Paid.'
FROM purchase_orders
WHERE payment_status IS NOT NULL AND payment_status <> '' AND payment_status NOT IN ('not_paid', 'deposit_paid', 'paid');

INSERT INTO po_history (po_id, actor, kind, body)
SELECT id, 'system', 'note',
  'Payment status was "' || payment_status || '" before it became a fixed list (Not paid / Deposit paid / Paid). Set to Paid.'
FROM purchase_orders
WHERE payment_status IS NOT NULL AND payment_status <> '' AND payment_status NOT IN ('not_paid', 'deposit_paid', 'paid');

-- 2. Log the change itself.
INSERT INTO po_history (po_id, actor, kind, field, old_value, new_value)
SELECT id, 'system', 'field_changed', 'payment_status', NULLIF(payment_status, ''), 'paid'
FROM purchase_orders
WHERE COALESCE(payment_status, '') NOT IN ('not_paid', 'deposit_paid', 'paid');

-- 3. Make the change.
UPDATE purchase_orders SET payment_status = 'paid', updated_at = datetime('now')
WHERE COALESCE(payment_status, '') NOT IN ('not_paid', 'deposit_paid', 'paid');
