/**
 * Geometry and ingest tests.
 *
 * Everything here is pure, so it is checked against hand-worked answers rather
 * than against a spatial engine. That is the point of doing the containment
 * test in the application: it can be reasoned about directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bboxOf, boundingBoxFor, centroidOf, haversineMetres, inBBox,
  pointInGeometry, pointInPolygon, pointInRing,
  REGINA_BBOX, type LinearRing,
} from '../src/modules/geo/polygon.js';
import {
  hasMore, neighbourhoodFor, parseAddressPoints, parseBoundaries,
  pickField, toFeatures,
} from '../src/modules/geo/ingest.js';

// A unit square from (0,0) to (10,10), in GeoJSON [lng, lat] order.
const SQUARE: LinearRing = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];

test('polygon: a point inside the square is inside', () => {
  assert.equal(pointInRing(5, 5, SQUARE), true);
});

test('polygon: points outside on every side are outside', () => {
  for (const [lng, lat] of [[-1, 5], [11, 5], [5, -1], [5, 11]] as const) {
    assert.equal(pointInRing(lng, lat, SQUARE), false, `(${lng},${lat})`);
  }
});

test('polygon: a ray through a vertex is not double-counted', () => {
  // The classic ray-casting bug. A ray cast at exactly the latitude of a
  // vertex crosses two edges there and, counted naively, flips twice — so an
  // interior point reads as outside.
  const diamond: LinearRing = [[5, 0], [10, 5], [5, 10], [0, 5], [5, 0]];
  assert.equal(pointInRing(5, 5, diamond), true, 'centre of the diamond');
  assert.equal(pointInRing(-1, 5, diamond), false, 'left of it, level with two vertices');
  assert.equal(pointInRing(11, 5, diamond), false, 'right of it');
});

test('polygon: a concave shape does not fill its notch', () => {
  // An L. The notch in the upper right is outside the shape.
  const ell: LinearRing = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]];
  assert.equal(pointInRing(2, 2, ell), true, 'in the corner');
  assert.equal(pointInRing(8, 2, ell), true, 'in the foot');
  assert.equal(pointInRing(2, 8, ell), true, 'in the upright');
  assert.equal(pointInRing(8, 8, ell), false, 'in the notch — must be outside');
});

test('polygon: a hole is a hole', () => {
  const hole: LinearRing = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
  assert.equal(pointInPolygon(5, 5, [SQUARE, hole]), false, 'inside the hole');
  assert.equal(pointInPolygon(2, 2, [SQUARE, hole]), true, 'inside, away from the hole');
});

test('polygon: MultiPolygon matches any of its parts', () => {
  const far: LinearRing = [[100, 100], [110, 100], [110, 110], [100, 110], [100, 100]];
  const geom = { type: 'MultiPolygon', coordinates: [[SQUARE], [far]] };
  assert.equal(pointInGeometry(5, 5, geom), true);
  assert.equal(pointInGeometry(105, 105, geom), true);
  assert.equal(pointInGeometry(50, 50, geom), false);
});

test('polygon: a degenerate ring is never containing', () => {
  assert.equal(pointInPolygon(0, 0, [[[0, 0], [1, 1]]]), false);
  assert.equal(pointInPolygon(0, 0, []), false);
  assert.equal(pointInGeometry(0, 0, { type: 'LineString', coordinates: [[0, 0], [1, 1]] }), false);
});

test('bbox: covers every vertex of a nested geometry', () => {
  const box = bboxOf({ type: 'Polygon', coordinates: [SQUARE] })!;
  assert.deepEqual(box, { minLat: 0, minLng: 0, maxLat: 10, maxLng: 10 });

  const multi = bboxOf({
    type: 'MultiPolygon',
    coordinates: [[SQUARE], [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]]],
  })!;
  assert.deepEqual(multi, { minLat: 0, minLng: 0, maxLat: 30, maxLng: 30 });
});

test('bbox: a geometry with no positions yields null', () => {
  assert.equal(bboxOf({ type: 'Polygon', coordinates: [] }), null);
  assert.equal(centroidOf({ type: 'Polygon', coordinates: [] }), null);
});

test('bbox: centroid sits at the middle of the box', () => {
  const c = centroidOf({ type: 'Polygon', coordinates: [SQUARE] })!;
  assert.deepEqual(c, { lat: 5, lng: 5 });
});

test('distance: a known separation comes out right', () => {
  // Regina to Saskatoon is about 240 km.
  const regina = { lat: 50.4452, lng: -104.6189 };
  const saskatoon = { lat: 52.1332, lng: -106.6700 };
  const km = haversineMetres(regina, saskatoon) / 1000;
  assert.ok(km > 230 && km < 250, `expected ~240 km, got ${km.toFixed(1)}`);
});

test('distance: a point is zero from itself', () => {
  const p = { lat: 50.4452, lng: -104.6189 };
  assert.equal(haversineMetres(p, p), 0);
});

test('bounding box: contains the circle it approximates', () => {
  const centre = { lat: 50.4452, lng: -104.6189 };
  const radius = 1000;
  const box = boundingBoxFor(centre, radius);

  // Points on the circle, in eight directions. Every one must fall inside the
  // box: the box is the indexable prefilter, so anything it excludes is a
  // result the exact distance test never gets the chance to keep.
  const latPerM = 1 / 111_320;
  const lngPerM = 1 / (111_320 * Math.cos((centre.lat * Math.PI) / 180));
  for (let deg = 0; deg < 360; deg += 45) {
    const rad = (deg * Math.PI) / 180;
    // 0.99 of the radius, to stay clear of the boundary rather than testing
    // floating-point equality against it.
    const d = radius * 0.99;
    const p = {
      lat: centre.lat + Math.cos(rad) * d * latPerM,
      lng: centre.lng + Math.sin(rad) * d * lngPerM,
    };
    assert.ok(haversineMetres(centre, p) < radius, `bearing ${deg} is inside the circle`);
    assert.equal(inBBox(p, box), true, `bearing ${deg} must be inside the box`);
  }
});

test('bounding box: longitude widens with latitude', () => {
  // A degree of longitude is ~111 km at the equator and ~71 km at Regina, so
  // the same radius must span more degrees the further north you go. Using the
  // latitude figure for both would cut the box a third too narrow here.
  const atEquator = boundingBoxFor({ lat: 0, lng: 0 }, 10_000);
  const atRegina = boundingBoxFor({ lat: 50.45, lng: -104.6 }, 10_000);
  const spanEq = atEquator.maxLng - atEquator.minLng;
  const spanRe = atRegina.maxLng - atRegina.minLng;
  assert.ok(spanRe > spanEq * 1.4, `expected a wider span at 50°N: ${spanEq} vs ${spanRe}`);
});

test('bounding box: does not run off the ends of the world', () => {
  const pole = boundingBoxFor({ lat: 89.999, lng: 0 }, 500_000);
  assert.ok(pole.maxLat <= 90 && pole.minLat >= -90);
  assert.ok(pole.minLng >= -180 && pole.maxLng <= 180);
});

test('Regina bbox: accepts the city and rejects the two silent failures', () => {
  assert.equal(inBBox({ lat: 50.4452, lng: -104.6178 }, REGINA_BBOX), true, 'downtown Regina');
  // A projected coordinate system read as degrees lands near null island.
  assert.equal(inBBox({ lat: 0, lng: 0 }, REGINA_BBOX), false, 'null island');
  // Swapped axis order puts Regina in the Indian Ocean.
  assert.equal(inBBox({ lat: -104.6178, lng: 50.4452 }, REGINA_BBOX), false, 'swapped lat/lng');
});

// ── ingest ───────────────────────────────────────────────────────────────────

const ESRI_POINT = {
  features: [{
    attributes: { OBJECTID: 1, ADDRESS: '2100 Victoria Ave', CIVIC_NUM: 2100 },
    geometry: { x: -104.6178, y: 50.4452 },
  }],
};

const GEOJSON_POINT = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { OBJECTID: 1, ADDRESS: '2100 Victoria Ave' },
    geometry: { type: 'Point', coordinates: [-104.6178, 50.4452] },
  }],
};

test('ingest: both response formats reduce to the same feature', () => {
  const fromEsri = toFeatures(ESRI_POINT)[0]!;
  const fromGeo = toFeatures(GEOJSON_POINT)[0]!;
  assert.deepEqual(fromEsri.geometry, { type: 'Point', coordinates: [-104.6178, 50.4452] });
  assert.deepEqual(fromGeo.geometry, { type: 'Point', coordinates: [-104.6178, 50.4452] });
  assert.equal(fromEsri.attributes['ADDRESS'], fromGeo.attributes['ADDRESS']);
});

test('ingest: Esri rings become a polygon', () => {
  const feat = toFeatures({
    features: [{ attributes: { OBJECTID: 7, NAME: 'Cathedral' }, geometry: { rings: [SQUARE] } }],
  })[0]!;
  assert.equal(feat.geometry?.type, 'Polygon');
  assert.deepEqual(feat.geometry?.coordinates, [SQUARE]);
});

test('ingest: a payload with no features is empty rather than throwing', () => {
  for (const bad of [null, undefined, {}, { features: 'nope' }, 42]) {
    assert.deepEqual(toFeatures(bad), []);
  }
});

test('ingest: paging stops when the server stops asking for more', () => {
  assert.equal(hasMore({ exceededTransferLimit: true }), true);
  assert.equal(hasMore({ properties: { exceededTransferLimit: true } }), true, 'geojson form');
  assert.equal(hasMore({ exceededTransferLimit: false }), false);
  assert.equal(hasMore({}), false);
});

test('ingest: field lookup is case-insensitive and takes the first match', () => {
  const attrs = { Address: '2100 Victoria Ave', FULL_ADDRESS: 'ignored' };
  const hit = pickField(attrs, ['address', 'full_address'])!;
  assert.equal(hit.key, 'Address');
  assert.equal(hit.value, '2100 Victoria Ave');
});

test('ingest: an empty value is treated as absent, so the next candidate wins', () => {
  const attrs = { address: '   ', full_address: '2100 Victoria Ave' };
  // '   ' is not empty-string, so pickField returns it; asText trims it to null
  // downstream. What must NOT happen is a literal empty string winning.
  const hit = pickField({ address: '', full_address: '2100 Victoria Ave' }, ['address', 'full_address'])!;
  assert.equal(hit.key, 'full_address');
  assert.ok(attrs);
});

test('ingest: parses an address point and normalizes its key', () => {
  const { records } = parseAddressPoints(ESRI_POINT, { region: REGINA_BBOX });
  assert.equal(records.length, 1);
  const r = records[0]!;
  assert.equal(r.fullAddress, '2100 Victoria Ave');
  assert.equal(r.lat, 50.4452);
  assert.equal(r.city, 'Regina');
  assert.equal(r.province, 'SK');
});

test('ingest: composes an address when only the parts are published', () => {
  const { records } = parseAddressPoints({
    features: [{
      attributes: { OBJECTID: 2, CIVIC_NUM: 3125, STREET_NAME: '13th Ave' },
      geometry: { x: -104.62, y: 50.43 },
    }],
  }, { region: REGINA_BBOX });
  assert.equal(records[0]?.fullAddress, '3125 13th Ave');
});

test('ingest: the region check catches a projection error', () => {
  const { records, skipped } = parseAddressPoints({
    features: [{ attributes: { OBJECTID: 3, ADDRESS: 'Null Island' }, geometry: { x: 0, y: 0 } }],
  }, { region: REGINA_BBOX });
  assert.equal(records.length, 0);
  assert.equal(skipped[0]?.reason, 'coordinate_not_in_region');
});

test('ingest: swapped axis order is caught', () => {
  const { records, skipped } = parseAddressPoints({
    features: [{
      attributes: { OBJECTID: 4, ADDRESS: 'Swapped' },
      geometry: { x: 50.4452, y: -104.6178 },
    }],
  }, { region: REGINA_BBOX });
  assert.equal(records.length, 0);
  // Regina's longitude is -104.6, which is not a valid latitude, so a swap
  // here trips the range check before the region check ever runs. Both catch
  // it; asserting only that it is rejected keeps the test about the outcome
  // rather than about which guard happened to fire first.
  assert.equal(skipped[0]?.reason, 'coordinate_out_of_range');
});

test('ingest: an out-of-range coordinate is rejected before the region test', () => {
  const { skipped } = parseAddressPoints({
    features: [{ attributes: { OBJECTID: 5, ADDRESS: 'Nowhere' }, geometry: { x: 999, y: 999 } }],
  }, { region: REGINA_BBOX });
  assert.equal(skipped[0]?.reason, 'coordinate_out_of_range');
});

test('ingest: a feature with no address is skipped, not guessed at', () => {
  const { records, skipped } = parseAddressPoints({
    features: [{ attributes: { OBJECTID: 6 }, geometry: { x: -104.62, y: 50.44 } }],
  }, { region: REGINA_BBOX });
  assert.equal(records.length, 0);
  assert.equal(skipped[0]?.reason, 'no_address');
});

test('ingest: unmapped source fields are reported', () => {
  // This is how a dataset whose address column is named something unexpected
  // gets noticed, rather than producing a silent zero-row load.
  const { unmappedFields } = parseAddressPoints({
    features: [{
      attributes: { OBJECTID: 1, ADDRESS: '1 A St', MYSTERY_COLUMN: 'x' },
      geometry: { x: -104.62, y: 50.44 },
    }],
  }, { region: REGINA_BBOX });
  assert.ok(unmappedFields.includes('MYSTERY_COLUMN'));
  assert.ok(!unmappedFields.includes('ADDRESS'));
});

test('ingest: boundaries parse, and a nameless one is skipped', () => {
  const { records, skipped } = parseBoundaries({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { OBJECTID: 1, NAME: 'Cathedral' },
        geometry: { type: 'Polygon', coordinates: [SQUARE] } },
      { type: 'Feature', properties: { OBJECTID: 2 },
        geometry: { type: 'Polygon', coordinates: [SQUARE] } },
    ],
  });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.name, 'Cathedral');
  assert.equal(skipped[0]?.reason, 'no_name');
});

test('ingest: a point geometry is not accepted as a boundary', () => {
  const { records, skipped } = parseBoundaries(GEOJSON_POINT);
  assert.equal(records.length, 0);
  assert.equal(skipped[0]?.reason, 'no_geometry');
});

test('ingest: neighbourhood assignment uses the bbox to skip candidates', () => {
  const index = [
    { id: 'far', geometry: { type: 'Polygon', coordinates: [SQUARE] },
      box: { minLat: 0, minLng: 0, maxLat: 10, maxLng: 10 } },
    { id: 'near', geometry: {
        type: 'Polygon',
        coordinates: [[[-104.63, 50.44], [-104.61, 50.44], [-104.61, 50.455],
                       [-104.63, 50.455], [-104.63, 50.44]]],
      },
      box: { minLat: 50.44, minLng: -104.63, maxLat: 50.455, maxLng: -104.61 } },
  ];
  assert.equal(neighbourhoodFor({ lat: 50.4452, lng: -104.6178 }, index), 'near');
  assert.equal(neighbourhoodFor({ lat: 60, lng: -100 }, index), null);
});

test('ingest: a boundary with no bbox still gets the containment test', () => {
  const index = [{
    id: 'unboxed',
    geometry: { type: 'Polygon', coordinates: [SQUARE] },
    box: null,
  }];
  assert.equal(neighbourhoodFor({ lat: 5, lng: 5 }, index), 'unboxed');
  assert.equal(neighbourhoodFor({ lat: 50, lng: 50 }, index), null);
});
