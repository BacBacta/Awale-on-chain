import { describe, it, expect } from "vitest";
import { roundFromWeek } from "../src/weekly-prizes.js";

describe("roundFromWeek", () => {
  it("maps a Monday date key to a unique monotonic round", () => {
    expect(roundFromWeek("2026-07-06")).toBe(20260706n);
    expect(roundFromWeek("2026-07-13")).toBe(20260713n);
    // strictly increasing across weeks → safe as a round id
    expect(roundFromWeek("2026-07-13") > roundFromWeek("2026-07-06")).toBe(true);
    expect(roundFromWeek("2027-01-04") > roundFromWeek("2026-12-28")).toBe(true);
  });
  it("rejects a malformed week key", () => {
    expect(() => roundFromWeek("2026-W27")).toThrow();
    expect(() => roundFromWeek("garbage")).toThrow();
  });
});
