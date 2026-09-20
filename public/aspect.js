import { parseAspect } from './planner.js';

/**
 * A small compass rose for a tour's descent aspect: the octants the skiing
 * faces are filled in ink. Reads the same "N–NE" / "varied" strings as the
 * planner, so what you see is what the avalanche filter tests.
 */
const OCT = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function aspectRose(aspect, { size = 16, labels = false } = {}) {
  const on = new Set(parseAspect(aspect));
  const varied = on.size === 8;
  const R = Math.PI / 180, r0 = labels ? 9 : 3.2, r1 = labels ? 30 : 7.6;
  const pt = (r, a) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
  const segs = OCT.map((d, i) => {
    const a0 = (i * 45 - 22.5 - 90) * R, a1 = (i * 45 + 22.5 - 90) * R;
    const fill = on.has(d) && !varied ? 'var(--ink)' : 'var(--paper)';
    return `<path d="M${pt(r0, a0)} L${pt(r1, a0)} A${r1} ${r1} 0 0 1 ${pt(r1, a1)} L${pt(r0, a1)} A${r0} ${r0} 0 0 0 ${pt(r0, a0)} Z" fill="${fill}" stroke="var(--steel)" stroke-width="${labels ? 0.8 : 0.5}"/>`;
  }).join('');
  const txt = labels
    ? ['N', 'E', 'S', 'W'].map((d, i) => {
        const a = (i * 90 - 90) * R;
        return `<text x="${(38 * Math.cos(a)).toFixed(1)}" y="${(38 * Math.sin(a) + 3.5).toFixed(1)}" text-anchor="middle" class="rosel">${d}</text>`;
      }).join('')
    : '';
  const box = labels ? 46 : 8.5;
  const title = varied ? 'Aspect: varied (tested against every avalanche problem)' : `Descent faces ${aspect}`;
  return (
    `<svg class="rose${labels ? ' big' : ''}" viewBox="${-box} ${-box} ${2 * box} ${2 * box}" width="${size}" height="${size}" role="img" aria-label="${title}">` +
    `<title>${title}</title>${segs}${txt}</svg>`
  );
}
