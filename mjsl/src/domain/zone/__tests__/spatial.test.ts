import { describe, expect, it } from "vitest";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { PolygonIndex, polygonsOf } from "../spatial.js";
import type { LngLat } from "../types.js";

const feature = (id: string, geometry: Geometry): Feature => ({
  type: "Feature",
  properties: { id },
  geometry,
});

const collection = (...features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });

const box = (minX: number, minY: number, maxX: number, maxY: number): LngLat[] => [
  [minX, minY],
  [maxX, minY],
  [maxX, maxY],
  [minX, maxY],
  [minX, minY],
];

/** A simple star-shaped polygon with 2 * points vertices, to exercise the 32-slab path. */
const star = (cx: number, cy: number, radius: number, points: number, inner = 0.55, rotation = 0): LngLat[] => {
  const ring: LngLat[] = [];
  for (let i = 0; i < points * 2; i += 1) {
    const angle = rotation + (i / (points * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? radius : radius * inner;
    ring.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  ring.push(ring[0]!);
  return ring;
};

const bboxOfRing = (ring: LngLat[]): [number, number, number, number] => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
};

/**
 * The implementation that shipped before the slab optimisation. Keeping a copy here
 * makes the parity test independent of the production code it is checking.
 */
function insideRings(point: LngLat, rings: LngLat[][]): boolean {
  const [x, y] = point;
  let odd = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
    }
  }
  return odd;
}

function referenceAt(collection: FeatureCollection, point: LngLat): string[] {
  const out: string[] = [];
  for (const feature of collection.features as Feature[]) {
    for (const rings of polygonsOf(feature.geometry)) {
      const outer = rings[0];
      if (!outer || outer.length < 4) continue;
      const [minX, minY, maxX, maxY] = bboxOfRing(outer);
      if (point[0] < minX || point[0] > maxX || point[1] < minY || point[1] > maxY) continue;
      if (insideRings(point, rings)) out.push(String(feature.properties?.id ?? ""));
    }
  }
  return out.sort();
}

const idsAt = (index: PolygonIndex, point: LngLat): string[] =>
  index.at(point).map((props) => String(props.id ?? "")).sort();

function firstMismatch(fc: FeatureCollection, points: LngLat[]): string | null {
  const index = new PolygonIndex(fc);
  for (const point of points) {
    const got = idsAt(index, point);
    const want = referenceAt(fc, point);
    if (got.length !== want.length || got.some((id, i) => id !== want[i])) {
      return `at [${point[0]}, ${point[1]}]: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
    }
  }
  return null;
}

/**
 * Vertices, edge midpoints, points a hair either side of each edge, exact slab
 * boundaries (k / 32 of the ring's height), and points just outside the bbox.
 */
function probePoints(ring: LngLat[]): LngLat[] {
  const points: LngLat[] = [];
  for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i]!;
    const b = ring[i + 1]!;
    points.push(a);
    const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    points.push(mid);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      const nx = -dy / len;
      const ny = dx / len;
      for (const side of [-1, 1]) {
        points.push([mid[0] + nx * 1e-10 * side, mid[1] + ny * 1e-10 * side]);
      }
    }
  }

  const [minX, minY, maxX, maxY] = bboxOfRing(ring);
  const height = maxY - minY;
  if (height > 0) {
    for (let k = 0; k <= 32; k += 1) {
      const y = minY + (height * k) / 32;
      for (const x of [minX, minX + 1e-10, (minX + maxX) / 2, maxX - 1e-10, maxX]) points.push([x, y]);
    }
  }
  points.push([minX - 1, minY], [maxX + 1, maxY], [(minX + maxX) / 2, minY - 1], [(minX + maxX) / 2, maxY + 1]);
  return points;
}

describe("PolygonIndex", () => {
  it("respects holes and rejects points outside the bounding box", () => {
    const outer = box(0, 0, 10, 10);
    const hole = box(3, 3, 7, 7);
    const fc = collection(feature("square", { type: "Polygon", coordinates: [outer, hole] }));
    const index = new PolygonIndex(fc);

    expect(idsAt(index, [5, 5])).toEqual([]); // inside the hole
    expect(idsAt(index, [1, 1])).toEqual(["square"]);
    expect(idsAt(index, [11, 5])).toEqual([]); // east of maxX
    expect(idsAt(index, [-1, 5])).toEqual([]);
    expect(idsAt(index, [5, -1])).toEqual([]);
    expect(idsAt(index, [5, 11])).toEqual([]);

    const points = [...probePoints(outer), ...probePoints(hole)];
    expect(firstMismatch(fc, points)).toBeNull();
  });

  it("matches the old ray-casting on a 32-vertex ring, including exact slab boundaries", () => {
    const outer = star(0, 0, 10, 16); // 32 vertices: the slab path, not the single-bucket path
    const fc = collection(feature("star", { type: "Polygon", coordinates: [outer] }));
    const index = new PolygonIndex(fc);

    expect(idsAt(index, [0, 0])).toEqual(["star"]);
    expect(idsAt(index, [20, 20])).toEqual([]);
    expect(firstMismatch(fc, probePoints(outer))).toBeNull();
  });

  it("matches on MultiPolygon features", () => {
    const fc = collection(
      feature("multi", {
        type: "MultiPolygon",
        coordinates: [[box(0, 0, 4, 4)], [box(10, 10, 14, 14)]],
      }),
    );
    const index = new PolygonIndex(fc);

    expect(idsAt(index, [2, 2])).toEqual(["multi"]);
    expect(idsAt(index, [12, 12])).toEqual(["multi"]);
    expect(idsAt(index, [7, 7])).toEqual([]);

    const points = [
      ...probePoints(box(0, 0, 4, 4)),
      ...probePoints(box(10, 10, 14, 14)),
      [2, 2] as LngLat,
      [12, 12] as LngLat,
      [7, 7] as LngLat,
    ];
    expect(firstMismatch(fc, points)).toBeNull();
  });

  it("matches on a polygon whose hole also has enough vertices for the slab path", () => {
    const outer = box(-20, -20, 20, 20);
    const hole = star(0, 0, 8, 12); // 24 vertices
    const fc = collection(feature("ring", { type: "Polygon", coordinates: [outer, hole] }));
    const index = new PolygonIndex(fc);

    expect(idsAt(index, [0, 0])).toEqual([]); // inside the 24-vertex hole
    expect(idsAt(index, [18, 0])).toEqual(["ring"]);
    expect(firstMismatch(fc, [...probePoints(outer), ...probePoints(hole)])).toBeNull();
  });

  it("ignores degenerate polygons and an empty collection", () => {
    const empty = new PolygonIndex(collection());
    expect(empty.size).toBe(0);
    expect(empty.at([0, 0])).toEqual([]);

    const tiny = collection(feature("tiny", { type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] }));
    expect(new PolygonIndex(tiny).size).toBe(0);
    expect(new PolygonIndex(tiny).at([0.5, 0])).toEqual([]);
  });

  it("agrees with the reference on randomized polygons and holes", () => {
    let seed = 123456789;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };

    const features: Feature[] = [];
    const points: LngLat[] = [];
    for (let i = 0; i < 16; i += 1) {
      const cx = (rnd() - 0.5) * 0.02;
      const cy = (rnd() - 0.5) * 0.02;
      const radius = 0.001 + rnd() * 0.008;
      const outer = star(cx, cy, radius, 4 + Math.floor(rnd() * 24), 0.55, rnd() * Math.PI);
      const rings: LngLat[][] = [outer];
      if (rnd() < 0.5) rings.push(star(cx, cy, radius * 0.2, 4 + Math.floor(rnd() * 8), 0.6, rnd() * Math.PI));
      features.push(feature(`z${i}`, { type: "Polygon", coordinates: rings }));

      for (let j = 0; j < 50; j += 1) {
        points.push([cx - radius + rnd() * radius * 2, cy - radius + rnd() * radius * 2]);
      }
      points.push(...probePoints(outer));
      if (rings[1]) points.push(...probePoints(rings[1]));
    }

    const fc = collection(...features);
    expect(firstMismatch(fc, points)).toBeNull();
  });
});
