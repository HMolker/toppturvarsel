import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { slugify } from './util/gpx.js';

/**
 * Your own photos for a tour, made with the tour editor (editor/):
 *
 *   data/photos/<tour-slug>/photos.json     the list, captions and positions
 *   data/photos/<tour-slug>/01-summit.jpg   the images (metadata stripped)
 *
 * The folder is mounted read-only into the container, like data/tracks, so
 * adding photos needs no rebuild.
 *
 * The position of each photo lives in photos.json, not in the image file:
 * the editor re-encodes images, which removes EXIF (including GPS) from the
 * files themselves. `useLocation: false` in the list keeps a photo off the
 * map even if its position is known.
 *
 * Only files named in photos.json, with a plain file name and an image
 * extension, are ever served: no path from the request reaches the disk.
 */

const MAX_PHOTOS = 60;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(jpe?g|png|webp)$/i;
const TYPE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const dirFor = (tour) => path.resolve(config.dataDir, 'photos', slugify(tour.name));
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Validate one manifest entry; returns null for anything unusable. */
export function cleanEntry(p) {
  if (!p || typeof p !== 'object' || !SAFE_NAME.test(p.file ?? '')) return null;
  const lat = finite(p.lat), lon = finite(p.lon);
  const located = lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const use = p.useLocation !== false && located;
  return {
    file: p.file,
    caption: text(p.caption, 300),
    credit: text(p.credit, 120),
    takenAt: /^\d{4}-\d\d-\d\dT[\d:]{8}/.test(p.takenAt ?? '') ? p.takenAt.slice(0, 25) : null,
    width: finite(p.width),
    height: finite(p.height),
    // Position, when the photo carried one and you chose to use it.
    lat: use ? lat : null,
    lon: use ? lon : null,
    ele: use ? finite(p.ele) : null,
    direction: use ? finite(p.direction) : null,
    located: use,
  };
}

async function readManifest(tour) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path.join(dirFor(tour), 'photos.json'), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : raw?.photos;
  return (Array.isArray(list) ? list : []).slice(0, MAX_PHOTOS).map(cleanEntry).filter(Boolean);
}

/** The list for the tour panel; entries whose file is missing are dropped. */
export async function getOwnPhotos(tour) {
  const list = await readManifest(tour);
  const present = await Promise.all(
    list.map((p) => stat(path.join(dirFor(tour), p.file)).then((s) => s.isFile(), () => false))
  );
  return {
    tour: tour.name,
    photos: list.filter((_, k) => present[k]).map((p, i) => ({ ...p, i })),
  };
}

/** Photo #i of a tour's own list, or null. */
export async function getOwnPhotoFile(tour, i) {
  const { photos } = await getOwnPhotos(tour);
  const p = photos[i];
  if (!p) return null;
  const ext = p.file.split('.').pop().toLowerCase();
  return { body: await readFile(path.join(dirFor(tour), p.file)), type: TYPE[ext] };
}
