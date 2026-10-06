import { describe, expect, it } from "vitest";
import {
  modelCovers,
  modelResolutionKm,
  OPEN_METEO_MODELS,
  recommendForecastModels,
} from "../src/forecast";

const byId = (id: string) => OPEN_METEO_MODELS.find((m) => m.id === id)!;

describe("location-aware forecast model selection", () => {
  it("parses a resolution range by its finer figure", () => {
    expect(modelResolutionKm(byId("ncep_gfs_global"))).toBe(11);
    expect(modelResolutionKm(byId("meteofrance_arome_france_hd"))).toBe(1.3);
  });

  it("knows which regional domains hold a point", () => {
    expect(modelCovers(byId("knmi_harmonie_arome_netherlands"), 52.37, 4.9)).toBe(true);
    expect(modelCovers(byId("ncep_hrrr_conus"), 52.37, 4.9)).toBe(false);
    expect(modelCovers(byId("ecmwf_ifs"), -40, 170)).toBe(true);
  });

  it("picks the finest covering regionals plus the leading globals for Amsterdam", () => {
    const ids = recommendForecastModels(OPEN_METEO_MODELS, { lat: 52.37, lon: 4.9 });
    expect(ids).toContain("knmi_harmonie_arome_netherlands");
    expect(ids).toContain("dmi_harmonie_arome_europe");
    expect(ids).toContain("ecmwf_ifs");
    expect(ids).not.toContain("ncep_hrrr_conus");
    expect(ids).not.toContain("jma_msm");
    expect(ids.length).toBeGreaterThanOrEqual(5);
    expect(ids.length).toBeLessThanOrEqual(10);
    // one per family: AROME France HD, never also AROME France
    expect(ids.filter((id) => id.startsWith("meteofrance_arome")).length).toBeLessThanOrEqual(
      1,
    );
  });

  it("gives a US point its own high-resolution models and GFS as a home global", () => {
    const ids = recommendForecastModels(OPEN_METEO_MODELS, { lat: 39.7, lon: -105 });
    expect(ids.slice(0, 2).sort()).toEqual(["ncep_hrrr_conus", "ncep_nbm_conus"]);
    expect(ids).not.toContain("cmc_gem_gdps"); // 3-hourly: no home bonus over ICON / UKMO
    expect(ids).toContain("ecmwf_ifs");
    expect(ids).toContain("ncep_gfs_global");
    expect(ids).not.toContain("knmi_harmonie_arome_netherlands");
    expect(ids).not.toContain("icon_d2");
  });

  it("falls back to five globals in the open ocean", () => {
    const ids = recommendForecastModels(OPEN_METEO_MODELS, { lat: -30, lon: -150 });
    expect(ids.length).toBe(5);
    expect(ids[0]).toBe("ecmwf_ifs");
    for (const id of ids) expect(byId(id).coverage).toBeUndefined();
  });

  it("swaps out a model that returned nothing for the point", () => {
    const base = recommendForecastModels(OPEN_METEO_MODELS, { lat: 52.37, lon: 4.9 });
    const without = recommendForecastModels(
      OPEN_METEO_MODELS,
      { lat: 52.37, lon: 4.9 },
      { exclude: new Set(["knmi_harmonie_arome_netherlands"]) },
    );
    expect(without).not.toContain("knmi_harmonie_arome_netherlands");
    expect(without.length).toBe(base.length);
  });

  it("never stacks more than two regionals or three models from one provider", () => {
    for (const p of [
      { lat: 48.86, lon: 2.35 },
      { lat: 51.5, lon: -0.12 },
      { lat: 45.5, lon: -73.6 },
      { lat: 35.7, lon: 139.7 },
    ]) {
      const ids = recommendForecastModels(OPEN_METEO_MODELS, p);
      const perProvider = new Map<string, number>();
      for (const id of ids) {
        const prov = byId(id).provider;
        perProvider.set(prov, (perProvider.get(prov) ?? 0) + 1);
      }
      for (const n of perProvider.values()) expect(n).toBeLessThanOrEqual(3);
      expect(ids.length).toBeGreaterThanOrEqual(5);
      expect(ids.length).toBeLessThanOrEqual(10);
    }
  });
});
