import axios, { AxiosRequestConfig } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as os from 'os';
import sharp from 'sharp';
import * as crypto from 'crypto';

dotenv.config();

const API_KEY = process.env.POKEMONTCG_API_KEY;
const POKEMONTCG_BASE_URL = process.env.POKEMONTCG_BASE_URL || 'https://api.pokemontcg.io/v2';

interface TCGSet {
  id: string;
  name: string;
  series: string;
  releaseDate?: string;
  total?: number;
  legalities?: any;
  ptcgoCode?: string;
  images?: {
    symbol?: string;
    logo?: string;
  }
}

interface PreSet {
  set_code: string;
  set_name: string;
  series: string;
  release_date: string | null;
  release_date_source: string | null;
  date_verified: boolean;
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function httpGetWithRetry<T>(url: string, cfg: AxiosRequestConfig, retries: number, baseDelayMs: number): Promise<T> {
  let attempt = 0;
  let lastErr: any;
  while (attempt <= retries) {
    try {
      const res = await axios.get(url, cfg);
      return res.data as T;
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;
      const timeout = err?.code === 'ECONNABORTED' || err?.message?.includes('timeout');
      const retriable = timeout || (status && (status === 429 || (status >= 500 && status < 600)));
      if (!retriable || attempt === retries) break;
      const jitter = randInt(250, 1250);
      const delay = Math.min(30000, Math.round(baseDelayMs * Math.pow(2, attempt)) + jitter);
      console.warn(`GET retry ${attempt + 1}/${retries} after ${delay}ms (status=${status || 'timeout'})`);
      await sleep(delay);
      attempt++;
    }
  }
  throw lastErr;
}

async function fetchAllSets(options?: { pageSize?: number; retries?: number; timeoutMs?: number; jitterMs?: number; cachePath?: string; }): Promise<TCGSet[]> {
  const allSets: TCGSet[] = [];
  let page = 1;
  const pageSize = options?.pageSize ?? 100; // start smaller to avoid CF triggers
  const retries = options?.retries ?? 4;
  const timeout = options?.timeoutMs ?? 45000;
  const baseDelay = options?.jitterMs ?? 1000;
  const cachePath = options?.cachePath;

  // Use cache if available
  if (cachePath && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as TCGSet[];
      if (Array.isArray(cached) && cached.length > 0) {
        console.log(`Loaded ${cached.length} sets from cache: ${cachePath}`);
        return cached;
      }
    } catch { /* ignore */ }
  }

  while (true) {
    try {
      console.log(`Fetching sets page ${page} (size ${pageSize})...`);
      // Avoid orderBy which may increase processing time server-side
      const data = await httpGetWithRetry<{ data: TCGSet[] }>(
        `${POKEMONTCG_BASE_URL}/sets`,
        {
          params: { pageSize, page },
          timeout,
          headers: {
            ...(API_KEY ? { 'X-Api-Key': API_KEY } : {}),
            'User-Agent': `CardMintCatalogBot/1.0 (+${os.hostname()})`,
            'Accept-Language': 'en-US,en;q=0.9',
          },
        },
        retries,
        baseDelay
      );

      const sets = data.data as TCGSet[];
      allSets.push(...sets);

      if (sets.length < pageSize) break;
      page++;

      // Add jittered delay to be respectful and avoid rate spikes
      await sleep(randInt(500, 2000));
    } catch (error) {
      console.error(`Error fetching page ${page}:`, (error as Error).message);
      // On persistent failure after retries, write partial cache then rethrow
      if (allSets.length > 0 && options?.cachePath) {
        try { fs.writeFileSync(options.cachePath, JSON.stringify(allSets, null, 2)); } catch {}
      }
      throw error;
    }
  }

  console.log(`Fetched ${allSets.length} total sets`);
  if (cachePath) {
    try { fs.writeFileSync(cachePath, JSON.stringify(allSets, null, 2)); } catch {}
  }
  return allSets;
}

// Optional hook: integrate a web scraper (e.g., Firecrawl) if desired.
// Keep this a no-op by default; merge from external CSV instead.
async function scrapeReleaseDate(_setCode: string, _setName: string): Promise<{ date: string | null, source: string | null }> {
  return { date: null, source: null };
}

function standardizeDate(dateStr: string): string | null {
  // Handle different date formats
  // e.g., "January 2022", "2022-01-01", "2022/01/01", "Jan 1 2022", "Jun-9-2023"
  const patterns = [
    /(\w+) (\d{1,2}),? (\d{4})/i, // Jan 1, 2022
    /(\w+) (\d{4})/i, // January 2022
    /(\d{4})-(\d{2})-(\d{2})/, // 2022-01-01
    /(\d{4})\/(\d{2})\/(\d{2})/, // 2022/01/01
    /(\w+)-(\d{1,2})-(\d{4})/i, // Jun-9-2023
  ];

  for (const pattern of patterns) {
    const match = dateStr.match(pattern);
    if (match) {
      if (/^\d{4}$/.test(match[1] || '') && match[2] && match[3]) {
        // ISO format
        return `${match[1]}-${match[2]}-${match[3]}`;
      } else if (match[1] && match[2]?.length === 4) {
        // Month Year
        const month = getMonthNumber(match[1]);
        if (month) {
          return `${match[2]}-${month.toString().padStart(2, '0')}-01`;
        }
      } else if (match[1] && match[2] && match[3]) {
        // Month Day Year
        const month = getMonthNumber(match[1]);
        if (month) {
          return `${match[3]}-${month.toString().padStart(2, '0')}-${match[2].padStart(2, '0')}`;
        }
      } else if (pattern.source.includes('\/') && match[1] && match[2] && match[3]) {
        // Slashed date already handled above (YYYY/MM/DD)
        return `${match[1]}-${match[2]}-${match[3]}`;
      }
    }
  }

  return null;
}

function getMonthNumber(monthStr: string): number | null {
  const months = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };
  return months[monthStr.toLowerCase() as keyof typeof months] || null;
}

type CsvRow = {
  set_code: string;
  set_name: string;
  series: string;
  release_date: string; // ISO YYYY-MM-DD or empty
  symbol_url: string;
  logo_url: string;
  icon_local_path: string;
  width_px: number;
  height_px: number;
  format: string;
  background: string;
  contrast_variant_path: string;
  sha256: string;
  source: string;
  license_notes: string;
};

function toCsvLine(fields: (string | number)[]): string {
  return fields
    .map((v) => {
      const s = String(v ?? '');
      if (s.includes('"') || s.includes(',') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    })
    .join(',');
}

function writeCsv(filePath: string, rows: CsvRow[]) {
  const header = [
    'set_code','set_name','series','release_date','symbol_url','logo_url','icon_local_path','width_px','height_px','format','background','contrast_variant_path','sha256','source','license_notes'
  ];
  const lines = [header.join(',')].concat(
    rows.map(r => toCsvLine([
      r.set_code, r.set_name, r.series, r.release_date, r.symbol_url, r.logo_url,
      r.icon_local_path, r.width_px, r.height_px, r.format, r.background,
      r.contrast_variant_path, r.sha256, r.source, r.license_notes
    ]))
  );
  fs.writeFileSync(filePath, lines.join('\n'));
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      args[k.replace(/^--/, '')] = v ?? true;
    }
  }
  return args;
}

function loadScrapedCsv(file: string): Map<string, Partial<CsvRow>> {
  if (!fs.existsSync(file)) return new Map();
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return new Map();
  const header = lines[0].split(',');
  const idx = (name: string) => header.indexOf(name);
  const map = new Map<string, Partial<CsvRow>>();
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    // naive CSV splitter for our controlled format (no embedded commas expected in set_code)
    const cols = [] as string[];
    let cur = '';
    let inQuotes = false;
    for (let c = 0; c < raw.length; c++) {
      const ch = raw[c];
      if (ch === '"') {
        if (inQuotes && raw[c+1] === '"') { cur += '"'; c++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        cols.push(cur); cur = '';
      } else { cur += ch; }
    }
    cols.push(cur);
    const set_code = cols[idx('set_code')];
    if (!set_code) continue;
    map.set(set_code, {
      release_date: cols[idx('release_date')] || undefined,
      source: cols[idx('source')] || undefined,
      series: cols[idx('series')] || undefined,
      set_name: cols[idx('set_name')] || undefined,
    });
  }
  return map;
}

async function main() {
  try {
  const args = parseArgs(process.argv);
  const csvOut = String(args['csv-out'] || path.join(process.cwd(), 'data', 'cardmint_set_catalog.csv'));
  const jsonOut = String(args['json-out'] || path.join(process.cwd(), 'data', 'preliminary_set_catalog.json'));
  const mergeCsv = typeof args['merge-scraped'] === 'string' ? String(args['merge-scraped']) : '';
  const offline = Boolean(args['offline']);
  const retries = Number(args['retries'] || 4);
  const timeoutMs = Number(args['timeout-ms'] || 45000);
  const pageSize = Number(args['page-size'] || 100);
  const cachePath = String(args['cache'] || path.join(process.cwd(), 'data', 'pokemontcg_sets.cache.json'));
  const fetchIcons = Boolean(args['fetch-icons']);
  const assetRoot = String(args['asset-root'] || path.join('data', 'set_icons'));
  const verifyUrls = args['verify-urls'] ? Number(args['verify-urls']) || 20 : 0; // sample size
  const scalesArg = String(args['scales'] || '0.75,1.0,1.25');
  const nccThreshold = Number(args['ncc-threshold'] || 0.78);
  const emitManifest = Boolean(args['emit-manifest']);
  const force = Boolean(args['force']);

    if (!API_KEY) {
      console.warn('POKEMONTCG_API_KEY not set; attempting unauthenticated calls to PokemonTCG API');
    }

    // Ensure output directories exist
    const ensureDir = (p: string) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {} };
    ensureDir(csvOut); ensureDir(jsonOut);

    let sets: TCGSet[] = [];
    if (!offline) {
      console.log('Fetching all sets from PokemonTCG.io...');
      sets = await fetchAllSets({ pageSize, retries, timeoutMs, cachePath });
    } else {
      console.log('Offline mode: skipping API fetch.');
      if (fs.existsSync(cachePath)) {
        try {
          sets = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as TCGSet[];
          console.log(`Loaded ${sets.length} sets from cache.`);
        } catch {
          console.warn('Cache unreadable; proceeding with merge-only.');
        }
      }
    }

    // For CardMint, keep all English-coded sets (PokemonTCG.io v2 dataset is English-centric).
    // Do not drop pre-2020 sets.
    const englishSets = sets.length > 0 ? sets : []; // may be empty in offline/merge-only mode
    console.log(`Found ${englishSets.length} sets total`);

    // Optional sampling for scraper verification (kept but disabled by default)
    const diverseSets: TCGSet[] = [];

    const catalog: PreSet[] = [];

    for (let i = 0; i < englishSets.length; i++) {
      const set = englishSets[i];
      const preSet: PreSet = {
        set_code: set.id,
        set_name: set.name,
        series: set.series,
        release_date: null,
        release_date_source: null,
        date_verified: false,
      };

      // If set has releaseDate from API, use it
      if (set.releaseDate) {
        preSet.release_date = standardizeDate(set.releaseDate) || set.releaseDate;
        preSet.release_date_source = 'pokemontcgapi';
        preSet.date_verified = false; // API date, not verified from source
      } else {
        // If it's one of the diverse sets, try to scrape
        const diverseIndex = diverseSets.findIndex(ds => ds.id === set.id);
        if (diverseIndex !== -1) {
          console.log(`[${i+1}/${englishSets.length}] Scraping ${set.name}...`);
          const { date, source } = await scrapeReleaseDate(set.id, set.name);
          if (date) {
            preSet.release_date = date;
            preSet.release_date_source = source;
            preSet.date_verified = true;
          }

          // Delay to be respectful
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      catalog.push(preSet);
    }

    // Merge scraped CSV if provided
    const scraped = mergeCsv ? loadScrapedCsv(mergeCsv) : new Map();

    // Build CardMint CSV rows
    // If API produced no sets (offline + no cache), fall back to merge-only rows
    const baseCodes: string[] = englishSets.length > 0
      ? englishSets.map(s => s.id)
      : Array.from(scraped.keys());

    const rows: CsvRow[] = baseCodes.map((code) => {
      const set = englishSets.find(s => s.id === code);
      const symbolUrl = set?.images?.symbol || `https://images.pokemontcg.io/${code}/symbol.png`;
      const logoUrl = set?.images?.logo || `https://images.pokemontcg.io/${code}/logo.png`;
      const preset = catalog.find(p => p.set_code === code);
      const override = scraped.get(code) || {};
      const date = (override.release_date as string | undefined) || preset?.release_date || '';
      const isoDate = date ? (standardizeDate(date) || date) : '';
      const name = (override.set_name as string | undefined) || set?.name || code;
      const series = (override.series as string | undefined) || set?.series || '';
      const source = (override.source as string | undefined) || (preset?.release_date_source === 'pokemontcgapi' ? 'icon: PokemonTCG.io; release: PokemonTCG API' : 'icon: PokemonTCG.io');
      const license = 'Official Pokémon assets used for internal research (icons via PokemonTCG.io). Bulbapedia CC BY-NC-SA; DigitalTQ is fan-run; cross-verified.';
      const iconRel = path.posix.join(assetRoot.replace(/\\/g, '/'), `${code}.png`);
      const contrastRel = path.posix.join(assetRoot.replace(/\\/g, '/'), 'contrast', `${code}.png`);
      return {
        set_code: code,
        set_name: name,
        series,
        release_date: isoDate,
        symbol_url: symbolUrl,
        logo_url: logoUrl,
        icon_local_path: iconRel,
        width_px: 128,
        height_px: 128,
        format: 'png',
        background: 'transparent',
        contrast_variant_path: contrastRel,
        sha256: '',
        source,
        license_notes: license,
      };
    });

    // Output JSON (preliminary) and CSV (CardMint schema)
    fs.writeFileSync(jsonOut, JSON.stringify(catalog, null, 2));

    // Optional: Verify URLs on a sample
    if (verifyUrls && rows.length > 0) {
      console.log(`Verifying URLs (sample size=${verifyUrls})...`);
      const sample = rows.slice(0, verifyUrls);
      for (const r of sample) {
        try {
          await axios.head(r.symbol_url, { timeout: 10000 });
        } catch (e: any) {
          console.warn(`symbol_url HEAD failed for ${r.set_code}: ${e?.response?.status || e?.message}`);
        }
        try {
          await axios.head(r.logo_url, { timeout: 10000 });
        } catch (e: any) {
          console.warn(`logo_url HEAD failed for ${r.set_code}: ${e?.response?.status || e?.message}`);
        }
      }
    }

    // Optional: Fetch/normalize icons and compute hashes
    if (fetchIcons) {
      const outDir = path.join(process.cwd(), assetRoot);
      const contrastDir = path.join(outDir, 'contrast');
      try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
      try { fs.mkdirSync(contrastDir, { recursive: true }); } catch {}

      const concurrency = 6;
      let index = 0;
      async function work() {
        while (true) {
          const i = index++;
          if (i >= rows.length) return;
          const r = rows[i];
          const absIcon = path.join(process.cwd(), r.icon_local_path);
          const absContrast = path.join(process.cwd(), r.contrast_variant_path);
          const exists = fs.existsSync(absIcon);
          if (exists && !force) {
            // compute hash if missing
            if (!r.sha256) {
              const buf = fs.readFileSync(absIcon);
              r.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
            }
            continue;
          }
          try {
            const resp = await axios.get(r.symbol_url, { responseType: 'arraybuffer', timeout: 20000 });
            const src = Buffer.from(resp.data);
            // Normalize to 128x128 with transparent padding
            const norm = await sharp(src)
              .resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
              .png()
              .toBuffer();
            const hash = crypto.createHash('sha256').update(norm).digest('hex');
            r.sha256 = hash;
            fs.writeFileSync(absIcon, norm);
            // Contrast (grayscale + threshold)
            const hc = await sharp(norm)
              .greyscale()
              .normalize()
              .threshold(160)
              .png()
              .toBuffer();
            fs.writeFileSync(absContrast, hc);
            process.stdout.write(`.`);
          } catch (e: any) {
            console.warn(`\nicon fetch failed for ${r.set_code}: ${e?.response?.status || e?.message}`);
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, work));
      console.log(`\nIcon fetch/normalize completed.`);
    }

    // Emit CSV (after optional icon processing to include sha256)
    writeCsv(csvOut, rows);

    // Optional: emit simple manifest for NCC
    if (emitManifest) {
      const scales = scalesArg.split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n) && n > 0);
      const manifest = Object.fromEntries(rows.map(r => [r.set_code, {
        icon_path: r.icon_local_path,
        contrast_path: r.contrast_variant_path,
        scales,
        ncc_threshold: nccThreshold,
      }]));
      const manifestPath = path.join(process.cwd(), 'data', 'set_icons', 'manifest.json');
      try { fs.mkdirSync(path.dirname(manifestPath), { recursive: true }); } catch {}
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(`Manifest written to: ${manifestPath}`);
    }

    console.log(`\nCompleted!`);
    console.log(` - Wrote preliminary JSON to: ${jsonOut}`);
    console.log(` - Wrote CardMint CSV to: ${csvOut}`);
    console.log(`Dates present for ${catalog.filter(s => !!s.release_date).length} sets`);
    console.log(`Rows written: ${rows.length}`);

  } catch (error) {
    console.error('Error in main:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
