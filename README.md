# CardMint Set Catalog & Icon Templates

This repository now includes a robust pipeline to build a Pokémon TCG set catalog and precomputed icon templates for passive OCR/ROI.

What’s Included
- Catalogs (under `./data/`):
  - `cardmint_set_catalog.csv` — 168 sets, ISO dates, icon paths, SHA‑256.
  - `preliminary_set_catalog.json` — API snapshot for inspection.
  - `pokemontcg_sets.cache.json` — cached API fetch for resume/offline.
- Icons & Manifest:
  - `data/set_icons/*.png` — normalized 128×128 symbols (transparent background).
  - `data/set_icons/contrast/*.png` — high‑contrast templates for NCC.
  - `data/set_icons/manifest.json` — `{ set_code → { icon_path, contrast_path, scales, ncc_threshold } }`.

Build Script
- Source: `src/scripts/compile-set-catalog.ts`
- Capabilities: retries/backoff (Cloudflare‑aware), cache/resume, offline/merge‑only, date normalization, optional URL verification, icon fetch/normalize, manifest emission.

Typical Rebuild
```
npx tsx src/scripts/compile-set-catalog.ts \
  --merge-scraped=/home/profusionai/Downloads/sample_catalog.csv \
  --cache=./data/pokemontcg_sets.cache.json \
  --page-size=250 --retries=5 --timeout-ms=60000 \
  --csv-out=./data/cardmint_set_catalog.csv \
  --json-out=./data/preliminary_set_catalog.json \
  --verify-urls=5 --fetch-icons --emit-manifest \
  --asset-root=data/set_icons
```

Set Icon Preload Helper
- Source: `src/services/sets/set-icon-matcher.ts`
- Usage:
```
import { preloadSetIconTemplates, summarizeTemplates, getTemplate } from '@/services/sets/set-icon-matcher';

const templates = await preloadSetIconTemplates('data/set_icons/manifest.json');
console.log('templates:', summarizeTemplates(templates));

const base1 = getTemplate(templates, 'base1');
// base1.icon (Buffer), base1.contrast (Buffer), base1.config.scales, base1.config.ncc_threshold
```

Why This Matters
- Pre‑SV: deterministic symbol matching via NCC across a few preset scales.
- SV: use catalog (series/era) to route to OCR of set code/regulation marks.
- Resilience: cache + offline/merge ensures builds even under API throttling.

Licensing
- Icons: Official Pokémon assets via PokemonTCG.io CDN; internal research only.
- Bulbapedia: CC BY‑NC‑SA; DigitalTQ for cross‑verification.

