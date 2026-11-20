import { describe, expect, it } from "vitest";
import { resolvePayment } from "../shared/payment";

const TODAY = "2026-11-20";
const none = { payment_status: "not_paid", deposit_paid_on: null, paid_on: null };
const deposit = { payment_status: "deposit_paid", deposit_paid_on: "2026-11-03", paid_on: null };
const paid = { payment_status: "paid", deposit_paid_on: "2026-11-03", paid_on: "2026-11-15" };

describe("resolvePayment", () => {
  it("saves status and date together", () => {
    expect(resolvePayment(none, { payment_status: "deposit_paid", deposit_paid_on: "2026-11-03" }, TODAY)).toEqual({
      fields: { payment_status: "deposit_paid", deposit_paid_on: "2026-11-03" },
    });
  });

  it("uses today when no date is given", () => {
    expect(resolvePayment(none, { payment_status: "deposit_paid" }, TODAY)).toEqual({
      fields: { payment_status: "deposit_paid", deposit_paid_on: TODAY },
    });
  });

  it("keeps the deposit date when moving to Paid", () => {
    expect(resolvePayment(deposit, { payment_status: "paid", paid_on: "2026-11-15" }, TODAY)).toEqual({
      fields: { payment_status: "paid", paid_on: "2026-11-15" },
    });
  });

  it("clears dates that no longer apply when going back", () => {
    expect(resolvePayment(paid, { payment_status: "deposit_paid" }, TODAY)).toEqual({
      fields: { payment_status: "deposit_paid", paid_on: null },
    });
    expect(resolvePayment(paid, { payment_status: "not_paid" }, TODAY)).toEqual({
      fields: { payment_status: "not_paid", deposit_paid_on: null, paid_on: null },
    });
  });

  it("lets the date be corrected on its own", () => {
    expect(resolvePayment(deposit, { deposit_paid_on: "2026-11-04" }, TODAY)).toEqual({ fields: { deposit_paid_on: "2026-11-04" } });
  });

  it("refuses to clear the date of the current status", () => {
    expect(resolvePayment(deposit, { deposit_paid_on: "" }, TODAY)).toEqual({ error: "A PO marked Deposit paid needs the date it was paid" });
    expect(resolvePayment(paid, { paid_on: null }, TODAY)).toEqual({ error: "A PO marked Paid needs the date it was paid" });
  });

  it("refuses statuses outside the fixed list and bad dates", () => {
    expect(resolvePayment(none, { payment_status: "dep pd 30%" }, TODAY)).toHaveProperty("error");
    expect(resolvePayment(none, { payment_status: "" }, TODAY)).toHaveProperty("error");
    expect(resolvePayment(none, { payment_status: "paid", paid_on: "11/15/2026" }, TODAY)).toHaveProperty("error");
  });

  it("gives an old PO marked Deposit paid without a date today's date only when its status is set again", () => {
    const legacy = { payment_status: "deposit_paid", deposit_paid_on: null, paid_on: null };
    expect(resolvePayment(legacy, { payment_status: "deposit_paid" }, TODAY)).toEqual({
      fields: { payment_status: "deposit_paid", deposit_paid_on: TODAY },
    });
  });
});
