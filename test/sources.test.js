import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeNorwegian } from '../src/sources/varsom.js';
import { shapeSnow, summariseByRegion } from '../src/sources/senorge.js';
import { parseSwedishPage } from '../src/sources/lavinprognoser.js';

/**
 * Fixtures below are REAL responses captured from the live APIs while
 * building this, trimmed for length. If an upstream changes shape, these
 * are the tests that should go red.
 */

const varsomDetail = [
  {
    RegId: 460526,
    RegionId: 3024,
    RegionName: 'Sunnmøre',
    DangerLevel: '2',
    DangerLevelName: '2 Moderate',
    ValidFrom: '2026-04-13T00:00:00',
    ValidTo: '2026-04-13T23:59:59',
    PublishTime: '2026-04-12T15:35:48.79',
    NextWarningTime: '2026-04-14T16:00:00',
    MainText: 'Clear weather leads to marked contrasts in the snowpack.',
    EmergencyWarning: 'Not given',
    SnowSurface: 'Generelt lite snø for årstida.',
    CurrentWeaklayers: 'Vekslande temperaturar med utstråling.',
    LatestAvalancheActivity: 'Laurdag vart det observert to naturleg utløyste skred.',
    LatestObservations: 'På Roaldshornet (1050 moh) i Stranda.',
    AvalancheProblems: [
      {
        AvalancheProblemId: 2,
        AvalancheExtName: 'Loose wet avalanche',
        AvalProbabilityName: 'Possible',
        DestructiveSizeExtName: '1 - Small',
        DangerLevelName: '1 Low',
      },
      {
        AvalancheProblemId: 1,
        AvalancheExtName: 'Dry slab avalanche',
        AvalProbabilityName: 'Possible',
        DestructiveSizeExtName: '2 - Medium',
        DangerLevelName: '2 Moderate',
      },
    ],
    MountainWeather: {
      CloudCoverName: 'Partly cloudy',
      Comment: 'Lokalt liten kuling',
      MeasurementTypes: [
        { Id: 50, Name: 'Freezing Level', MeasurementSubTypes: [{ Name: 'asl', Value: '800 moh' }] },
        { Id: 20, Name: 'Wind', MeasurementSubTypes: [{ Name: 'speed', Value: 'Fresh breeze' }] },
      ],
    },
    AvalancheAdvices: [{ Text: 'Avoid terrain steeper than 30 degrees.' }],
  },
  { DangerLevel: '3', ValidFrom: '2026-04-14T00:00:00' },
  { DangerLevel: '2', ValidFrom: '2026-04-15T00:00:00' },
];

test('shapes a real Varsom Detail response', () => {
  const s = shapeNorwegian(varsomDetail);
  assert.equal(s.danger, 2);
  assert.equal(s.assessed, true);
  assert.equal(s.problems.length, 2);
  assert.equal(s.problems[1].type, 'Dry slab avalanche');
  assert.equal(s.latestAvalancheActivity, 'Laurdag vart det observert to naturleg utløyste skred.');
  assert.equal(s.mountainWeather.cloudCover, 'Partly cloudy');
  assert.match(s.mountainWeather.measurements['Freezing Level'], /800 moh/);
  assert.deepEqual(s.outlook.map((o) => o.danger), [3, 2]);
  assert.equal(s.emergencyWarning, null, '"Not given" must not surface as a warning');
});

test('treats danger level 0 and empty responses as not assessed, never as safe', () => {
  const zero = shapeNorwegian([{ DangerLevel: '0', RegionName: 'X' }]);
  assert.equal(zero.danger, null);
  assert.equal(zero.assessed, false);

  const empty = shapeNorwegian([]);
  assert.equal(empty.danger, null);
  assert.equal(empty.assessed, false);
});

// Real gts.nve.no response for Galdhøpiggen's grid cell.
const senorgeRaw = {
  Theme: 'sd',
  FullName: 'Snødybde',
  NoDataValue: 65535,
  X: 146001,
  Y: 6851874,
  StartDate: '07.04.2026 06:00:00',
  EndDate: '13.04.2026 06:00:00',
  Unit: 'cm',
  TimeResolution: 1440,
  Altitude: 2178,
  Data: [150, 152, 151, 160, 175, 187.5, 190],
};

test('shapes a real seNorge response and computes new snow from depth change', () => {
  const s = shapeSnow(senorgeRaw);
  assert.equal(s.depthCm, 190);
  assert.equal(s.gridAltitude, 2178);
  assert.equal(s.unit, 'cm');
  assert.equal(s.new24, 2.5, '190 - 187.5');
  assert.equal(s.new48, 15, '190 - 175');
  assert.equal(s.new72, 30, '190 - 160');
});

test('settling snow reports as zero new snow, never negative', () => {
  const s = shapeSnow({ ...senorgeRaw, Data: [200, 195, 190, 185] });
  assert.equal(s.depthCm, 185);
  assert.equal(s.new24, 0);
  assert.equal(s.new48, 0);
});

test('NoDataValue is treated as missing, not as a 65535 cm snowpack', () => {
  const s = shapeSnow({ ...senorgeRaw, Data: [65535, 65535, 65535, 65535] });
  assert.equal(s.depthCm, null);
  assert.equal(s.new48, null);
  assert.deepEqual(s.series, [null, null, null, null]);
});

test('falls back to the last valid reading when the newest day is missing', () => {
  const s = shapeSnow({ ...senorgeRaw, Data: [100, 110, 120, 65535] });
  assert.equal(s.depthCm, 120);
});

test('region summary uses median depth and max new snow across tour points', () => {
  const tours = [
    { name: 'A', region: 'lyngen' },
    { name: 'B', region: 'lyngen' },
    { name: 'C', region: 'lyngen' },
  ];
  const snow = {
    A: { depthCm: 100, new48: 10, new24: 5, new72: 12, observedAt: 'x' },
    B: { depthCm: 200, new48: 45, new24: 20, new72: 50, observedAt: 'x' },
    C: { depthCm: 150, new48: 20, new24: 8, new72: 22, observedAt: 'x' },
  };
  const out = summariseByRegion(snow, tours);
  assert.equal(out.lyngen.depthCm, 150, 'median of 100/150/200');
  assert.equal(out.lyngen.depthMaxCm, 200);
  assert.equal(out.lyngen.new48, 45, 'max, so one loaded aspect still raises the alert');
  assert.equal(out.lyngen.topTour, 'B');
  assert.equal(out.lyngen.sampleCount, 3);
});

test('region summary ignores tours whose grid cell returned nothing', () => {
  const tours = [{ name: 'A', region: 'r' }, { name: 'B', region: 'r' }];
  const out = summariseByRegion({ A: { depthCm: null }, B: { depthCm: 80, new48: 5 } }, tours);
  assert.equal(out.r.sampleCount, 1);
  assert.equal(out.r.depthCm, 80);
});

test('reads an out-of-season Swedish page as explicitly not assessed', () => {
  const html = `<html><body><img alt="Risk 0 lavinskalan"><h2>Ej bedömd</h2>
    <p>Prognossäsongen är avslutad.</p></body></html>`;
  const s = parseSwedishPage(html, { slug: 'sodra_jamtlandsfjallen' });
  assert.equal(s.danger, null);
  assert.equal(s.assessed, false);
  assert.equal(s.seasonOver, true);
  assert.equal(s.confidence, 'explicit-none');
});

test('reads a numeric Swedish danger level when present', () => {
  const html = `<html><body><img alt="Risk 3"><p>Betydande lavinfara</p></body></html>`;
  const s = parseSwedishPage(html, { slug: 'x' });
  assert.equal(s.danger, 3);
  assert.equal(s.assessed, true);
  assert.equal(s.confidence, 'parsed');
});

test('does not mistake "mycket stor lavinfara" for "stor lavinfara"', () => {
  const s = parseSwedishPage('<p>Mycket stor lavinfara råder i hela området</p>', { slug: 'x' });
  assert.equal(s.danger, 5, 'longest danger word must win');
});

test('an unreadable Swedish page yields null, never a guessed level', () => {
  const s = parseSwedishPage('<html><body><p>Something else entirely</p></body></html>', { slug: 'x' });
  assert.equal(s.danger, null);
  assert.equal(s.confidence, 'none');
  assert.ok(s.note, 'must tell the reader it could not be read');
});
