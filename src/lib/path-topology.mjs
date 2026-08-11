import { geometryBounds, geometryMapCoordinates, lineCells, pointInPolygon, polygonScanlineSpans } from "./geo.mjs";
import { UserError } from "./errors.mjs";

const DEFAULT_GRID_M = 1;
const DEFAULT_COLOUR_DELTA_E = 20;
const DEFAULT_PIXEL_CONFIDENCE = 0.58;
const DEFAULT_COMPONENT_CONFIDENCE = 0.74;
const DEFAULT_MIN_AREA_M2 = 12;
const DEFAULT_MIN_NOVEL_AREA_M2 = 8;
const DEFAULT_MIN_EDGE_M = 5;
const DEFAULT_EXISTING_BUFFER_M = 2.5;

/**
 * Recovers image-visible walkable areas connected to mapped routes. The
 * orthophoto supplies appearance and boundaries; mapped routes remain the
 * semantic/topological anchors. QA mode never mutates map.features.
 */
export function recoverPathTopology(map, sources, options = {}) {
  const imagery = sources.orthophoto;
  const mode = options.pathDiscoveryMode || "off";
  if (mode === "off" || imagery?.status !== "available" || typeof imagery.sampleRgbLocal !== "function") {
    const summary = emptySummary(mode, imagery?.status || "not-supplied");
    map.pathTopology = summary;
    return { summary, qaGeojson: emptyQa(map, summary) };
  }

  const prototypes = appearancePrototypes(map);
  if (!prototypes.length) {
    const summary = emptySummary(mode, "no-accepted-path-appearance-prototypes");
    summary.limitations = [
      "No confidence-gated mapped path colour was available to seed walkable-surface classification."
    ];
    map.pathTopology = summary;
    return { summary, qaGeojson: emptyQa(map, summary) };
  }

  const grid = buildAnalysisGrid(map, imagery, options);
  rasterizeBoundary(grid, map.boundary.localGeometry);
  rasterizeExclusions(grid, map.features);
  rasterizeExistingPaths(grid, map.features);
  classifyWalkablePixels(grid, imagery, prototypes, options);
  refineCandidateMask(grid);

  const compilationPermitted = mode === "evidence" && imagery.mode === "evidence" && imagery.provenanceComplete;
  const components = extractComponents(grid, prototypes, sources, map, options, compilationPermitted);
  const graphEdges = components.flatMap((component) => component.graphEdges);
  const acceptedEdges = graphEdges.filter((edge) => edge.status === "accepted");
  const compiledComponents = components.filter((component) => component.compilationEligible);
  const recoveredFeatures = compiledComponents.map((component, index) =>
    componentFeature(component, index, map.projector, imagery)
  );
  if (recoveredFeatures.length) map.features.push(...recoveredFeatures);

  const candidatePixels = grid.candidate.reduce((sum, value) => sum + value, 0);
  const summary = {
    schemaVersion: 1,
    status: components.length ? "available" : "no-connected-walkable-components",
    mode,
    compilationPermitted,
    method: {
      segmentation: "mapped-path colour prototypes + CIELAB distance + local texture + vegetation rejection",
      topology: "connected-component polygonization + Zhang-Suen medial skeleton graph",
      fusion: "mapped route anchors retained; only novel image-visible area may be appended",
      terrain: "DTM grade assessment; steep or bridge-required candidates remain review-only"
    },
    grid: {
      cellSizeM: grid.cellSizeM,
      columns: grid.columns,
      rows: grid.rows,
      cells: grid.length,
      insideParkCells: grid.inside.reduce((sum, value) => sum + value, 0),
      candidatePixels,
      candidateAreaM2: round1(candidatePixels * grid.cellSizeM ** 2)
    },
    appearancePrototypes: prototypes.map((prototype) => ({
      featureId: prototype.featureId,
      colour: rgbHex(prototype.rgb),
      material: prototype.material,
      pattern: prototype.pattern,
      confidence: prototype.confidence
    })),
    connectedComponents: components.length,
    acceptedComponents: components.filter((component) => component.status === "accepted").length,
    compiledComponents: compiledComponents.length,
    recoveredAreaM2: round1(compiledComponents.reduce((sum, component) => sum + component.novelAreaM2, 0)),
    candidateGraphEdges: graphEdges.length,
    acceptedGraphEdges: acceptedEdges.length,
    recoveredLengthM: round1(acceptedEdges.reduce((sum, edge) => sum + edge.lengthM, 0)),
    connectorEdges: acceptedEdges.filter((edge) => edge.classification === "connector").length,
    extensionEdges: acceptedEdges.filter((edge) => edge.classification === "extension").length,
    junctionNodes: components.reduce((sum, component) => sum + component.junctionNodes, 0),
    terrain: summarizeTerrain(graphEdges),
    rejectionReasons: countBy(graphEdges.filter((edge) => edge.status !== "accepted"), (edge) => edge.rejectionReason),
    components: components.map(publicComponent),
    graphEdges: graphEdges.map(publicEdge),
    source: {
      provider: imagery.source?.provider || null,
      sourceUrl: imagery.source?.sourceUrl || null,
      license: imagery.source?.license || null,
      capturedAt: imagery.source?.capturedAt || null,
      rasterHashes: imagery.rasters.map((raster) => raster.sha256),
      gsdM: imagery.minimumGsdM
    },
    limitations: [
      "Classification expands only through image-visible hardscape connected to a mapped, appearance-evidenced route; isolated paths remain candidates for a later independent detector.",
      "Roofs, service yards, shadows, temporary surfacing, vehicles, and visually similar hardscape can still require human review.",
      "Aerial imagery cannot by itself prove access rights, route purpose, stairs, ramps, bridge structure, or current operational status.",
      "Mapped buildings, water, and vegetation polygons are exclusion masks; conflicting candidates never silently overwrite those sources."
    ]
  };
  map.pathTopology = summary;
  return { summary, qaGeojson: buildQa(map, components, imagery, summary) };
}

function buildAnalysisGrid(map, imagery, options) {
  const bounds = geometryBounds(map.boundary.localGeometry);
  const cellSizeM = Math.max(0.5, Number(options.pathDiscoveryGridM || DEFAULT_GRID_M));
  const minX = Math.floor(bounds.minX / cellSizeM) * cellSizeM;
  const minZ = Math.floor(bounds.minZ / cellSizeM) * cellSizeM;
  const columns = Math.ceil((bounds.maxX - minX) / cellSizeM);
  const rows = Math.ceil((bounds.maxZ - minZ) / cellSizeM);
  const length = columns * rows;
  const maxCells = options.maxPathDiscoveryCells || 3_000_000;
  if (length > maxCells) {
    throw new UserError(
      `Path discovery needs ${length.toLocaleString()} analysis cells; limit is ${maxCells.toLocaleString()}`,
      "Increase --path-discovery-grid-m, tighten the park boundary, or deliberately raise --max-path-discovery-cells."
    );
  }
  return {
    minX, minZ, cellSizeM, columns, rows, length,
    gsdM: imagery.minimumGsdM || cellSizeM,
    inside: new Uint8Array(length),
    blocked: new Uint8Array(length),
    existing: new Uint8Array(length),
    seed: new Uint8Array(length),
    eligible: new Uint8Array(length),
    candidate: new Uint8Array(length),
    confidence: new Uint8Array(length),
    prototype: new Int16Array(length).fill(-1),
    rgb: new Map()
  };
}

function rasterizeBoundary(grid, geometry) {
  for (const polygon of polygonParts(geometry)) paintPolygon(grid, polygon, grid.inside, 1);
}

function rasterizeExclusions(grid, features) {
  const excludedKinds = new Set(["building", "water", "vegetation"]);
  for (const feature of features) {
    if (!excludedKinds.has(feature.kind)) continue;
    for (const polygon of polygonParts(feature.localGeometry)) paintPolygon(grid, polygon, grid.blocked, 1);
  }
}

function rasterizeExistingPaths(grid, features) {
  for (const feature of features) {
    if (!["path", "road"].includes(feature.kind)) continue;
    for (const polygon of polygonParts(feature.localGeometry)) {
      paintPolygon(grid, polygon, grid.existing, 1);
      paintPolygon(grid, polygon, grid.seed, feature.orthophoto?.path?.status === "accepted" ? 1 : 0);
    }
    for (const line of lineParts(feature.localGeometry)) {
      const observed = feature.orthophoto?.path?.status === "accepted" ? feature.orthophoto.path : null;
      const widthM = observed?.widthM || parseLength(feature.tags?.width) || parseLength(feature.tags?.est_width) || 2;
      paintLine(grid, line, grid.existing, Math.max(1, widthM));
      if (observed) paintLine(grid, line, grid.seed, Math.max(1, widthM));
      if (observed?.corridorLocal) {
        for (const polygon of polygonParts(observed.corridorLocal)) {
          paintPolygon(grid, polygon, grid.existing, 1);
          paintPolygon(grid, polygon, grid.seed, 1);
        }
      }
    }
  }
}

function appearancePrototypes(map) {
  const prototypes = [];
  for (const feature of map.features) {
    const observation = feature.orthophoto?.path;
    if (observation?.status !== "accepted" || !Array.isArray(observation.colourRgb)) continue;
    prototypes.push({
      featureId: feature.id,
      rgb: observation.colourRgb.map(Number),
      lab: rgbToLab(observation.colourRgb),
      material: observation.material || normalizePathMaterial(
        feature.tags?.surface || feature.tags?.material || feature.tags?.["surface:material"]
      ),
      pattern: observation.pattern || feature.tags?.["surface:pattern"] ||
        feature.tags?.["paving_stones:pattern"] || null,
      confidence: observation.confidence || 0
    });
  }
  return prototypes;
}

function classifyWalkablePixels(grid, imagery, prototypes, options) {
  const threshold = Math.max(4, options.pathDiscoveryColourDeltaE || DEFAULT_COLOUR_DELTA_E);
  const minimumConfidence = options.pathDiscoveryPixelConfidence ?? DEFAULT_PIXEL_CONFIDENCE;
  const patchOffset = Math.max(grid.gsdM, grid.cellSizeM * 0.45);
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      const index = row * grid.columns + column;
      if (!grid.inside[index] || grid.blocked[index]) continue;
      const [x, z] = cellCenter(grid, column, row);
      const rgb = imagery.sampleRgbLocal(x, z);
      if (!rgb || looksVegetated(rgb)) continue;
      grid.eligible[index] = 1;
      const lab = rgbToLab(rgb);
      let nearest = null;
      for (let prototypeIndex = 0; prototypeIndex < prototypes.length; prototypeIndex += 1) {
        const distance = deltaLab(lab, prototypes[prototypeIndex].lab);
        if (!nearest || distance < nearest.distance) nearest = { prototypeIndex, distance };
      }
      const neighbours = [
        imagery.sampleRgbLocal(x - patchOffset, z), imagery.sampleRgbLocal(x + patchOffset, z),
        imagery.sampleRgbLocal(x, z - patchOffset), imagery.sampleRgbLocal(x, z + patchOffset)
      ].filter(Boolean).filter((sample) => !looksVegetated(sample));
      const texture = neighbours.length
        ? mean(neighbours.map((sample) => deltaLab(lab, rgbToLab(sample))))
        : 30;
      const colourScore = clamp(1 - nearest.distance / threshold, 0, 1);
      const textureScore = clamp(1 - texture / 28, 0, 1);
      const sourceScore = clamp(prototypes[nearest.prototypeIndex].confidence, 0, 1);
      const confidence = 0.12 + 0.62 * colourScore + 0.16 * textureScore + 0.1 * sourceScore;
      if (nearest.distance <= threshold && confidence >= minimumConfidence) {
        grid.candidate[index] = 1;
        grid.confidence[index] = Math.round(clamp(confidence, 0, 1) * 255);
        grid.prototype[index] = nearest.prototypeIndex;
        if (grid.rgb.size < 100_000) grid.rgb.set(index, rgb.map(Math.round));
      }
    }
  }
}

function refineCandidateMask(grid) {
  const source = grid.candidate;
  const output = source.slice();
  for (let row = 1; row + 1 < grid.rows; row += 1) {
    for (let column = 1; column + 1 < grid.columns; column += 1) {
      const index = row * grid.columns + column;
      if (!grid.inside[index] || grid.blocked[index] || !grid.eligible[index]) continue;
      let neighbours = 0, confidence = 0, prototypes = [];
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dz) continue;
          const other = (row + dz) * grid.columns + column + dx;
          if (!source[other]) continue;
          neighbours += 1;
          confidence += grid.confidence[other];
          if (grid.prototype[other] >= 0) prototypes.push(grid.prototype[other]);
        }
      }
      if (!source[index] && neighbours >= 6) {
        output[index] = 1;
        grid.confidence[index] = Math.round(confidence / neighbours);
        grid.prototype[index] = mode(prototypes) ?? -1;
      } else if (source[index] && neighbours <= 1 && !grid.seed[index]) output[index] = 0;
    }
  }
  grid.candidate = output;
}

function extractComponents(grid, prototypes, sources, map, options, compilationPermitted) {
  const visited = new Uint8Array(grid.length);
  const components = [];
  const minAreaM2 = options.pathDiscoveryMinAreaM2 || DEFAULT_MIN_AREA_M2;
  const minNovelAreaM2 = options.pathDiscoveryMinNovelAreaM2 || DEFAULT_MIN_NOVEL_AREA_M2;
  for (let start = 0; start < grid.length; start += 1) {
    if (!grid.candidate[start] || visited[start]) continue;
    const queue = [start], cells = [];
    visited[start] = 1;
    let cursor = 0, seedPixels = 0, confidenceSum = 0;
    let minColumn = Infinity, minRow = Infinity, maxColumn = -Infinity, maxRow = -Infinity;
    while (cursor < queue.length) {
      const index = queue[cursor++];
      cells.push(index);
      const column = index % grid.columns, row = Math.floor(index / grid.columns);
      minColumn = Math.min(minColumn, column); maxColumn = Math.max(maxColumn, column);
      minRow = Math.min(minRow, row); maxRow = Math.max(maxRow, row);
      seedPixels += grid.seed[index] ? 1 : 0;
      confidenceSum += grid.confidence[index] / 255;
      for (const [dx, dz] of CARDINAL) {
        const nextColumn = column + dx, nextRow = row + dz;
        if (nextColumn < 0 || nextRow < 0 || nextColumn >= grid.columns || nextRow >= grid.rows) continue;
        const next = nextRow * grid.columns + nextColumn;
        if (!grid.candidate[next] || visited[next]) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
    const existingBufferM = options.pathDiscoveryExistingBufferM ?? DEFAULT_EXISTING_BUFFER_M;
    const rawNovelCells = cells.filter((index) => {
      const column = index % grid.columns, row = Math.floor(index / grid.columns);
      return !nearMask(grid.existing, grid, column, row, existingBufferM);
    });
    const novelCells = connectedCellGroups(rawNovelCells, grid)
      .filter((group) => group.length * grid.cellSizeM ** 2 >= minNovelAreaM2)
      .flat();
    const novelPixels = novelCells.length;
    const areaM2 = cells.length * grid.cellSizeM ** 2;
    const novelAreaM2 = novelPixels * grid.cellSizeM ** 2;
    if (areaM2 < minAreaM2 || !seedPixels || novelAreaM2 < minNovelAreaM2) continue;
    const polygonLocal = polygonizeComponent(cells, grid);
    const novelPolygonLocal = polygonizeCellGroups(novelCells, grid);
    if (!polygonLocal?.coordinates?.[0]?.length || !novelPolygonLocal) continue;
    const appearance = componentAppearance(cells, grid, prototypes);
    const component = {
      id: `walkable-${components.length + 1}`,
      cells,
      cellSet: new Set(cells),
      bounds: { minColumn, minRow, maxColumn, maxRow },
      polygonLocal,
      novelPolygonLocal,
      areaM2: round1(areaM2),
      novelAreaM2: round1(novelAreaM2),
      seedPixels,
      confidence: round3(confidenceSum / cells.length),
      appearance,
      graphEdges: [],
      junctionNodes: 0,
      status: "candidate",
      compilationEligible: false
    };
    const graph = skeletonGraph(component, grid, sources, map, options, compilationPermitted);
    component.graphEdges = graph.edges;
    component.junctionNodes = graph.junctionNodes;
    const novelEdges = graph.edges.filter((edge) => edge.novelFraction >= 0.35);
    const acceptedEdges = novelEdges.filter((edge) => edge.status === "accepted");
    const componentConfidence = options.pathDiscoveryMinConfidence ?? DEFAULT_COMPONENT_CONFIDENCE;
    const terrainBlocked = novelEdges.some((edge) => ["bridge-review", "steep-review"].includes(edge.terrain.status));
    component.status = acceptedEdges.length && component.confidence >= componentConfidence ? "accepted" : "review";
    component.compilationEligible = Boolean(compilationPermitted && component.status === "accepted" && !terrainBlocked);
    components.push(component);
  }
  return components;
}

function polygonizeCellGroups(cells, grid) {
  const polygons = [];
  for (const group of connectedCellGroups(cells, grid)) {
    const polygon = polygonizeComponent(group, grid);
    if (polygon) polygons.push(polygon.coordinates);
  }
  if (!polygons.length) return null;
  return polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
}

function connectedCellGroups(cells, grid) {
  const remaining = new Set(cells), groups = [];
  while (remaining.size) {
    const start = remaining.values().next().value;
    const queue = [start], group = [];
    remaining.delete(start);
    let cursor = 0;
    while (cursor < queue.length) {
      const index = queue[cursor++];
      group.push(index);
      const column = index % grid.columns, row = Math.floor(index / grid.columns);
      for (const [dx, dz] of CARDINAL) {
        const x = column + dx, z = row + dz;
        if (x < 0 || z < 0 || x >= grid.columns || z >= grid.rows) continue;
        const next = z * grid.columns + x;
        if (!remaining.has(next)) continue;
        remaining.delete(next);
        queue.push(next);
      }
    }
    groups.push(group);
  }
  return groups;
}

function polygonizeComponent(cells, grid) {
  const set = new Set(cells);
  const edges = [];
  const starts = new Map();
  const add = (from, to) => {
    const edge = { from, to, used: false, index: edges.length };
    edges.push(edge);
    const key = pointKey(from);
    if (!starts.has(key)) starts.set(key, []);
    starts.get(key).push(edge);
  };
  for (const index of cells) {
    const column = index % grid.columns, row = Math.floor(index / grid.columns);
    if (row === 0 || !set.has(index - grid.columns)) add([column, row], [column + 1, row]);
    if (column + 1 >= grid.columns || !set.has(index + 1)) add([column + 1, row], [column + 1, row + 1]);
    if (row + 1 >= grid.rows || !set.has(index + grid.columns)) add([column + 1, row + 1], [column, row + 1]);
    if (column === 0 || !set.has(index - 1)) add([column, row + 1], [column, row]);
  }
  const rings = [];
  for (const first of edges) {
    if (first.used) continue;
    first.used = true;
    const ring = [first.from, first.to];
    let current = first.to, safety = 0;
    while (pointKey(current) !== pointKey(first.from) && safety++ <= edges.length + 2) {
      const next = (starts.get(pointKey(current)) || []).find((edge) => !edge.used);
      if (!next) break;
      next.used = true;
      ring.push(next.to);
      current = next.to;
    }
    if (pointKey(ring[0]) !== pointKey(ring.at(-1)) || ring.length < 5) continue;
    const simplified = removeCollinear(ring).map(([column, row]) => [
      grid.minX + column * grid.cellSizeM,
      grid.minZ + row * grid.cellSizeM
    ]);
    if (simplified.length >= 5) rings.push(simplified);
  }
  if (!rings.length) return null;
  rings.sort((first, second) => Math.abs(signedArea(second)) - Math.abs(signedArea(first)));
  return { type: "Polygon", coordinates: rings };
}

function skeletonGraph(component, grid, sources, map, options, compilationPermitted) {
  const padding = 1;
  const cropWidth = component.bounds.maxColumn - component.bounds.minColumn + 1 + padding * 2;
  const cropHeight = component.bounds.maxRow - component.bounds.minRow + 1 + padding * 2;
  const binary = new Uint8Array(cropWidth * cropHeight);
  for (const index of component.cells) {
    const column = index % grid.columns, row = Math.floor(index / grid.columns);
    const cropColumn = column - component.bounds.minColumn + padding;
    const cropRow = row - component.bounds.minRow + padding;
    binary[cropRow * cropWidth + cropColumn] = 1;
  }
  thin(binary, cropWidth, cropHeight);
  const skeleton = [];
  for (let index = 0; index < binary.length; index += 1) if (binary[index]) skeleton.push(index);
  if (!skeleton.length) return { edges: [], junctionNodes: 0 };
  const degree = new Map(skeleton.map((index) => [index, skeletonNeighbours(index, binary, cropWidth, cropHeight).length]));
  const nodes = new Set(skeleton.filter((index) => degree.get(index) !== 2));
  if (!nodes.size) nodes.add(skeleton[0]);
  const junctionNodes = [...nodes].filter((index) => degree.get(index) >= 3).length;
  const visited = new Set(), edges = [];
  for (const node of nodes) {
    for (const neighbour of skeletonNeighbours(node, binary, cropWidth, cropHeight)) {
      if (visited.has(edgeKey(node, neighbour))) continue;
      const pixels = [node];
      let previous = node, current = neighbour, safety = 0;
      visited.add(edgeKey(node, neighbour));
      while (safety++ < binary.length) {
        pixels.push(current);
        if (nodes.has(current) && current !== node) break;
        const next = skeletonNeighbours(current, binary, cropWidth, cropHeight).find((value) => value !== previous);
        if (next === undefined || visited.has(edgeKey(current, next))) break;
        visited.add(edgeKey(current, next));
        previous = current;
        current = next;
      }
      const localPoints = simplifyLine(pixels.map((pixel) => {
        const cropColumn = pixel % cropWidth, cropRow = Math.floor(pixel / cropWidth);
        const column = cropColumn + component.bounds.minColumn - padding;
        const row = cropRow + component.bounds.minRow - padding;
        return [
          grid.minX + (column + 0.5) * grid.cellSizeM,
          grid.minZ + (row + 0.5) * grid.cellSizeM
        ];
      }), grid.cellSizeM * 0.7);
      const lengthM = lineLength(localPoints);
      if (lengthM < (options.pathDiscoveryMinEdgeM || DEFAULT_MIN_EDGE_M)) continue;
      const gridPoints = localPoints.map(([x, z]) => localToCell(grid, x, z));
      const existingBufferM = options.pathDiscoveryExistingBufferM ?? DEFAULT_EXISTING_BUFFER_M;
      const novelFraction = ratio(gridPoints.filter(({ index, column, row }) =>
        index >= 0 && !nearMask(grid.existing, grid, column, row, existingBufferM)).length, gridPoints.length);
      if (novelFraction < 0.2) continue;
      const startAnchored = nearMask(grid.existing, grid, gridPoints[0].column, gridPoints[0].row,
        existingBufferM);
      const endAnchored = nearMask(grid.existing, grid, gridPoints.at(-1).column, gridPoints.at(-1).row,
        existingBufferM);
      const classification = startAnchored && endAnchored ? "connector" : startAnchored || endAnchored ? "extension" : "image-visible-branch";
      const terrain = terrainEvidence(localPoints, sources.elevation, map, options);
      const confidence = round3(clamp(
        component.confidence * 0.72 + novelFraction * 0.16 + (startAnchored || endAnchored ? 0.12 : 0.04), 0, 0.99
      ));
      const minimumConfidence = options.pathDiscoveryMinConfidence ?? DEFAULT_COMPONENT_CONFIDENCE;
      const rejectionReason = novelFraction < 0.35 ? "mostly-overlaps-mapped-route"
        : confidence < minimumConfidence ? "confidence-below-threshold"
          : terrain.status === "bridge-review" ? "bridge-structure-unverified"
            : terrain.status === "steep-review" ? "stairs-or-earthworks-unverified"
              : !compilationPermitted ? "qa-only-mode-or-incomplete-provenance" : null;
      edges.push({
        id: `${component.id}-edge-${edges.length + 1}`,
        componentId: component.id,
        localPoints,
        lengthM: round1(lengthM),
        novelFraction: round3(novelFraction),
        classification,
        startAnchored,
        endAnchored,
        confidence,
        terrain,
        status: rejectionReason ? "review" : "accepted",
        rejectionReason
      });
    }
  }
  return { edges, junctionNodes };
}

function terrainEvidence(points, elevation, map, options) {
  const waterFeatures = map.features.filter((feature) => feature.kind === "water");
  const bridgeRequired = points.some(([x, z]) => waterFeatures.some((feature) =>
    polygonParts(feature.localGeometry).some((polygon) => pointInPolygon(x, z, polygon))
  ));
  if (bridgeRequired) return {
    status: "bridge-review", sampleCount: 0, maxGradePercent: null, p90GradePercent: null,
    treatment: "separate elevated deck evidence required"
  };
  if (typeof elevation?.sampleLocal !== "function") return {
    status: "terrain-unavailable", sampleCount: 0, maxGradePercent: null, p90GradePercent: null,
    treatment: "no terrain conformance claim"
  };
  const samples = densifyLine(points, Math.max(1, options.pathDiscoveryTerrainSampleM || 2))
    .map(([x, z]) => ({ x, z, elevationM: elevation.sampleLocal(x, z) }))
    .filter((sample) => Number.isFinite(sample.elevationM));
  const grades = [];
  for (let index = 1; index < samples.length; index += 1) {
    const distance = Math.hypot(samples[index].x - samples[index - 1].x, samples[index].z - samples[index - 1].z);
    if (distance > 0) grades.push(Math.abs(samples[index].elevationM - samples[index - 1].elevationM) / distance * 100);
  }
  grades.sort((a, b) => a - b);
  const maxGrade = grades.length ? grades.at(-1) : 0;
  const p90 = grades.length ? percentile(grades, 0.9) : 0;
  const steepThreshold = options.pathDiscoverySteepGradePercent || 16;
  const rampThreshold = options.pathDiscoveryRampGradePercent || 8.3;
  const status = p90 > steepThreshold ? "steep-review" : p90 > rampThreshold ? "ramp-candidate" : "grade-conforming";
  return {
    status,
    sampleCount: samples.length,
    minElevationM: samples.length ? round2(Math.min(...samples.map((sample) => sample.elevationM))) : null,
    maxElevationM: samples.length ? round2(Math.max(...samples.map((sample) => sample.elevationM))) : null,
    maxGradePercent: round1(maxGrade),
    p90GradePercent: round1(p90),
    treatment: status === "steep-review" ? "explicit stairs or surveyed earthworks required"
      : status === "ramp-candidate" ? "terrain-following ramp candidate"
        : "terrain-following surface"
  };
}

function componentFeature(component, index, projector, imagery) {
  const geometry = geometryMapCoordinates(component.novelPolygonLocal, projector.inverse);
  const tags = {
    highway: "pedestrian",
    area: "yes",
    foot: "yes",
    "orthophoto:discovered": "yes",
    "source:geometry": "orthophoto-walkable-segmentation",
    surface: component.appearance.material || undefined,
    "surface:colour": component.appearance.colour,
    "surface:pattern": component.appearance.pattern || undefined
  };
  return {
    id: `orthophoto:path-area:${index + 1}`,
    name: null,
    kind: "path",
    subtype: "orthophoto_walkable_area",
    tags,
    geometry,
    localGeometry: component.novelPolygonLocal,
    vertical: { heightM: null, heightSource: null, minHeightM: 0, elevationM: null, explicit: false },
    source: {
      provider: imagery.source?.provider || null,
      sourceUrl: imagery.source?.sourceUrl || null,
      timestamp: imagery.source?.capturedAt || null,
      license: imagery.source?.license || null,
      rasterHashes: imagery.rasters.map((raster) => raster.sha256),
      resolutionM: imagery.minimumGsdM,
      method: "connected walkable-surface segmentation"
    },
    verification: { plan: "orthophoto-derived", vertical: "terrain-source" },
    pathTopology: {
      componentId: component.id,
      confidence: component.confidence,
      novelAreaM2: component.novelAreaM2,
      graphEdgeIds: component.graphEdges.filter((edge) => edge.status === "accepted").map((edge) => edge.id),
      compilationEligible: true,
      terrainMode: "source-following"
    }
  };
}

function componentAppearance(cells, grid, prototypes) {
  const prototypeCounts = new Map(), rgbs = [];
  for (const index of cells) {
    const prototype = grid.prototype[index];
    if (prototype >= 0) prototypeCounts.set(prototype, (prototypeCounts.get(prototype) || 0) + 1);
    const rgb = grid.rgb.get(index);
    if (rgb && rgbs.length < 4096) rgbs.push(rgb);
  }
  const dominantIndex = [...prototypeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const dominant = prototypes[dominantIndex];
  const rgb = rgbs.length ? robustRgb(rgbs).map(Math.round) : dominant.rgb;
  return {
    colour: rgbHex(rgb),
    rgb,
    material: dominant.material,
    pattern: dominant.pattern,
    prototypeFeatureId: dominant.featureId
  };
}

function buildQa(map, components, imagery, summary) {
  const features = [];
  for (const component of components) {
    features.push({
      type: "Feature",
      id: `path-topology:${component.id}`,
      geometry: geometryMapCoordinates(component.polygonLocal, map.projector.inverse),
      properties: {
        kind: "walkable_surface_component",
        component_id: component.id,
        status: component.status,
        compilation_eligible: component.compilationEligible,
        area_m2: component.areaM2,
        novel_area_m2: component.novelAreaM2,
        confidence: component.confidence,
        junction_nodes: component.junctionNodes,
        colour: component.appearance.colour,
        material: component.appearance.material,
        source: imagery.source
      }
    });
    for (const edge of component.graphEdges) {
      features.push({
        type: "Feature",
        id: `path-topology:${edge.id}`,
        geometry: {
          type: "LineString",
          coordinates: edge.localPoints.map((point) => map.projector.inverse(point))
        },
        properties: {
          kind: "recovered_path_graph_edge",
          edge_id: edge.id,
          component_id: component.id,
          status: edge.status,
          rejection_reason: edge.rejectionReason,
          classification: edge.classification,
          length_m: edge.lengthM,
          novel_fraction: edge.novelFraction,
          confidence: edge.confidence,
          terrain: edge.terrain,
          source: imagery.source
        }
      });
    }
  }
  return {
    type: "FeatureCollection",
    name: `${map.geojson?.name || "Theme Park"} path topology QA`,
    properties: { status: summary.status, mode: summary.mode },
    features
  };
}

function emptySummary(mode, status) {
  return {
    schemaVersion: 1,
    status,
    mode,
    compilationPermitted: false,
    connectedComponents: 0,
    acceptedComponents: 0,
    compiledComponents: 0,
    recoveredAreaM2: 0,
    candidateGraphEdges: 0,
    acceptedGraphEdges: 0,
    recoveredLengthM: 0,
    connectorEdges: 0,
    extensionEdges: 0,
    junctionNodes: 0,
    terrain: { analyzedEdges: 0, statuses: {} },
    rejectionReasons: {},
    components: [],
    graphEdges: [],
    limitations: ["Path topology recovery was not active."]
  };
}

function emptyQa(map, summary) {
  return {
    type: "FeatureCollection",
    name: `${map.geojson?.name || "Theme Park"} path topology QA`,
    properties: { status: summary.status, mode: summary.mode },
    features: []
  };
}

function publicComponent(component) {
  return {
    id: component.id,
    status: component.status,
    compilationEligible: component.compilationEligible,
    areaM2: component.areaM2,
    novelAreaM2: component.novelAreaM2,
    seedPixels: component.seedPixels,
    confidence: component.confidence,
    junctionNodes: component.junctionNodes,
    appearance: component.appearance,
    graphEdges: component.graphEdges.length
  };
}

function publicEdge(edge) {
  return {
    id: edge.id,
    componentId: edge.componentId,
    status: edge.status,
    rejectionReason: edge.rejectionReason,
    classification: edge.classification,
    lengthM: edge.lengthM,
    novelFraction: edge.novelFraction,
    startAnchored: edge.startAnchored,
    endAnchored: edge.endAnchored,
    confidence: edge.confidence,
    terrain: edge.terrain
  };
}

function summarizeTerrain(edges) {
  return {
    analyzedEdges: edges.filter((edge) => edge.terrain.sampleCount > 0).length,
    statuses: countBy(edges, (edge) => edge.terrain.status),
    steepReviewEdges: edges.filter((edge) => edge.terrain.status === "steep-review").length,
    bridgeReviewEdges: edges.filter((edge) => edge.terrain.status === "bridge-review").length,
    rampCandidateEdges: edges.filter((edge) => edge.terrain.status === "ramp-candidate").length
  };
}

function paintPolygon(grid, polygon, target, value) {
  if (!value) return;
  const scaled = polygon.map((ring) => ring.map(([x, z]) => [
    (x - grid.minX) / grid.cellSizeM,
    (z - grid.minZ) / grid.cellSizeM
  ]));
  for (const [start, end, row] of polygonScanlineSpans(scaled)) {
    if (row < 0 || row >= grid.rows) continue;
    for (let column = Math.max(0, start); column <= Math.min(grid.columns - 1, end); column += 1) {
      target[row * grid.columns + column] = value;
    }
  }
}

function paintLine(grid, line, target, widthM) {
  const scaled = line.map(([x, z]) => [(x - grid.minX) / grid.cellSizeM, (z - grid.minZ) / grid.cellSizeM]);
  for (const [column, row] of lineCells(scaled, widthM / grid.cellSizeM)) {
    if (column >= 0 && row >= 0 && column < grid.columns && row < grid.rows) target[row * grid.columns + column] = 1;
  }
}

function thin(binary, width, height) {
  let changed = true, iterations = 0;
  while (changed && iterations++ < 256) {
    changed = false;
    for (let pass = 0; pass < 2; pass += 1) {
      const remove = [];
      for (let row = 1; row + 1 < height; row += 1) {
        for (let column = 1; column + 1 < width; column += 1) {
          const index = row * width + column;
          if (!binary[index]) continue;
          const p = neighboursClockwise(index, binary, width);
          const count = p.reduce((sum, value) => sum + value, 0);
          if (count < 2 || count > 6) continue;
          let transitions = 0;
          for (let n = 0; n < 8; n += 1) if (!p[n] && p[(n + 1) % 8]) transitions += 1;
          if (transitions !== 1) continue;
          if (pass === 0 && (p[0] * p[2] * p[4] || p[2] * p[4] * p[6])) continue;
          if (pass === 1 && (p[0] * p[2] * p[6] || p[0] * p[4] * p[6])) continue;
          remove.push(index);
        }
      }
      if (remove.length) changed = true;
      for (const index of remove) binary[index] = 0;
    }
  }
}

function neighboursClockwise(index, binary, width) {
  return [
    binary[index - width], binary[index - width + 1], binary[index + 1], binary[index + width + 1],
    binary[index + width], binary[index + width - 1], binary[index - 1], binary[index - width - 1]
  ];
}

function skeletonNeighbours(index, binary, width, height) {
  const column = index % width, row = Math.floor(index / width), result = [];
  for (const [dx, dz] of EIGHT) {
    const nextColumn = column + dx, nextRow = row + dz;
    if (nextColumn < 0 || nextRow < 0 || nextColumn >= width || nextRow >= height) continue;
    const next = nextRow * width + nextColumn;
    if (binary[next]) result.push(next);
  }
  return result;
}

function simplifyLine(points, tolerance) {
  if (points.length <= 2) return points;
  let maximum = 0, selected = 0;
  for (let index = 1; index + 1 < points.length; index += 1) {
    const distance = pointSegmentDistance(points[index], points[0], points.at(-1));
    if (distance > maximum) { maximum = distance; selected = index; }
  }
  if (maximum <= tolerance) return [points[0], points.at(-1)];
  return [
    ...simplifyLine(points.slice(0, selected + 1), tolerance).slice(0, -1),
    ...simplifyLine(points.slice(selected), tolerance)
  ];
}

function densifyLine(points, spacingM) {
  const result = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1], to = points[index];
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const steps = Math.max(1, Math.ceil(length / spacingM));
    if (!result.length) result.push(from);
    for (let step = 1; step <= steps; step += 1) {
      const fraction = step / steps;
      result.push([from[0] + (to[0] - from[0]) * fraction, from[1] + (to[1] - from[1]) * fraction]);
    }
  }
  return result;
}

function nearMask(mask, grid, column, row, distanceM) {
  const radius = Math.max(1, Math.ceil(distanceM / grid.cellSizeM));
  for (let dz = -radius; dz <= radius; dz += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (Math.hypot(dx, dz) * grid.cellSizeM > distanceM) continue;
      const x = column + dx, z = row + dz;
      if (x < 0 || z < 0 || x >= grid.columns || z >= grid.rows) continue;
      if (mask[z * grid.columns + x]) return true;
    }
  }
  return false;
}

function localToCell(grid, x, z) {
  const column = Math.floor((x - grid.minX) / grid.cellSizeM);
  const row = Math.floor((z - grid.minZ) / grid.cellSizeM);
  const index = column >= 0 && row >= 0 && column < grid.columns && row < grid.rows
    ? row * grid.columns + column : -1;
  return { column, row, index };
}

function cellCenter(grid, column, row) {
  return [grid.minX + (column + 0.5) * grid.cellSizeM, grid.minZ + (row + 0.5) * grid.cellSizeM];
}

function polygonParts(geometry) {
  if (geometry?.type === "Polygon") return [geometry.coordinates];
  if (geometry?.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function lineParts(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates];
  if (geometry?.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function removeCollinear(ring) {
  const result = [];
  for (let index = 0; index < ring.length - 1; index += 1) {
    const previous = ring[(index - 1 + ring.length - 1) % (ring.length - 1)];
    const current = ring[index];
    const next = ring[(index + 1) % (ring.length - 1)];
    const cross = (current[0] - previous[0]) * (next[1] - current[1]) -
      (current[1] - previous[1]) * (next[0] - current[0]);
    if (Math.abs(cross) > 1e-9) result.push(current);
  }
  if (result.length) result.push(result[0]);
  return result;
}

function robustRgb(values) {
  return [0, 1, 2].map((band) => median(values.map((value) => value[band]).sort((a, b) => a - b)));
}

function looksVegetated([r, g, b]) {
  const greenExcess = g - (r + b) / 2;
  return g > 55 && greenExcess > 20;
}

function normalizePathMaterial(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[ -]+/g, "_");
  if (["ground", "mud", "unpaved"].includes(key)) return "earth";
  if (["dirt", "earth", "compacted", "gravel", "fine_gravel", "sand", "stone",
    "asphalt", "concrete", "paving_stones", "cobblestone", "sett", "wood", "boardwalk"].includes(key)) return key;
  return null;
}

function rgbToLab(rgb) {
  const linear = rgb.map((value) => {
    const channel = clamp(value / 255, 0, 1);
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const x = (linear[0] * 0.4124 + linear[1] * 0.3576 + linear[2] * 0.1805) / 0.95047;
  const y = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  const z = (linear[0] * 0.0193 + linear[1] * 0.1192 + linear[2] * 0.9505) / 1.08883;
  const f = (value) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaLab(first, second) {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

function lineLength(points) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
  }
  return length;
}

function pointSegmentDistance(point, from, to) {
  const dx = to[0] - from[0], dz = to[1] - from[1];
  const denominator = dx * dx + dz * dz;
  if (!denominator) return Math.hypot(point[0] - from[0], point[1] - from[1]);
  const fraction = clamp(((point[0] - from[0]) * dx + (point[1] - from[1]) * dz) / denominator, 0, 1);
  return Math.hypot(point[0] - (from[0] + dx * fraction), point[1] - (from[1] + dz * fraction));
}

function parseLength(value) {
  if (value === undefined || value === null || value === "") return null;
  const match = String(value).replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}

function median(sorted) {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mode(values) {
  const counts = countBy(values, (value) => value);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries.length ? Number(entries[0][0]) : null;
}

function countBy(values, selector) {
  const result = {};
  for (const value of values) {
    const key = selector(value) ?? "unknown";
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const EIGHT = [...CARDINAL, [1, 1], [1, -1], [-1, 1], [-1, -1]];
const edgeKey = (first, second) => first < second ? `${first}:${second}` : `${second}:${first}`;
const pointKey = ([x, z]) => `${x},${z}`;
const signedArea = (ring) => ring.reduce((sum, [x, z], index) => {
  const [nextX, nextZ] = ring[(index + 1) % ring.length];
  return sum + x * nextZ - nextX * z;
}, 0) / 2;
const ratio = (numerator, denominator) => denominator ? numerator / denominator : 0;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const rgbHex = (rgb) => `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;
const round3 = (value) => Math.round(value * 1000) / 1000;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
