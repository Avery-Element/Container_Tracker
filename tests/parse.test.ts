import { describe, expect, it } from "vitest";
import { isValidContainerNumber } from "../shared/container-number";
import { normalizeCarrier, planTracking } from "../shared/carriers";
import { normalizePayment, normalizeVendor, parseUSDate } from "../shared/normalize";
import { parseContainerLine, parsePoNumbers, parseTrackerCsv } from "../scripts/lib/parse-tracker";
import { buildModel } from "../scripts/lib/build-model";
import { advanceMilestone } from "../shared/milestones";

describe("container numbers", () => {
  it("validates ISO 6346 check digits", () => {
    expect(isValidContainerNumber("TGHU5303645")).toBe(true);
    expect(isValidContainerNumber("CBHU9193962")).toBe(true);
    expect(isValidContainerNumber("YMMU69682703")).toBe(false);
    expect(isValidContainerNumber("ONEU555655")).toBe(false);
  });
});

describe("normalisers", () => {
  it("maps carrier spellings", () => {
    expect(normalizeCarrier("YoungMing")?.scac).toBe("YMLU");
    expect(normalizeCarrier("Yangming")?.scac).toBe("YMLU");
    expect(normalizeCarrier("COSCO")?.scac).toBe("COSU");
    expect(normalizeCarrier("UPS")).toBeNull();
  });
  it("fixes typo dates", () => {
    expect(parseUSDate("5/202025")).toBe("2025-05-20");
    expect(parseUSDate("1/282026")).toBe("2026-01-28");
    expect(parseUSDate("7/7/20225")).toBe("2025-07-07");
    expect(parseUSDate("5/20/0225")).toBe("2025-05-20");
    expect(parseUSDate("8/25")).toBeNull();
  });
  it("normalises vendors and payment", () => {
    expect(normalizeVendor("Fo Shan ")).toBe("Foshan");
    expect(normalizeVendor("Motosthul")).toBe("Motostuhl");
    expect(normalizePayment("not paid ")).toBe("not_paid");
    expect(normalizePayment("Deposit paid ")).toBe("deposit_paid");
    expect(normalizePayment("pad")).toBe("paid");
  });
  it("extracts multiple PO numbers", () => {
    expect(parsePoNumbers("6053ELM\n5861ELM")).toEqual(["6053ELM", "5861ELM"]);
    expect(parsePoNumbers("NA")).toEqual([]);
  });
});

describe("container cell lines", () => {
  it("reads number, appointment and received flag", () => {
    const [c] = parseContainerLine("BMOU5991917 1/6 @ 8am rcvd", "2025-09-29");
    expect(c).toMatchObject({ number: "BMOU5991917", apptDate: "2026-01-06", apptTime: "08:00", received: true });
  });
  it("handles 24h times and flags", () => {
    const [c] = parseContainerLine("BMOU6300943 7/18 @ 0800", "2025-04-17");
    expect(c.apptTime).toBe("08:00");
    const [h] = parseContainerLine("BMOU3156540 HOT 8/13 @ 8am", "2026-05-13");
    expect(h.flags).toContain("HOT");
    expect(h.apptDate).toBe("2026-08-13");
  });
});

const SAMPLE = `Date,Vendor PI #, Vendor,PO#,Ctr Wires ,FF,Carrier,MBL ,Container,pallets,ETA (Port),Notes
7/27/2026,26JS0722-ELEM,Jiecang,5871ELM,not paid,THI,COSCO,COSU6508439620,CBHU9193962 9/29 8am,ok,rcvd,Sum32-S 600
7/1/2026,26 JS 0701-ELEM,Jiecang ,5805ELM ,not paid,THI,COSCO,COSU6508439620,CBHU9193962 9/29 8am,ok,rcvd,ships W/5871ELM
"10/5/2026
8/1/2026","26 JS 0929-ELEM
26 JS 0721-ELEM",Jiecang ,"6053ELM
5861ELM",not paid,THI,COSCO,COSU6470470830,"CSNU6943341
FCIU9704422 ",TEST,12/21/2026,"11/5 - Transhipment updated"
6/24/2025,OWM25370,Omni,4967ELM,deposit paid,,UPS,Long rail - white,1ZX2W3290498927099,,rcvd,Long rail
10/26/2026,STI01-09A-261019-21,Motostuhl,6129ELM,deposit paid,,,,CRD 11/25,,,
,,,,,,,,,,,
Joye,12/12,,,,,,,,,,
`;

describe("full import", () => {
  const rows = parseTrackerCsv(SAMPLE);
  const m = buildModel(rows, "2026-11-10");

  it("skips blank and side-table rows", () => {
    expect(rows).toHaveLength(5);
  });
  it("merges rows sharing an MBL into one shipment with both POs", () => {
    const shared = m.shipments.filter((s) => s.mbl === "COSU6508439620");
    expect(shared).toHaveLength(1);
    const links = m.shipmentPos.filter((l) => l.shipment_id === shared[0].id);
    expect(links).toHaveLength(2);
    expect(m.containers.filter((c) => c.number === "CBHU9193962")).toHaveLength(1);
  });
  it("keeps multi-container, multi-PO rows active", () => {
    const s = m.shipments.find((s) => s.mbl === "COSU6470470830")!;
    expect(s.status).toBe("active");
    expect(s.eta).toBe("2026-12-21");
    expect(m.containers.filter((c) => c.shipment_id === s.id)).toHaveLength(2);
  });
  it("classifies parcel rows and PO-only rows", () => {
    expect(m.shipments.find((s) => s.mode === "parcel")).toBeTruthy();
    const po = m.pos.find((p) => p.po_number === "6129ELM")!;
    expect(po.crd).toBe("2026-11-25");
    expect(po.status).toBe("open");
    expect(m.shipmentPos.some((l) => l.po_id === po.id)).toBe(false);
  });
  it("plans tracking by MBL for carrier bills, by container for house bills", () => {
    expect(planTracking({ mbl: "COSU6470470830", scac: "COSU", containers: [] }).type).toBe("bill_of_lading");
    expect(planTracking({ mbl: "SHZS03371327", scac: "ONEY", containers: ["ONEU2016445"] }).type).toBe("container");
  });
});

describe("milestones", () => {
  it("never moves backwards except hold/available", () => {
    expect(advanceMilestone("discharged", "departed")).toBe("discharged");
    expect(advanceMilestone("departed", "arrived")).toBe("arrived");
    expect(advanceMilestone("available", "on_hold")).toBe("on_hold");
  });
});
