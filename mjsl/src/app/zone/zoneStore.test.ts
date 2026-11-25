import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { FeatureCollection } from "geojson";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { OSM_TILES, SOCIAL_TILES } from "../overpass/zonePreset.js";
import { mergeTiles } from "../overpass/mergeTiles.js";

const { loadPreset } = vi.hoisted(() => ({ loadPreset: vi.fn() }));
vi.mock("../overpass/client.js", () => ({ loadPreset }));
vi.mock("../state.js", () => ({ useAppStore: { getState: () => ({ setStatus: vi.fn() }) } }));
vi.stubGlobal("window", {});
afterAll(() => vi.unstubAllGlobals());
afterEach(() => vi.useRealTimers());

const presets = [...OSM_TILES, ...SOCIAL_TILES];
const tiles: FeatureCollection[] = presets.map((p) => JSON.parse(gunzipSync(readFileSync(
  new URL(`../../../public/data/osm/${p.id}.geojson.gz`, import.meta.url),
)).toString("utf8")));

it("keeps parallel city loading and canonical precedence when real snapshots arrive out of order", async () => {
  const { loadCity } = await import("./zoneStore.js");
  vi.useFakeTimers();
  const expected = mergeTiles(tiles);
  for (const reverse of [false, true]) {
    let activeMain = 0;
    let peakMain = 0;
    const arrivals: number[] = [];
    loadPreset.mockReset();
    loadPreset.mockImplementation(async (preset: { id: string }) => {
      const i = presets.findIndex((p) => p.id === preset.id);
      const main = i < OSM_TILES.length;
      if (main) peakMain = Math.max(peakMain, ++activeMain);
      await new Promise((resolve) => setTimeout(resolve, reverse ? 8 - i % 8 : i % 8 + 1));
      if (main) activeMain--;
      arrivals.push(i);
      return { geojson: tiles[i], fromCache: true, timestamp: 0 };
    });
    const progress = vi.fn();
    const loading = loadCity(false, progress);
    await vi.runAllTimersAsync();
    const result = await loading;
    expect(peakMain).toBe(8);
    expect(loadPreset).toHaveBeenCalledTimes(60);
    expect(result).toMatchObject({ failed: 0, fromCache: true, unchanged: false });
    expect(result.geojson).toEqual(expected);
    expect(progress).toHaveBeenLastCalledWith(48, 48);
    if (reverse) expect(arrivals[0]).not.toBe(0);
  }
});

it("keeps a retried high-priority tile ahead of earlier completed lower-priority copies", async () => {
  const { loadCity } = await import("./zoneStore.js");
  const priority = OSM_TILES.findIndex((p) => p.id === "walkways_mjsl5_r2c3");
  let attempts = 0;
  loadPreset.mockReset();
  loadPreset.mockImplementation(async (preset: { id: string }) => {
    const i = presets.findIndex((p) => p.id === preset.id);
    if (i === priority && attempts++ === 0) throw new Error("temporary failure");
    return { geojson: tiles[i], fromCache: true, timestamp: 0 };
  });
  const result = await loadCity(false, () => {});
  expect(attempts).toBe(2);
  expect(result.failed).toBe(0);
  expect(result.geojson).toEqual(mergeTiles(tiles));
});
