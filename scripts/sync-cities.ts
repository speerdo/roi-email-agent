// scripts/sync-cities.ts
//
// Fetch https://www.recycleoldtech.com/api/cities-data and overwrite
// assets/city-index.json with the result, after validating the payload so
// a bad deploy of the site can't poison the agent's reply path.
//
// Validation (SPEC §2.5):
//   - >= 4,000 records (the site had 4,457 at last sync; a sudden drop
//     below 4k is almost certainly a site bug, not a real shrinkage)
//   - >= 50 distinct states
//   - every url matches ^/states/[a-z0-9-]+/[a-z0-9-]+$
// On any failure, abort WITHOUT overwriting the committed snapshot so
// the agent keeps using the last-known-good index until the site is fixed.
//
//   npm run sync:cities
//
// Add to the release checklist or run monthly; the site is statically
// generated so the city set changes rarely.

import { writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, '../assets/city-index.json');
const ENDPOINT = 'https://www.recycleoldtech.com/api/cities-data';

const MIN_RECORDS = 4000;
const MIN_STATES = 50;
const URL_SHAPE = /^\/states\/[a-z0-9-]+\/[a-z0-9-]+$/;

interface CityIndexEntry {
  city: string;
  state: string;
  url: string;
  coordinates?: { lat: number; lng: number };
}

async function main(): Promise<void> {
  console.log(`Fetching ${ENDPOINT}...`);
  const res = await fetch(ENDPOINT);
  if (!res.ok) {
    throw new Error(`fetch failed: HTTP ${res.status} ${res.statusText}`);
  }
  const text = await res.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const e = err as Error;
    throw new Error(`response is not valid JSON: ${e.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`response is not a JSON array (got ${typeof parsed})`);
  }
  const entries = parsed as CityIndexEntry[];

  // 1. Record count.
  if (entries.length < MIN_RECORDS) {
    throw new Error(
      `record count ${entries.length} is below the ${MIN_RECORDS} floor — site may be broken. Aborting without overwriting the snapshot.`,
    );
  }

  // 2. Distinct states.
  const states = new Set<string>();
  for (const e of entries) {
    if (typeof e.state === 'string' && e.state.length > 0) states.add(e.state.toLowerCase());
  }
  if (states.size < MIN_STATES) {
    throw new Error(
      `distinct state count ${states.size} is below the ${MIN_STATES} floor — site may be broken. Aborting without overwriting the snapshot.`,
    );
  }

  // 3. URL shape. Every entry must have a string url matching the
  //    /states/{slug}/{slug} shape.
  let badUrls = 0;
  const badUrlSamples: string[] = [];
  for (const e of entries) {
    if (typeof e.url !== 'string' || !URL_SHAPE.test(e.url)) {
      badUrls++;
      if (badUrlSamples.length < 5) {
        badUrlSamples.push(`city="${e.city}" state="${e.state}" url="${e.url}"`);
      }
    }
  }
  if (badUrls > 0) {
    throw new Error(
      `${badUrls} entries have a malformed url (expected ${URL_SHAPE}). Samples:\n  ` +
      badUrlSamples.join('\n  ') +
      '\nAborting without overwriting the snapshot.',
    );
  }

  // 4. City/state field presence.
  let missingFields = 0;
  for (const e of entries) {
    if (typeof e.city !== 'string' || e.city.length === 0 ||
        typeof e.state !== 'string' || e.state.length === 0) {
      missingFields++;
    }
  }
  if (missingFields > 0) {
    throw new Error(
      `${missingFields} entries have an empty city or state field. Aborting without overwriting the snapshot.`,
    );
  }

  // All validations passed. Compare to the existing snapshot so we can
  // report the delta; only overwrite if something actually changed.
  let prevCount: number | null = null;
  try {
    const prev = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as unknown;
    if (Array.isArray(prev)) prevCount = prev.length;
  } catch {
    // No existing snapshot — first sync.
  }

  writeFileSync(INDEX_PATH, text);
  console.log(
    `Wrote ${entries.length} records to ${INDEX_PATH} ` +
    `(states: ${states.size}, prev: ${prevCount ?? 'none'}).`,
  );
}

main().catch((err) => {
  console.error('sync-cities failed:', (err as Error).message);
  process.exit(1);
});