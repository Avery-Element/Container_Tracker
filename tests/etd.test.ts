import { describe, expect, it } from "vitest";
import { etdUrgency } from "../shared/etd";

describe("etdUrgency", () => {
  const today = "2026-11-24";
  it("is overdue once the ETD has passed", () => {
    expect(etdUrgency(today, "2026-11-23")).toEqual({ level: "overdue", days: -1 });
  });
  it("is soon from today up to 7 days ahead", () => {
    expect(etdUrgency(today, "2026-11-24")).toEqual({ level: "soon", days: 0 });
    expect(etdUrgency(today, "2026-12-01")).toEqual({ level: "soon", days: 7 });
  });
  it("is nothing further out, or with no ETD", () => {
    expect(etdUrgency(today, "2026-12-02")).toBeNull();
    expect(etdUrgency(today, null)).toBeNull();
    expect(etdUrgency(today, "")).toBeNull();
  });
});
