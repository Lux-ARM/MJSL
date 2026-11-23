import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import { buildAmpIndex, buildNoiseIndex, buildZones, rankZones, scoreAllProfiles, ZONE_CONFIG } from "../../domain/zone/index.js";
import { mergeTiles } from "./mergeTiles.js";
import { OSM_TILES, SOCIAL_TILES } from "./zonePreset.js";

const dataUrl = new URL("../../../public/data/", import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, dataUrl), "utf8"));
const tiles: FeatureCollection[] = [...OSM_TILES, ...SOCIAL_TILES].map((p) =>
  JSON.parse(gunzipSync(readFileSync(new URL(`osm/${p.id}.geojson.gz`, dataUrl))).toString("utf8")),
);

// Same normalization used by the read-only Marseille reference audit.
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)]),
  );
  return typeof value === "number" && !Number.isInteger(value) ? Number(value.toFixed(9)) : value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");

function analyse(osm: FeatureCollection) {
  const zones = buildZones({
    zones: readJson("amp/zones.geojson"), osm, reports: readJson("reports.json"),
    amp: buildAmpIndex({ transit: readJson("amp/transit.json"), tourism: readJson("amp/tourism.json"), qpv: readJson("amp/qpv.geojson"), projects: readJson("amp/projects.geojson") }),
    noiseIndex: buildNoiseIndex(readJson("noise_lden_all.geojson")),
  }, ZONE_CONFIG);
  const records = [...zones].sort((a, b) => a.id.localeCompare(b.id)).map((z) => ({
    id: z.id, values: z.values, sources: z.sources, counts: z.counts,
    areaKm2: z.areaKm2, streetKm: z.streetKm, scores: scoreAllProfiles(z, ZONE_CONFIG),
  }));
  const rankings = Object.fromEntries(Object.keys(ZONE_CONFIG.profiles).map((profile) => {
    const scores = Object.fromEntries(records.map((r) => [r.id, r.scores[profile]!]));
    return [profile, rankZones(zones, scores, ZONE_CONFIG).map((r) => ({ id: r.zone.id, rank: r.rank, score: r.score }))];
  }));
  return { zones, records, rankings };
}

describe("canonical Marseille OSM tiles", () => {
  it("retains whole real representations, including the shorter Rue du Cambodge", () => {
    const merged = mergeTiles(tiles);
    for (const id of ["way/24256613", "way/24256611", "node/7054970478", "way/32566250", "way/476892367"]) {
      const copies = tiles.flatMap((t) => t.features.filter((f) => f.id === id));
      expect(copies.length).toBeGreaterThan(1);
      expect(merged.features.find((f) => f.id === id)).toBe(copies[0]);
    }
    const cambodge = merged.features.find((f) => f.id === "way/24256613")!;
    expect(cambodge.geometry.type).toBe("LineString");
    if (cambodge.geometry.type === "LineString") expect(cambodge.geometry.coordinates).toHaveLength(4);
    expect(cambodge.properties).toMatchObject({ highway: "living_street", maxspeed: "20" });
  });

  it("matches the measured reference and preserves objects, scores and rankings across arrival permutations", () => {
    const canonical = mergeTiles(tiles);
    const baseline = analyse(canonical);
    expect(canonical.features).toHaveLength(111305);
    expect(baseline.zones).toHaveLength(393);
    expect(digest(baseline.records)).toBe("03b574ea4381fdf393e9d53d845e13e01b057371462943ff00cade08f054dbc6");
    const rankingHashes = {
      wheelchair: "951392f411007f135ad1e6cb4863e2fdfe7bb286455b8492f931adb562be5156",
      blind: "23896a8c2cea74d8d415b6ba081b231bc914c6377deeb7bbd5f6e85d15e21301",
      allophone: "78160c8c23894448ebe2778fb84cfe837a515c87d3d40de35dc2f083aa0bda19",
      low_income: "d9bb335534faaf85762c034febde02022406117be7384faf2fe00009edf6c608",
    };
    for (const [profile, hash] of Object.entries(rankingHashes)) {
      expect(baseline.rankings[profile]).toHaveLength(340);
      expect(digest(baseline.rankings[profile])).toBe(hash);
    }
    const forward = tiles.map((_, i) => i);
    const shuffled = [...forward];
    let seed = 123456789;
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    for (const arrivals of [forward, [...forward].reverse(), shuffled]) {
      const slots: (FeatureCollection | undefined)[] = [];
      for (const i of arrivals) slots[i] = tiles[i];
      const merged = mergeTiles(slots);
      expect(merged).toEqual(canonical);
      const actual = analyse(merged);
      expect(actual.records).toEqual(baseline.records);
      expect(actual.rankings).toEqual(baseline.rankings);
    }
  }, 30000);

  it("skips failed tiles, uses osm_id as fallback and keeps anonymous features", () => {
    const feature = { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [5, 43] }, properties: { osm_id: "node/1" } };
    const anonymous = { ...feature, properties: {} };
    expect(mergeTiles([undefined, { type: "FeatureCollection", features: [feature, anonymous, anonymous] }, { type: "FeatureCollection", features: [feature] }]).features).toEqual([feature, anonymous, anonymous]);
  });
});
