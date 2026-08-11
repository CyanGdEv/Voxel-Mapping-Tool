import { UserError } from "./errors.mjs";

const EARTH_RADIUS_M = 6_378_137;
const DEG = Math.PI / 180;

export function parseBbox(value) {
  const parts = String(value).split(",").map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    throw new UserError("Bounding box must be south,west,north,east");
  }
  const [south, west, north, east] = parts;
  if (!(south < north && west < east) || south < -90 || north > 90 || west < -180 || east > 180) {
    throw new UserError("Bounding box coordinates are invalid");
  }
  return { south, west, north, east };
}

export function bboxCenter(bbox) {
  return { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 };
}

export function bboxAreaKm2(bbox) {
  const center = bboxCenter(bbox);
  const width = Math.abs((bbox.east - bbox.west) * DEG * EARTH_RADIUS_M * Math.cos(center.lat * DEG));
  const height = Math.abs((bbox.north - bbox.south) * DEG * EARTH_RADIUS_M);
  return (width * height) / 1_000_000;
}

export function createProjector(center) {
  const cos = Math.cos(center.lat * DEG);
  return {
    center,
    forward([lon, lat]) {
      return [
        (lon - center.lon) * DEG * EARTH_RADIUS_M * cos,
        -(lat - center.lat) * DEG * EARTH_RADIUS_M
      ];
    },
    inverse([x, z]) {
      return [
        center.lon + x / (DEG * EARTH_RADIUS_M * cos),
        center.lat - z / (DEG * EARTH_RADIUS_M)
      ];
    }
  };
}

export function geometryMapCoordinates(geometry, mapper) {
  if (!geometry) return null;
  const map = (coordinates, depth) => depth === 1
    ? mapper(coordinates)
    : coordinates.map((item) => map(item, depth - 1));
  const depth = ({ Point: 1, LineString: 2, Polygon: 3, MultiLineString: 3, MultiPolygon: 4 })[geometry.type];
  if (!depth) throw new UserError(`Unsupported geometry type: ${geometry.type}`);
  return { type: geometry.type, coordinates: map(geometry.coordinates, depth) };
}

export function geometryBounds(geometry) {
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  walkPositions(geometry, ([x, z]) => {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minZ = Math.min(bounds.minZ, z);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxZ = Math.max(bounds.maxZ, z);
  });
  return bounds;
}

export function walkPositions(geometry, callback) {
  const visit = (value) => {
    if (Array.isArray(value) && value.length >= 2 && value.every((v) => typeof v === "number")) callback(value);
    else if (Array.isArray(value)) for (const item of value) visit(item);
  };
  if (geometry) visit(geometry.coordinates);
}

export function polygonArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(area / 2);
}

export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    const crosses = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / ((zj - zi) || Number.EPSILON) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x, z, rings) {
  if (!rings?.length || !pointInRing(x, z, rings[0])) return false;
  return !rings.slice(1).some((ring) => pointInRing(x, z, ring));
}

export function scanlineSpans(ring, minZ = undefined, maxZ = undefined) {
  if (!ring || ring.length < 3) return [];
  const bounds = ring.reduce((acc, [x, z]) => ({
    minX: Math.min(acc.minX, x), minZ: Math.min(acc.minZ, z),
    maxX: Math.max(acc.maxX, x), maxZ: Math.max(acc.maxZ, z)
  }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity });
  const z0 = Math.floor(minZ ?? bounds.minZ);
  const z1 = Math.ceil(maxZ ?? bounds.maxZ);
  const spans = [];
  for (let z = z0; z <= z1; z += 1) {
    const sampleZ = z + 0.5;
    const intersections = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if ((zi > sampleZ) === (zj > sampleZ)) continue;
      intersections.push(xi + ((sampleZ - zi) * (xj - xi)) / (zj - zi));
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const start = Math.ceil(intersections[i] - 0.5);
      const end = Math.floor(intersections[i + 1] - 0.5);
      if (start <= end) spans.push([start, end, z]);
    }
  }
  return spans;
}

/**
 * Rasterizes one GeoJSON Polygon coordinate array using the even/odd fill rule.
 * Intersections from every ring are evaluated together, so interior rings remain
 * empty instead of being silently filled as part of the exterior.
 */
export function polygonScanlineSpans(rings, minZ = undefined, maxZ = undefined) {
  const validRings = (rings || []).filter((ring) => ring?.length >= 3);
  if (!validRings.length) return [];
  const bounds = validRings.flat().reduce((acc, [x, z]) => ({
    minZ: Math.min(acc.minZ, z), maxZ: Math.max(acc.maxZ, z)
  }), { minZ: Infinity, maxZ: -Infinity });
  const z0 = Math.floor(minZ ?? bounds.minZ);
  const z1 = Math.ceil(maxZ ?? bounds.maxZ);
  const spans = [];
  for (let z = z0; z <= z1; z += 1) {
    const sampleZ = z + 0.5;
    const intersections = [];
    for (const ring of validRings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [xi, zi] = ring[i];
        const [xj, zj] = ring[j];
        if ((zi > sampleZ) === (zj > sampleZ)) continue;
        intersections.push(xi + ((sampleZ - zi) * (xj - xi)) / (zj - zi));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const start = Math.ceil(intersections[i] - 0.5);
      const end = Math.floor(intersections[i + 1] - 0.5);
      if (start <= end) spans.push([start, end, z]);
    }
  }
  return spans;
}

export function lineCells(points, width = 1) {
  const cells = new Set();
  const halfWidth = Math.max(0.5, Number(width) / 2);
  const radius = Math.max(0, Math.ceil(halfWidth));
  for (let p = 1; p < points.length; p += 1) {
    let [x0, z0] = points[p - 1].map(Math.round);
    const [x1, z1] = points[p].map(Math.round);
    let vx = x1 - x0, vz = z1 - z0;
    // Canonical orientation keeps the selected side of an even-width band
    // stable when an OSM way is digitized in the opposite direction.
    if (vx < 0 || (vx === 0 && vz < 0)) { vx *= -1; vz *= -1; }
    const segmentLength = Math.hypot(vx, vz) || 1;
    const normalX = -vz / segmentLength, normalZ = vx / segmentLength;
    const stamp = (x, z) => {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        for (let offsetZ = -radius; offsetZ <= radius; offsetZ += 1) {
          const distance = Math.hypot(offsetX, offsetZ);
          if (distance < halfWidth - 1e-9) {
            cells.add(`${x + offsetX},${z + offsetZ}`);
            continue;
          }
          if (Math.abs(distance - halfWidth) > 1e-9) continue;
          const normalOffset = offsetX * normalX + offsetZ * normalZ;
          // Tangential boundary cells form rounded end caps. Perpendicular
          // ties select one canonical side, giving true 2/4/6-block bands.
          if (Math.abs(normalOffset) < 0.5 || normalOffset < 0) {
            cells.add(`${x + offsetX},${z + offsetZ}`);
          }
        }
      }
    };
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dz = -Math.abs(z1 - z0), sz = z0 < z1 ? 1 : -1;
    let error = dx + dz;
    while (true) {
      stamp(x0, z0);
      if (x0 === x1 && z0 === z1) break;
      const e2 = 2 * error;
      if (e2 >= dz) { error += dz; x0 += sx; }
      if (e2 <= dx) { error += dx; z0 += sz; }
    }
  }
  return [...cells].map((value) => value.split(",").map(Number));
}

export function bboxPolygon(bbox) {
  return {
    type: "Polygon",
    coordinates: [[
      [bbox.west, bbox.south], [bbox.east, bbox.south], [bbox.east, bbox.north],
      [bbox.west, bbox.north], [bbox.west, bbox.south]
    ]]
  };
}
