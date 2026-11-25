import type { FeatureCollection } from "geojson";

/**
 * First representation wins in canonical tile order, never response order.
 * Marseille's reference order is OSM_TILES followed by SOCIAL_TILES. Missing
 * tiles are skipped; geometry and properties always travel together unchanged.
 */
export function mergeTiles(tiles: readonly (FeatureCollection | undefined)[]): FeatureCollection {
  const seen = new Set<string>();
  const features: FeatureCollection["features"] = [];
  for (const tile of tiles) {
    for (const feature of tile?.features ?? []) {
      const key = String(feature.id ?? feature.properties?.osm_id ?? "");
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      features.push(feature);
    }
  }
  return { type: "FeatureCollection", features };
}
