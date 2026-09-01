/**
 * Loads the Regina gazetteer.
 *
 *   npm run seed:regina -- --dry-run              inspect without writing
 *   npm run seed:regina -- --boundaries <url|file>
 *   npm run seed:regina -- --addresses <url|file>
 *   npm run seed:regina                           both, from the default URLs
 *
 * Boundaries load first and addresses second, because each address is
 * assigned its neighbourhood at ingest by point-in-polygon — running them the
 * other way round leaves every address unassigned.
 *
 * A local file is accepted anywhere a URL is, which matters: the dataset can
 * be downloaded once by hand and replayed, and it is the only way to run this
 * from a network that cannot reach open.regina.ca.
 *
 * --dry-run is not decoration. The ArcGIS attribute names are a best guess
 * (see ingest.ts), so the first thing to do against a real endpoint is print
 * what parsed, what was skipped, and which fields nothing recognized.
 */
import { readFile } from 'node:fs/promises';
import { createPool } from '../db/pool.js';
import {
  REGINA_SOURCE,
  fetchArcGisPages,
  loadAddressPoints,
  loadBoundaries,
  parseAddressPoints,
  parseBoundaries,
  recordIngest,
  type RawAddressPoint,
  type RawBoundary,
} from '../modules/geo/ingest.js';
import { REGINA_BBOX } from '../modules/geo/polygon.js';

/**
 * Default endpoints.
 *
 * UNVERIFIED: outbound access to open.regina.ca is blocked from the
 * environment this was written in, so these paths could not be confirmed
 * against the live catalogue. Treat them as a starting point — find the
 * current FeatureServer layer URLs at regina.ca/city-government/open-data and
 * pass them explicitly if these 404.
 */
const DEFAULTS = {
  addresses: 'https://open.regina.ca/arcgis/rest/services/Address_Points/FeatureServer/0/query',
  boundaries: 'https://open.regina.ca/arcgis/rest/services/Community_Associations/FeatureServer/0/query',
};

interface Args {
  dryRun: boolean;
  addresses: string | null;
  boundaries: string | null;
  limitPages: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false, addresses: null, boundaries: null, limitPages: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--addresses') args.addresses = argv[++i] ?? null;
    else if (a === '--boundaries') args.boundaries = argv[++i] ?? null;
    else if (a === '--max-pages') args.limitPages = Number(argv[++i] ?? '200') || 200;
  }
  if (!args.addresses && !args.boundaries) {
    args.addresses = DEFAULTS.addresses;
    args.boundaries = DEFAULTS.boundaries;
  }
  return args;
}

const isUrl = (s: string): boolean => /^https?:\/\//i.test(s);

/** Reads every page from a URL, or the whole document from a file. */
async function* pagesFrom(source: string, maxPages: number): AsyncGenerator<unknown> {
  if (!isUrl(source)) {
    yield JSON.parse(await readFile(source, 'utf8'));
    return;
  }
  yield* fetchArcGisPages(source, {
    fetchImpl: (url) => fetch(url) as never,
    maxPages,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl && !args.dryRun) {
    console.error('DATABASE_URL is required (or pass --dry-run).');
    process.exit(1);
  }

  const boundaries: RawBoundary[] = [];
  const addresses: RawAddressPoint[] = [];
  const unmapped = new Set<string>();
  const skipTally: Record<string, number> = {};

  if (args.boundaries) {
    console.log(`boundaries: reading ${args.boundaries}`);
    for await (const page of pagesFrom(args.boundaries, args.limitPages)) {
      const parsed = parseBoundaries(page);
      boundaries.push(...parsed.records);
      for (const f of parsed.unmappedFields) unmapped.add(`boundaries.${f}`);
      for (const s of parsed.skipped) {
        skipTally[`boundaries.${s.reason}`] = (skipTally[`boundaries.${s.reason}`] ?? 0) + 1;
      }
    }
    console.log(`boundaries: parsed ${boundaries.length}`);
  }

  if (args.addresses) {
    console.log(`addresses: reading ${args.addresses}`);
    for await (const page of pagesFrom(args.addresses, args.limitPages)) {
      // The region check is what catches a projection or axis-order change:
      // both fail silently, and both put every point somewhere impossible.
      const parsed = parseAddressPoints(page, { region: REGINA_BBOX });
      addresses.push(...parsed.records);
      for (const f of parsed.unmappedFields) unmapped.add(`addresses.${f}`);
      for (const s of parsed.skipped) {
        skipTally[`addresses.${s.reason}`] = (skipTally[`addresses.${s.reason}`] ?? 0) + 1;
      }
    }
    console.log(`addresses: parsed ${addresses.length}`);
  }

  console.log('\n── what was skipped ──');
  if (Object.keys(skipTally).length === 0) console.log('  nothing');
  for (const [reason, n] of Object.entries(skipTally)) console.log(`  ${reason}: ${n}`);

  console.log('\n── source fields nothing mapped to ──');
  // Worth reading every time: a field named here may be the address column
  // under a name the candidate lists do not know, and the fix is to add it.
  console.log(unmapped.size === 0 ? '  none' : `  ${[...unmapped].join(', ')}`);

  if (args.dryRun) {
    console.log('\n── first three of each ──');
    for (const b of boundaries.slice(0, 3)) console.log(`  boundary: ${b.name} (${b.city})`);
    for (const a of addresses.slice(0, 3)) {
      console.log(`  address:  ${a.fullAddress} @ ${a.lat.toFixed(5)},${a.lng.toFixed(5)}`);
    }
    console.log('\ndry run: nothing written.');
    return;
  }

  const db = await createPool(databaseUrl!);
  try {
    if (boundaries.length > 0) {
      const summary = await loadBoundaries(db, boundaries);
      await recordIngest(db, {
        source: REGINA_SOURCE, dataset: 'neighbourhoods',
        url: args.boundaries, summary,
      });
      console.log(`\nboundaries: wrote ${summary.written}`);
    }
    if (addresses.length > 0) {
      const summary = await loadAddressPoints(db, addresses);
      await recordIngest(db, {
        source: REGINA_SOURCE, dataset: 'address_points',
        url: args.addresses, summary,
      });
      console.log(`addresses: wrote ${summary.written}`);
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
