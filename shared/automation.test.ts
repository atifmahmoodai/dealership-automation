import { describe, expect, it } from "vitest";
import { canonical, checkVehicle, isOptOut, localMinutes, nextSendTime, renderListing, renderTemplate, retryDelayMs, RULES, shorten, shouldBeListed } from "./automation";
import { csvCell } from "./csv";
import { ruleSchema, vehicleSchema } from "./schemas";
import type { Vehicle } from "./types";

const car: Vehicle = {
  id: "v1", stockNo: "A1", vin: "WVWZZZAUZLW123457", year: 2020, make: "Volkswagen", model: "Golf", trim: "Life 1.5 TSI", mileage: 30000,
  fuel: "Petrol", transmission: "Manual", body: "Hatchback", colour: "Blue", priceCents: 1_525_000, description: "Nice car", photos: ["https://x/1.jpg"],
  status: "available", version: 1, createdAt: "2026-01-01T00:00:00Z",
};

describe("channel checks", () => {
  it("blocks what a site would refuse and fixes what it can", () => {
    const autos = RULES["sandbox:autos"];
    expect(checkVehicle({ ...car, vin: "" }, autos).errors).toEqual(["Needs the VIN"]);
    expect(checkVehicle({ ...car, priceCents: 0 }, autos).errors).toContain("Needs a price");
    expect(checkVehicle({ ...car, photos: [] }, autos).errors).toContain("Needs at least 1 photo");
    const classifieds = RULES["sandbox:classifieds"];
    const long = { ...car, trim: "Life 1.5 TSI Evo 150PS DSG Estate" };
    expect(checkVehicle(long, classifieds).warnings).toContain("Title shortened to 40 characters");
    expect(renderListing(long, classifieds, "GBP").title.length).toBeLessThanOrEqual(40);
    expect(renderListing({ ...car, photos: Array(25).fill("https://x/p.jpg") }, classifieds, "GBP").photos).toHaveLength(10);
  });
  it("reserved cars stay up only where the site can show it", () => {
    expect(shouldBeListed("reserved", RULES["sandbox:autos"])).toBe(true);
    expect(shouldBeListed("reserved", RULES["sandbox:classifieds"])).toBe(false);
    expect(shouldBeListed("sold", RULES.webhook)).toBe(false);
  });
  it("hashes listings the same regardless of key order", () => {
    const p = renderListing(car, RULES.webhook, "GBP");
    const shuffled = Object.fromEntries(Object.entries(p).reverse()) as typeof p;
    expect(canonical(shuffled)).toBe(canonical(p));
    expect(canonical({ ...p, price: p.price - 1 })).not.toBe(canonical(p));
  });
  it("shortens on a word boundary", () => {
    expect(shorten("2020 Volkswagen Golf Life 1.5 TSI", 22)).toBe("2020 Volkswagen Golf…");
    expect(shorten("short", 10)).toBe("short");
  });
});

describe("messages", () => {
  const money = (c: number) => `£${(c / 100).toLocaleString("en-GB")}`;
  it("fills templates and never leaves a blank name", () => {
    const d = { buyerName: "  sam carter", vehicle: "2020 Golf", priceCents: 1_500_000, oldPriceCents: 1_600_000, dealerName: "Northside", dealerPhone: "", link: "" };
    expect(renderTemplate("Hi {buyer_first_name}, {vehicle} now {price} (was {old_price}). {link}", d, money)).toBe("Hi sam, 2020 Golf now £15,000 (was £16,000).");
    expect(renderTemplate("Hi {buyer_first_name}", { ...d, buyerName: "" }, money)).toBe("Hi there");
  });
  it("recognises opt-outs without catching ordinary sentences", () => {
    for (const t of ["STOP", "stop.", " Unsubscribe ", "opt out", "remove me!"]) expect(isOptOut(t), t).toBe(true);
    for (const t of ["Please don't stop the viewing", "Can you stop by?", "stopped by yesterday"]) expect(isOptOut(t), t).toBe(false);
  });
  it("only accepts known template fields", () => {
    expect(ruleSchema.safeParse({ name: "x x", trigger: "new_enquiry", delayMinutes: 0, template: "Hi {buyer_first_name}", enabled: true }).success).toBe(true);
    expect(ruleSchema.safeParse({ name: "x x", trigger: "new_enquiry", delayMinutes: 0, template: "Hi {first}", enabled: true }).success).toBe(false);
  });
});

describe("quiet hours", () => {
  it("waits until quiet hours end, across midnight", () => {
    const t = nextSendTime(new Date("2026-06-10T22:30:00Z"), "20:00", "08:00", "UTC");
    expect(t.toISOString()).toBe("2026-06-11T08:00:00.000Z");
    expect(nextSendTime(new Date("2026-06-10T03:10:00Z"), "20:00", "08:00", "UTC").toISOString()).toBe("2026-06-10T08:00:00.000Z");
    const day = new Date("2026-06-10T12:00:00Z");
    expect(nextSendTime(day, "20:00", "08:00", "UTC")).toBe(day);
  });
  it("uses the dealer's local time, including across a clock change", () => {
    // 21:30 in London in summer (BST) is 20:30 UTC.
    const t = nextSendTime(new Date("2026-06-10T20:30:00Z"), "20:00", "08:00", "Europe/London");
    expect(localMinutes(t, "Europe/London")).toBe(8 * 60);
    // The night the clocks go back (25 Oct 2026): still lands on 08:00 local.
    const t2 = nextSendTime(new Date("2026-10-24T22:00:00Z"), "20:00", "08:00", "Europe/London");
    expect(localMinutes(t2, "Europe/London")).toBe(8 * 60);
    expect(t2.toISOString()).toBe("2026-10-25T08:00:00.000Z");
  });
  it("equal start and end means no quiet hours", () => {
    const at = new Date("2026-06-10T23:00:00Z");
    expect(nextSendTime(at, "00:00", "00:00", "UTC")).toBe(at);
  });
});

describe("inputs", () => {
  it("validates VINs and insists on https photos", () => {
    const base = { ...car, photos: ["https://x/1.jpg"] };
    expect(vehicleSchema.safeParse({ ...base, vin: "WVWZZZAUZLW12345I" }).success).toBe(false); // I isn't allowed
    expect(vehicleSchema.safeParse({ ...base, vin: "" }).success).toBe(true);
    expect(vehicleSchema.safeParse({ ...base, photos: ["http://x/1.jpg"] }).success).toBe(false);
  });
  it("backs off between retries and caps the wait", () => {
    expect([1, 2, 3].map(retryDelayMs)).toEqual([30_000, 120_000, 480_000]);
    expect(retryDelayMs(20)).toBe(6 * 3600_000);
  });
  it("CSV cells can't start a formula", () => {
    expect(csvCell("=cmd")).toBe("'=cmd");
  });
});
