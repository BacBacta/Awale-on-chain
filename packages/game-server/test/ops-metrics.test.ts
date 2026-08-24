import { describe, it, expect } from "vitest";
import { countryFromHeaders, failedTxRate, topCountries } from "../src/ops-metrics.js";

describe("countryFromHeaders", () => {
  it("reads each supported proxy header", () => {
    expect(countryFromHeaders({ "cf-ipcountry": "KE" })).toBe("KE");
    expect(countryFromHeaders({ "x-vercel-ip-country": "ng" })).toBe("NG");
    expect(countryFromHeaders({ "fly-client-country": "GH" })).toBe("GH");
    expect(countryFromHeaders({ "x-country-code": "ZA" })).toBe("ZA");
  });

  it("prefers the most trusted header when several are present", () => {
    expect(countryFromHeaders({ "cf-ipcountry": "KE", "x-country-code": "US" })).toBe("KE");
  });

  it("handles a header repeated as an array", () => {
    expect(countryFromHeaders({ "cf-ipcountry": ["BR", "US"] })).toBe("BR");
  });

  // never invent a country: an absent or anonymised header must read as unknown
  it("returns null rather than guessing", () => {
    expect(countryFromHeaders({})).toBeNull();
    expect(countryFromHeaders({ "cf-ipcountry": "XX" })).toBeNull(); // anonymised
    expect(countryFromHeaders({ "cf-ipcountry": "T1" })).toBeNull(); // Tor
    expect(countryFromHeaders({ "cf-ipcountry": "" })).toBeNull();
    expect(countryFromHeaders({ "cf-ipcountry": "KENYA" })).toBeNull(); // not ISO-2
  });
});

describe("failedTxRate", () => {
  it("is the share of submissions that failed", () => {
    expect(failedTxRate(9, 1)).toBeCloseTo(0.1);
    expect(failedTxRate(0, 4)).toBe(1);
    expect(failedTxRate(4, 0)).toBe(0);
  });

  it("reports 0 on no traffic instead of dividing by zero", () => {
    expect(failedTxRate(0, 0)).toBe(0);
  });
});

describe("topCountries", () => {
  it("ranks busiest first and caps the list", () => {
    expect(topCountries({ KE: 5, NG: 9, GH: 1 }, 2)).toEqual([
      { country: "NG", count: 9 },
      { country: "KE", count: 5 },
    ]);
  });

  it("breaks ties by country code so the order is stable", () => {
    expect(topCountries({ ZA: 3, KE: 3 })).toEqual([
      { country: "KE", count: 3 },
      { country: "ZA", count: 3 },
    ]);
  });

  it("drops empty tallies", () => {
    expect(topCountries({ KE: 0 })).toEqual([]);
    expect(topCountries({})).toEqual([]);
  });
});
