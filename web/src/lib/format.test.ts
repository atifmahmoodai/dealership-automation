import { describe, expect, it } from "vitest";
import { ago, applySettings, fmtMoney, fromLocalInput, parseMoney, toLocalInput } from "./format";

describe("money input", () => {
  it("reads what people type", () => {
    expect(parseMoney("1,250")).toBe(125_000);
    expect(parseMoney(" 1250.5 ")).toBe(125_050);
    expect(parseMoney("0.99")).toBe(99);
    expect(Number.isNaN(parseMoney("12k"))).toBe(true);
    expect(Number.isNaN(parseMoney("1.234"))).toBe(true);
    expect(Number.isNaN(parseMoney("-5"))).toBe(true);
  });
  it("formats in the garage's currency", () => {
    applySettings({ currency: "EUR", locale: "de-DE" }, "Europe/Berlin");
    expect(fmtMoney(123_456)).toMatch(/1\.234,56\s€/);
    applySettings({ currency: "USD", locale: "en-US" }, "UTC");
    expect(fmtMoney(123_456)).toBe("$1,234.56");
  });
});

describe("times in the garage's time zone", () => {
  it("round-trips, including across a daylight-saving change", () => {
    applySettings({ currency: "USD", locale: "en-US" }, "America/New_York");
    for (const local of ["2026-03-07T10:00", "2026-03-08T10:00", "2026-11-01T09:30", "2026-07-04T23:45"]) {
      expect(toLocalInput(fromLocalInput(local))).toBe(local);
    }
    // 10:00 in New York in summer is 14:00 UTC.
    expect(fromLocalInput("2026-07-01T10:00")).toBe("2026-07-01T14:00:00.000Z");
    expect(fromLocalInput("not a date")).toBeNull();
  });
});

describe("relative times", () => {
  it("reads naturally", () => {
    expect(ago(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5 min ago");
    expect(ago(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe("3 h ago");
    expect(ago(null)).toBe("—");
  });
});
