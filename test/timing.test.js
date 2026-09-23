import test from 'node:test';
import assert from 'node:assert/strict';

/** v5.5: when to go on a built tour (public/terrain/timing.js). */

const T = await import('../public/terrain/timing.js');
const { octant } = await import('../public/terrain/analysis.js');

function day(iso, f) {
  const time = [], temp = [], wind = [], gust = [], cloud = [], snow = [], precip = [];
  for (let h = 0; h < 24; h++) {
    const v = f(h);
    time.push(`${iso}T${String(h).padStart(2, '0')}:00`);
    temp.push(v.temp); wind.push(v.wind); gust.push(v.gust ?? v.wind + 4); cloud.push(v.cloud); snow.push(0); precip.push(0);
  }
  return { time, temp, wind, gust, cloud, snow, precip };
}
const place = { lat: 61.05, lon: 8.21, vertical_m: 600 };

test('spring sun on a south descent: leave early enough to be off it before it softens', () => {
  const iso = '2027-04-15';
  const hourly = day(iso, () => ({ temp: -4, wind: 3, cloud: 10 })); // clear, mild at mid-height: sun-softening from 10 on S
  const parts = [
    { kind: 'leg', label: 'Up to descent 1', hours: 3 },
    { kind: 'descent', label: 'Descent 1', hours: 0.75, aspects: ['S'] },
    { kind: 'leg', label: 'Back to the start', hours: 0.5 },
  ];
  const p = T.planDay({ parts, place, hourly, iso });
  assert.ok(p.light.start < 6, `light from ${p.light.start}`);
  assert.equal(p.parts[1].wetFrom, 10);
  assert.equal(p.parts[1].onWet, 0, 'off the descent before it is wet');
  assert.equal(p.parts[1].wetReason, 'sun');
  assert.ok(p.depart <= 6 + 1e-9, `leave ${T.hhmm(p.depart)}`);
  assert.equal(p.fit, 'fits');
  assert.equal(p.warnings.length, 0);
  // Parts follow each other, with the changeovers at the descent.
  assert.ok(Math.abs(p.parts[1].from - (p.depart + 3 + T.TRANSITION_H)) < 1e-9);
  assert.ok(Math.abs(p.parts[2].from - (p.parts[1].to + T.TRANSITION_H)) < 1e-9);
});

test('a north descent is not softened by the sun; the weather picks the start', () => {
  const iso = '2027-04-15';
  // A gale until 09, then calm: leave after the wind drops.
  const hourly = day(iso, (h) => ({ temp: -6, wind: h < 9 ? 20 : 3, gust: h < 9 ? 28 : 6, cloud: 20 }));
  const parts = [{ kind: 'leg', label: 'Up', hours: 2 }, { kind: 'descent', label: 'D1', hours: 0.5, aspects: ['N'] }];
  const p = T.planDay({ parts, place, hourly, iso });
  assert.equal(p.parts[1].wetFrom, null);
  assert.ok(p.depart >= 9, `leave ${T.hhmm(p.depart)}`);
});

test('a tour longer than the light says it does not fit', () => {
  const iso = '2027-12-10';
  const hourly = day(iso, () => ({ temp: -10, wind: 4, cloud: 50 }));
  const parts = [{ kind: 'leg', label: 'Up', hours: 7 }, { kind: 'descent', label: 'D1', hours: 1, aspects: ['E'] }];
  const p = T.planDay({ parts, place, hourly, iso });
  assert.equal(p.fit, 'no');
  assert.match(p.warnings[0], /does not fit/);
});

test('a descent that cannot be off in time is flagged with what to do', () => {
  const iso = '2027-04-15';
  const hourly = day(iso, (h) => ({ temp: h >= 7 ? 3 : -3, wind: 3, cloud: 10 })); // thaw from 07
  const parts = [{ kind: 'leg', label: 'Up', hours: 4 }, { kind: 'descent', label: 'Descent 1', hours: 1, aspects: ['W'] }];
  const p = T.planDay({ parts, place, hourly, iso });
  assert.ok(p.parts[1].onWet > 0);
  assert.equal(p.parts[1].wetReason, 'thaw');
  assert.match(p.warnings.join(' '), /Descent 1 faces W: wet snow from about 07:00/);
});

test('no hourly forecast for the day: null', () => {
  assert.equal(T.planDay({ parts: [], place, hourly: day('2027-01-01', () => ({ temp: 0, wind: 0, cloud: 0 })), iso: '2027-01-02' }), null);
});

test('descentAspects takes the aspects of the steeper part', () => {
  const s = [
    { slope: 5, aspect: 90 }, { slope: 32, aspect: 180 }, { slope: 34, aspect: 170 }, { slope: 30, aspect: 200 }, { slope: 28, aspect: 225 },
  ];
  assert.deepEqual(T.descentAspects(s, octant), ['S', 'SW']);
  assert.equal(T.hhmm(7.5), '07:30');
});

test('rankOrders: the south-facing descent is skied first when that keeps it off wet snow', () => {
  const iso = '2027-04-15';
  const hourly = day(iso, () => ({ temp: -4, wind: 3, cloud: 10 })); // spring sun: S soft from 10
  const start = [61.0, 8.0];
  const descents = [
    { label: 'Descent 1', hours: 0.75, aspects: ['N'], top: [61.05, 8.05], bottom: [61.03, 8.05] },
    { label: 'Descent 2', hours: 0.75, aspects: ['S'], top: [61.06, 8.10], bottom: [61.02, 8.10] },
  ];
  // Leg times by hand: the south descent is 2.5 h from the start, the north
  // one 3 h, and 2 h between them; out and back 1 h.
  const key = (a, b) => `${a}|${b}`;
  const S0 = start, D1t = descents[0].top, D1b = descents[0].bottom, D2t = descents[1].top, D2b = descents[1].bottom;
  const table = new Map([
    [key(S0, D1t), 3], [key(S0, D2t), 2.5], [key(D1b, D2t), 2], [key(D2b, D1t), 2], [key(D1b, S0), 1], [key(D2b, S0), 1],
  ]);
  const legHours = (a, b) => table.get(key(a, b)) ?? null;
  const ranked = T.rankOrders({ start, descents, legHours, day: { place, hourly, iso, problems: [] } });
  assert.equal(ranked.length, 2);
  const cur = ranked.find((r) => r.current);
  assert.ok(cur.wetH > 0.05, 'as drawn, the south descent comes too late');
  assert.deepEqual(ranked[0].order, [1, 0], 'south first');
  assert.ok(ranked[0].wetH < 0.05);
  assert.equal(T.permutations(4).length, 24);
  assert.deepEqual(T.rankOrders({ start, descents: Array(7).fill(descents[0]), legHours, day: { place, hourly, iso } }), []);
});
