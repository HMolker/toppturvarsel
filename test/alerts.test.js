import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAlerts,
  selectSendable,
  isQuietHour,
  alertKey,
  buildEmail,
  buildPush,
} from '../src/alerts.js';

const snapshot = (regions) => ({
  fetchedAt: '2026-02-10T08:00:00.000Z',
  regions: regions.map((r) => ({
    offMap: false,
    bulletinUrl: 'https://example.invalid/b',
    bulletin: { danger: null, problems: [] },
    snow: null,
    ...r,
  })),
});

test('fires only for regions at or above the threshold', () => {
  const s = snapshot([
    { id: 'a', name: 'A', snow: { new48: 31, depthCm: 120 } },
    { id: 'b', name: 'B', snow: { new48: 30, depthCm: 90 } },
    { id: 'c', name: 'C', snow: { new48: 29, depthCm: 90 } },
    { id: 'd', name: 'D', snow: null },
  ]);
  const out = evaluateAlerts(s, { threshold: 30 });
  assert.deepEqual(out.map((a) => a.regionId), ['a', 'b']);
});

test('sorts biggest load first', () => {
  const s = snapshot([
    { id: 'a', name: 'A', snow: { new48: 35 } },
    { id: 'b', name: 'B', snow: { new48: 62 } },
    { id: 'c', name: 'C', snow: { new48: 44 } },
  ]);
  assert.deepEqual(evaluateAlerts(s, { threshold: 30 }).map((a) => a.regionId), ['b', 'c', 'a']);
});

test('a null new48 never fires, and a null danger never blocks one', () => {
  const s = snapshot([
    { id: 'a', name: 'A', snow: { new48: null, depthCm: 200 } },
    { id: 'b', name: 'B', snow: { new48: 40 }, bulletin: { danger: null, problems: [] } },
  ]);
  const out = evaluateAlerts(s, { threshold: 30 });
  assert.equal(out.length, 1);
  assert.equal(out[0].regionId, 'b');
  assert.equal(out[0].dangerKnown, false);
});

test('respects a region watch list and skips off-map regions', () => {
  const s = snapshot([
    { id: 'a', name: 'A', snow: { new48: 50 } },
    { id: 'b', name: 'B', snow: { new48: 50 } },
    { id: 'sval', name: 'Svalbard', offMap: true, snow: { new48: 90 } },
  ]);
  const out = evaluateAlerts(s, { threshold: 30, watch: 'b' });
  assert.deepEqual(out.map((a) => a.regionId), ['b']);
});

test('quiet hours wrap around midnight', () => {
  const at = (h) => new Date(2026, 1, 10, h, 0, 0);
  assert.equal(isQuietHour(at(23), 22, 6), true);
  assert.equal(isQuietHour(at(3), 22, 6), true);
  assert.equal(isQuietHour(at(6), 22, 6), false);
  assert.equal(isQuietHour(at(12), 22, 6), false);
  // A non-wrapping window still works
  assert.equal(isQuietHour(at(13), 12, 14), true);
  // from === to disables quiet hours entirely
  assert.equal(isQuietHour(at(13), 0, 0), false);
});

test('does not resend an alert already in the ledger', () => {
  const alerts = evaluateAlerts(
    snapshot([{ id: 'a', name: 'A', snow: { new48: 40 } }]),
    { threshold: 30 }
  );
  const ledger = { sent: { [alertKey(alerts[0])]: '2026-02-10T09:00:00Z' }, pending: [] };
  const { send } = selectSendable(alerts, ledger, new Date(2026, 1, 10, 12));
  assert.equal(send.length, 0);
});

test('same region on a later day alerts again', () => {
  const day1 = evaluateAlerts(snapshot([{ id: 'a', name: 'A', snow: { new48: 40 } }]), {
    threshold: 30,
  });
  const ledger = { sent: { [alertKey(day1[0])]: '2026-02-10T09:00:00Z' }, pending: [] };

  const laterSnap = {
    fetchedAt: '2026-02-12T08:00:00.000Z',
    regions: [
      {
        id: 'a',
        name: 'A',
        offMap: false,
        bulletinUrl: 'x',
        bulletin: { danger: 3, problems: [] },
        snow: { new48: 45 },
      },
    ],
  };
  const day3 = evaluateAlerts(laterSnap, { threshold: 30 });
  const { send } = selectSendable(day3, ledger, new Date(2026, 1, 12, 12));
  assert.equal(send.length, 1);
});

test('holds during quiet hours instead of dropping', () => {
  const alerts = evaluateAlerts(snapshot([{ id: 'a', name: 'A', snow: { new48: 40 } }]), {
    threshold: 30,
  });
  const { send, hold } = selectSendable(alerts, { sent: {}, pending: [] }, new Date(2026, 1, 10, 3));
  assert.equal(send.length, 0);
  assert.equal(hold.length, 1);
});

test('releases held alerts once quiet hours end, keeping the largest reading', () => {
  const held = [{ regionId: 'a', regionName: 'A', new48: 32, day: '2026-02-10', problems: [] }];
  const fresh = evaluateAlerts(snapshot([{ id: 'a', name: 'A', snow: { new48: 48 } }]), {
    threshold: 30,
  });
  const { send } = selectSendable(fresh, { sent: {}, pending: held }, new Date(2026, 1, 10, 7));
  assert.equal(send.length, 1, 'held and fresh alert for the same day must merge into one');
  assert.equal(send[0].new48, 48, 'the larger reading should win');
});

test('email names the danger level, and says so plainly when it is unknown', () => {
  const known = buildEmail([
    {
      regionName: 'Lyngen', new48: 45, new24: 20, depthCm: 180, danger: 4, dangerKnown: true,
      problems: ['Dry slab avalanche'], bulletinUrl: 'https://x', topTour: 'Rørnestinden',
    },
  ]);
  assert.match(known.text, /danger 4 \(High\)/);
  assert.match(known.text, /Dry slab avalanche/);
  assert.match(known.text, /bulletin/i);

  const unknown = buildEmail([
    { regionName: 'Abisko', new48: 40, new24: null, depthCm: null, danger: null, dangerKnown: false, problems: [], bulletinUrl: 'https://y', topTour: null },
  ]);
  assert.match(unknown.text, /not available/i);
  assert.doesNotMatch(unknown.text, /danger 0/);
});

test('push title is ascii-safe and mentions extra regions', () => {
  const push = buildPush([
    { regionName: 'Sunnmøre', new48: 50, danger: 3, dangerKnown: true, bulletinUrl: 'https://x' },
    { regionName: 'Romsdal', new48: 35, danger: 2, dangerKnown: true, bulletinUrl: 'https://y' },
  ]);
  assert.match(push.title, /\+1 more/);
  assert.ok(push.title.includes('50'));
});

test('notifications print whole centimetres, not model tenths', () => {
  const push = buildPush([{ regionName: 'Lyngen', new48: 45.3, danger: 4, dangerKnown: true, bulletinUrl: 'x' }]);
  assert.match(push.title, /^45 cm/);
  assert.doesNotMatch(push.body, /45\.3/);
  const mail = buildEmail([{ regionName: 'Lyngen', new48: 45.3, new24: 20.6, depthCm: 234.9, danger: 4,
    dangerKnown: true, problems: [], bulletinUrl: 'x', topTour: null }]);
  assert.match(mail.subject, /45 cm/);
  assert.match(mail.text, /\+45 cm new snow over 48 h \(21 cm in 24 h\)/);
  assert.match(mail.text, /235 cm base/);
});

test('ALERT_COUNTRIES limits which countries are notified', () => {
  const s = snapshot([
    { id: 'n', name: 'N', country: 'NO', snow: { new48: 40 } },
    { id: 's', name: 'S', country: 'SE', snow: { new48: 45 } },
  ]);
  assert.deepEqual(evaluateAlerts(s, { threshold: 30, countries: 'all' }).map((a) => a.regionId), ['s', 'n']);
  assert.deepEqual(evaluateAlerts(s, { threshold: 30, countries: 'no' }).map((a) => a.regionId), ['n']);
  assert.deepEqual(evaluateAlerts(s, { threshold: 30, countries: 'NO, SE' }).length, 2);
});
