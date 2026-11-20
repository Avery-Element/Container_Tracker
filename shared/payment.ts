// Payment Status and its dates (see GLOSSARY.md).
//
// Rules:
// - Payment Status is one of exactly three values.
// - Deposit paid needs a Deposit Paid Date; Paid needs a Paid Date. If none is given,
//   the existing date is kept, or today is used.
// - Going back to an earlier status clears the dates that no longer apply
//   (Not paid clears both; Deposit paid clears the Paid Date). The change is logged
//   like any other, so nothing is lost from PO History.

export const PAYMENT_STATUSES = ["not_paid", "deposit_paid", "paid"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export { PAYMENT_LABELS } from "./normalize";

interface PaymentFields {
  payment_status?: string | null;
  deposit_paid_on?: string | null;
  paid_on?: string | null;
}

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const clean = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v === "" ? null : v);

/**
 * Applies the payment rules to an incoming change. Returns the payment fields to save
 * (only those that need writing), or an error message for the user.
 */
export function resolvePayment(
  current: PaymentFields,
  patch: PaymentFields,
  today: string,
): { fields: PaymentFields } | { error: string } {
  const out: PaymentFields = {};
  const status = clean(patch.payment_status);
  const deposit = clean(patch.deposit_paid_on);
  const paid = clean(patch.paid_on);

  for (const [name, v] of [["Deposit paid date", deposit], ["Paid date", paid]] as const)
    if (v && !isDay(v)) return { error: `${name} must be a date (YYYY-MM-DD)` };

  if (status !== undefined) {
    if (!PAYMENT_STATUSES.includes(status as PaymentStatus))
      return { error: "Payment status must be Not paid, Deposit paid or Paid" };
    out.payment_status = status;
  }
  if (deposit !== undefined) out.deposit_paid_on = deposit;
  if (paid !== undefined) out.paid_on = paid;

  const finalStatus = status ?? current.payment_status ?? null;
  const final = (k: "deposit_paid_on" | "paid_on") => (k in out ? out[k] : (current[k] ?? null));

  if (finalStatus === "not_paid") {
    if (current.deposit_paid_on || deposit) out.deposit_paid_on = null;
    if (current.paid_on || paid) out.paid_on = null;
  }
  if (finalStatus === "deposit_paid") {
    if (!final("deposit_paid_on")) {
      if (deposit === null && status === undefined) return { error: "A PO marked Deposit paid needs the date it was paid" };
      out.deposit_paid_on = today;
    }
    if (current.paid_on || paid) out.paid_on = null;
  }
  if (finalStatus === "paid" && !final("paid_on")) {
    if (paid === null && status === undefined) return { error: "A PO marked Paid needs the date it was paid" };
    out.paid_on = today;
  }
  return { fields: out };
}
