Here's a practical, production-minded OCR pipeline for CardMint that balances ambitious architectural goals with incremental implementation reality. Based on Phase 1 successful deployment, this enhanced approach emphasizes "working the dough" - continuous improvement through measured, reversible optimizations rather than risky wholesale changes.

# CardMint OCR Enhanced: Phased Implementation Strategy

## Implementation Philosophy: "Working the Dough"

**Phase 1 Achievement**: Successfully deployed persistent FastAPI service with 32% performance improvement (26.2s → 17.7s) while maintaining 96.4% accuracy. **Production-ready baseline established**.

**Going Forward**: Each enhancement is a small, measurable "kneading motion" that compounds into significant gains without destabilizing the working system.

## Phase Framework: Risk-Managed Progression

### Phase 1: Foundation ✅ COMPLETE
**Achieved**: Persistent FastAPI OCR service
- ✅ 32% performance improvement (26.2s → 17.7s)
- ✅ 96.4% accuracy maintained
- ✅ Production architecture: health checks, error handling, monitoring
- ✅ Model persistence: No re-initialization per request

### Phase 2: Low-Risk Optimizations 🟢 CURRENT
**Target**: 67% improvement (<12 seconds total)
- **Quality-based preprocessing**: Skip heavy enhancement for high-quality Pokemon cards
- **ROI-focused processing**: Process only essential card regions
- **Multi-pass optimization**: Intelligent pass selection based on confidence
- **Parameter tuning**: Conservative PaddleOCR optimization

### Phase 3: Advanced Techniques 🟡 FUTURE
**Target**: <3 seconds (final production target)
- **ONNX conversion**: 7-15x speed potential with model conversion
- **Hardware acceleration**: GPU inference where available
- **Alternative engines**: Tesseract LSTM, specialized models

---

## Current Architecture: Proven Foundation

### 0) Service Infrastructure ✅ DEPLOYED
* **FastAPI Service**: `http://localhost:8000` with `/health`, `/ocr`, `/metrics` endpoints
* **Persistent OCR**: Single PaddleOCR instance shared across requests
* **Error Isolation**: Service failures don't affect camera capture pipeline
* **Monitoring**: Health checks and performance metrics operational

---

## Phase 2 Implementation: Practical Optimizations 🟢

### Current Working Approach (Phase 1)
```python
# FastAPI Service with Persistent PaddleOCR
@app.post("/ocr")
async def process_ocr(file: UploadFile):
    result = ocr_service.process_card(image_path, high_accuracy=True)
    # Currently: 17.7 seconds, 96.4% accuracy
```

### Phase 2A: Quality-Based Preprocessing (Target: -3s)
**Concept**: Pokemon cards from camera capture are typically high-quality. Skip aggressive enhancement for these images.

```python
def smart_preprocess(image_path: str) -> np.ndarray:
    img = cv2.imread(image_path)
    
    # Quick quality assessment
    blur_score = cv2.Laplacian(img, cv2.CV_64F).var()
    brightness = np.mean(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
    
    if blur_score > 500 and 40 < brightness < 220:
        # High quality: minimal processing
        return img  # Skip denoising, CLAHE, sharpening
    else:
        # Standard processing for lower quality images
        return current_preprocess_pipeline(img)
```

### Phase 2B: Single-Pass Optimization (Target: -2s)
**Concept**: High-confidence results don't need second pass validation.

```python
def intelligent_pass_strategy(image_path: str) -> Dict:
    # First pass with confidence threshold
    result = self.ocr.predict(enhanced_img)
    avg_confidence = calculate_confidence(result)
    
    if avg_confidence > 0.92:
        return result  # Skip second pass
    else:
        # Second pass with different preprocessing
        return multi_pass_processing(image_path)
```

### Phase 2C: ROI-Focused Processing (Target: -2s)
**Concept**: Pokemon cards have predictable layouts. Process essential regions only.

```python
def roi_focused_ocr(image: np.ndarray) -> Dict:
    # Define Pokemon card regions (percentages of card dimensions)
    regions = {
        'name': (0.05, 0.02, 0.70, 0.15),      # Top-left name area
        'hp': (0.75, 0.02, 0.95, 0.15),        # Top-right HP
        'attacks': (0.05, 0.55, 0.95, 0.80),   # Middle attacks section  
        'footer': (0.05, 0.85, 0.95, 0.98)     # Bottom metadata
    }
    
    results = {}
    for region_name, (x1, y1, x2, y2) in regions.items():
        roi = extract_roi(image, x1, y1, x2, y2)
        results[region_name] = self.ocr.predict(roi)
    
    return combine_roi_results(results)
```

### Phase 2 Combined Impact Estimation
```
Current Performance:     17.7 seconds
- Quality optimization:  -3.0 seconds → 14.7s
- Single-pass logic:     -2.0 seconds → 12.7s  
- ROI processing:        -2.0 seconds → 10.7s
Target Achievement:      <12 seconds ✅
```

---

## Advanced Architecture (Phase 3): Future Potential

### 1) Detection (find the card + fix geometry)
**Goal:** tight, rectified, upright card crop with corner coordinates.
**Status**: Deferred to Phase 3 - camera provides good captures currently

### 2) Layout Classification (Phase 3)
**Goal**: Identify Pokemon card template for optimal ROI mapping
**Implementation**: Only if Phase 2 ROI approach proves insufficient

### 3) High-Performance Recognition (Phase 3)
**ONNX Conversion Path** (when Phase 2 plateau is reached):
- Convert PaddleOCR models to ONNX format
- Deploy with OpenVINO or ONNX Runtime  
- Expected: 7-15x speed improvement
- Risk: Accuracy validation required, complex deployment

---

## 2) Layout Classification (choose the right ROI map)

**Why:** Pokémon card templates vary (Pokémon basic/stage, Trainer, Energy, EX/GX/V/VMAX/VSTAR, full-art). Each has different text zones.

* Train a small classifier on full-card thumbnails into 6–10 layout classes.
* Confidence `p_layout`. If `p_layout < 0.8`, choose “generic” ROI map and add a penalty to downstream confidences.

**Outputs:** `layout_class`, `p_layout`.

---

## 3) Region Proposal (ROI slicing)

Define normalized ROIs (percent coordinates) per `layout_class`. Minimal first set:

* **Name** (top left band)
* **HP** (top right)
* **Stage** (“Basic”, “Stage 1”, “Stage 2”)
* **Type icon** (sprite classifier, not OCR)
* **Moves/Abilities block** (one or two lines per move name; costs and damage sit to the right)
* **Set symbol + rarity icon** (classify icon sprite)
* **Collector number** (e.g., `102/108`, `SVP`, `TG`, etc.)
* **Regulation mark** (`D, E, F, G, H`)
* **Year & copyright block** (bottom microtext)
* **Illustrator** (“Illus. X”)
* **Language tag** (weak classifier from copyright/microtext)

Keep ROIs generous; you’ll refine after a few hundred samples.

---

## 4) Preprocessing (per-ROI, not global)

Per ROI:

* **Denoise:** fast bilateral filter or tiny non-local means.
* **Contrast:** CLAHE (clip 2.0) only if dynamic range low.
* **Binarize?** Only for small numeric zones (HP, collector number). Avoid for prose (names/moves).
* **Sharpen:** unsharp mask (σ=1.2, amount 1.5).
* **Scale:** upsample small ROIs to 32–48 px cap height (super helpful for collector numbers).
* **Skew:** deskew via minAreaRect for the ROI.
* **Morphology:** for digits, light open/close to separate touching characters.

---

## 5) Recognition (two-pass, confidence-gated)

**Engines:**

* **Primary:** PaddleOCR (DBNet + CRNN/SAR, Latin only). Fast, great on mixed typography.
* **Secondary (on demand):** Tesseract LSTM with tailored language packs:

  * `eng_best` for prose
  * `eng_digits` for numbers-only zones (HP, collector number, damage)
  * Set `tessedit_char_whitelist` per field.

**Pass A (fast):**

* Run Paddle on all ROIs concurrently.
* For numeric ROIs (HP, collector number, damage), also run Tesseract digits-only and **vote**:

  * If both agree (Levenshtein dist ≤ 1), boost confidence; else keep the higher-conf result.

**Pass B (slow; only for medium/low):**

* Re-preprocess with stronger denoise/CLAHE, rotate ±1.5°, ±3.0° micro-rotations.
* Try alternate ROI paddings (±5–8%).
* Run both engines; keep best by confidence.

**Outputs per ROI:** `text`, `p_engine`, `p_text` (engine score), `alt_texts[]`, `bbox`, `engine_used`, `preproc_profile`.

---

## 6) Post-processing (Pokémon-aware normalization)

**Field grammar checks:**

* **Collector number:** regex `^([A-Z]{0,3}-)?\d{1,3}/\d{1,3}([A-Z]{1,3})?$` (+ modern subsets like `SV??`, `TG`, `GG`, `RC`, `CSR`, promos `SWSH###`, `SVP #`).
* **HP:** `^(10|2\d|[3-9]\d{2})$` but clamp to plausible set-era ranges (e.g., ≤ 340 except special).
* **Regulation:** `^[D-H]$` (expand as new letters appear).
* **Illustrator:** strip “Illus.”; Title Case.

**Lexicons (stored locally, versioned):**

* **Card names** (English; optionally JP): \~15–20k entries total across sets/prints.
* **Moves & Abilities vocabulary** (with fuzzy matching).
* **Set dictionary**: set name ↔ code ↔ series ↔ release year.
* **Rarity classes**: symbol classifier mapping to `Common/Uncommon/Rare/...`.
* **Type names**: `Grass, Fire, Water, Lightning, Psychic, Fighting, Darkness, Metal, Dragon, Fairy, Colorless`.

**Fuzzy correction (only when `0.7 ≤ p_text < 0.92`):**

* RapidFuzz partial\_ratio against the relevant lexicon, constrained by **layout** and **era** (use regulation mark or year zone to bound candidates).
* If best match ≥ 92 and edit distance ≤ 2 → snap to lexicon, set `p_norm = max(p_text, 0.94)` and record `correction`.
* Otherwise keep raw, mark `needs_review`.

**Cross-field validation:**

* The tuple **(name, set\_code, collector\_number)** should resolve uniquely to a **print\_id** in your master catalogue.
* If **set\_code** unknown but collector number matches a set’s denominator, infer candidate sets; compute joint score and choose argmax if margin ≥ 0.06.

---

## 7) Validation & Confidence Triage

Define **field-level** and **record-level** confidences.

**Field score:**
`p_field = w_engine*p_text + w_lex*p_lex + w_grammar*p_grammar + w_layout*p_layout`
Typical weights: `w_engine=0.55, w_lex=0.25, w_grammar=0.10, w_layout=0.10`.

**Record score:**
`p_record = weighted_mean(p_field, weights by field importance)`
Importance: `name=3, set_code=3, collector_number=3, hp=1, rarity=1, illustrator=1, regulation=1, moves=2`.

**Tiers:**

* **High (keep):** `p_record ≥ 0.92` and no critical field < 0.85.
* **Medium (lexicon/second pass):** `0.75 ≤ p_record < 0.92` or any critical field 0.65–0.85.
* **Low (filter/flag):** `p_record < 0.75` or grammar violation on critical fields.

**Medium handling:** run Pass B; re-score. If still medium, emit a **candidate set** (top-k prints) for human pick in UI.

**Low handling:** push to **review queue** with thumbnails of problematic ROIs and suggested lexicon candidates.

---

## 8) Entity Resolution & DB Preprocessing

**Schema sketch (Postgres):**

* `scans(scan_id PK, src_path, captured_ts, camera_meta JSONB, phash, geometry JSONB, layout_class, p_layout, pipeline_version, geometry_quality)`
* `ocr_fields(scan_id FK, field_name, raw_text, norm_text, p_text, p_field, bbox, engine_used, preproc_profile, corrections JSONB, alt_texts JSONB)`
* `prints(print_id PK, name, set_code, collector_number, rarity, type, regulation, series, release_year, language, illustrator, …)` ← your catalogue
* `resolutions(scan_id FK, print_id FK, p_record, tier, resolved_at, resolver)`
* `inventory(item_id PK, print_id FK, acquisition_batch, location_code, status, …)`
* `images(image_id PK, scan_id FK, variant ENUM('full','roi:name','roi:hp',…), uri, format, width, height, sha256)`

**Normalization:**

* Map `(name, set_code, collector_number)` → `print_id`.
* Store both **raw** and **normalized** values; never lose raw OCR.
* Generate a canonical **`slug`** (`{set_code}-{collector_number}-{language}`).
* Persist **ROI crops** as WebP (lossless) for review.

---

## 9) Performance & Acceleration Notes

* Prefer **ONNX Runtime** with OpenMP/MKL; set `OMP_NUM_THREADS` to physical cores.
* Batch ROI inference per image to amortize overhead.
* Cache lexicon tries in memory (DAWG/trie for names/moves).
* Add **per-field timers**; export Prometheus metrics you already wired: latency per stage, pass-through rates, tier distribution.

---

## 10) Testing & QA (make it boring and measurable)

* **Golden set:** 500–1,000 manually labeled scans across eras/layouts.
* **Metrics:**

  * Field accuracy (exact match) for `name/set/collector_number` ≥ 98% on High tier.
  * CER/WER for moves (you can tolerate lower; they’re secondary for inventory).
  * Tier distribution target: High ≥ 80%, Medium ≤ 18%, Low ≤ 2% after Pass B.
* **Fuzz tests:** JPEG re-encodes at qualities 60–95, ±5% gamma, +1 px blur, ±2° skew.
* **Regression gate:** block deploy if High-tier accuracy drops >0.5 pp on golden set.

---

## 11) Practical thresholds (tune, but start here)

* `τ_blur = 180`
* `p_layout ≥ 0.80` to trust ROI map fully
* **High tier:** `p_record ≥ 0.92`
* **Medium tier:** `0.75–0.92`
* Lexicon snap if `score ≥ 92` and edit distance ≤ 2
* Collector number regex strict; allow whitelist suffixes (`SVP`, `TG`, `GG`, `RC`, regional promos)

---

## 12) Dependencies (Fedora 42)

```bash
# System
sudo dnf groupinstall -y "Development Tools"
sudo dnf install -y opencv opencv-devel tesseract tesseract-langpack-eng \
                    leptonica leptonica-devel \
                    onnxruntime onnxruntime-devel \
                    python3-pip python3-virtualenv

# Python
python3 -m venv ~/.venvs/cardmint && source ~/.venvs/cardmint/bin/activate
pip install --upgrade pip wheel
pip install paddlepaddle==2.* paddleocr==2.* rapidfuzz==3.* onnxruntime==1.* \
           opencv-python==4.* numpy==2.* pillow==10.* pydantic==2.* \
           python-Levenshtein==0.* pyyaml==6.* orjson==3.*
# Optional: MMOCR if you want a second deep stack
pip install mmocr==1.* mmdet==3.* mmengine==0.*
```

---

## 13) Config-first design (single YAML, hot-reloadable)

`config/ocr.yaml`:

```yaml
pipeline_version: "cm-ocr-1.0.0"
detector: {method: "contour_then_yolo", yolo_model: "models/card_quad.onnx"}
resize: {card_height: 1039}
thresholds:
  blur_min: 180
  p_layout_min: 0.80
  high_record: 0.92
  medium_record: 0.75
preproc_profiles:
  fast: {clahe: {clip: 2.0}, sharpen: {sigma: 1.2, amount: 1.5}}
  slow: {clahe: {clip: 2.5}, denoise: "nlm", micro_rotations: [-3,-1.5,0,1.5,3]}
ocr:
  primary: "paddleocr"
  secondary: "tesseract"
  tesseract:
    hp: {whitelist: "0123456789"}
    collector: {whitelist: "0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ-"}
lexicon:
  paths:
    names: "lexicons/names_en.txt"
    moves: "lexicons/moves_en.txt"
    sets:  "lexicons/sets.json"
validation:
  regex:
    collector: "^([A-Z]{0,3}-)?\\d{1,3}/\\d{1,3}([A-Z]{1,3})?$"
weights:
  w_engine: 0.55
  w_lex: 0.25
  w_grammar: 0.10
  w_layout: 0.10
```

---

## 14) Claude-ready TODOs (bite-sized, parallelizable)

1. **Watcher + Enqueue**

   * Build `cardmint_ingest` service: watch directory, compute pHash, create `scan_id`, push job.

2. **Geometry module**

   * Implement contour → quad; fall back to YOLO (ONNX).
   * Homography warp to standard canvas; orientation classifier.

3. **Layout classifier**

   * Train small CNN; dump to ONNX; load in pipeline.

4. **ROI maps**

   * YAML file per layout with normalized boxes; helper to carve ROIs given canvas size.

5. **Preprocessing ops**

   * Implement parameterized preproc profiles (fast/slow) per ROI type.

6. **OCR engines**

   * Paddle wrapper: returns text, p\_text, boxes.
   * Tesseract wrapper: field-specific configs; merge voter for numeric zones.

7. **Lexicon service**

   * Load tries; RapidFuzz search; constrained candidate generation by era/layout.

8. **Validators**

   * Regex + plausibility checks; cross-field resolver that maps to `print_id`.

9. **Confidence + Tiers**

   * Compute `p_field` and `p_record`; route to keep/second-pass/review.

10. **DB writers**

* Persist scans, ocr\_fields, images, resolutions. Store ROI crops.

11. **Metrics + Tracing**

* Prometheus counters/histograms: stage latency, pass rates, tier distribution.

12. **Golden set + tests**

* CLI: `cardmint-ocr eval --dataset ./golden --report ./reports/$(date)`.

---

## 15) Sensible v1 defaults (Pokémon specifics)

* Prioritize **(name, set\_code, collector\_number)** for identity; moves are secondary.
* Treat **regulation mark** and **year** as priors on set candidates.
* Rarity/type via **icon classifiers** (small CNNs) not OCR; it’s more reliable.
* Keep **language detection** soft (confidence only); enforce English lexicon unless flipped.

---

## 16) Upgrade path (when you want more)

* Swap Paddle/CRNN to **quantized ONNX** for speed; trial OpenVINO on Intel iGPU.
* Train a **keypoint detector** for corners to make rectification bulletproof.
* Add **super-resolution** (Real-ESRGAN-lite ONNX) only for tiny ROIs (collector numbers).
* Active learning loop: auto-mine low-confidence ROIs → label → periodic fine-tunes.

---

## Implementation Strategy: "Working the Dough"

### Proven Success Pattern
**Phase 1 demonstrated** that incremental, measurable improvements provide reliable progress:
- 32% performance improvement achieved
- Zero accuracy regression  
- Production-ready baseline established
- Clear path for continued optimization

### Phase 2 Implementation Plan
**Focus on low-risk, high-impact optimizations:**

1. **Week 1**: Quality-based preprocessing intelligence
   - Implement image quality gates
   - Skip unnecessary enhancement for high-quality Pokemon cards  
   - Target: 3-second reduction

2. **Week 2**: Single-pass optimization
   - Implement confidence-based pass selection
   - Skip second pass for high-confidence results
   - Target: 2-second reduction

3. **Week 3**: ROI-focused processing  
   - Define Pokemon card region templates
   - Process essential regions only (skip artwork)
   - Target: 2-second reduction

**Combined Phase 2 Target**: <12 seconds (approaching production viability)

### Risk Management
- **Each optimization is feature-flagged** and can be reverted
- **Performance testing after each change** to validate gains
- **Accuracy regression testing** to maintain quality standards
- **A/B testing capability** for comparing approaches

### Phase 3 Decision Point
Only proceed to high-risk optimizations (ONNX conversion, alternative engines) if:
- Phase 2 optimizations plateau before reaching targets
- Production requirements demand <3 second performance
- Resource availability supports complex model conversion

## Bottom Line

**The dough is being worked properly**: We have a stable, working production system that delivers measurable improvements through careful, incremental optimization. Each "kneading motion" is reversible and validated, building compound gains without risking the foundation.

**Current Status**: Production-ready OCR service operational with clear optimization roadmap.
**Next Steps**: Begin Phase 2A (quality-based preprocessing) with performance validation gates.

Short answer: yes—the pipeline I proposed is designed to end with a stable, database-ready identity for each **print** and then layer **variant** classification (holo/reverse/alt patterns), **rarity**, and other inventory facets on top. Here’s how it scales cleanly to 40k+ English prints and catches tricky cases like “two Totodile in the same set” and foil pattern variants.

## 1) Unique identity: from OCR to a stable `print_id`

Think of identity resolution as a funnel:

1. **Primary keys (deterministic)**

* **Set code** (via set symbol classifier + denominator check + era priors).
* **Collector number** (e.g., `63/111`, `SVP 123`, `TG03`, etc.).
* **Language** (default ENG; flip if language classifier says otherwise).

These three, when present and valid, uniquely pick a **print** in the catalogue. Pokémon sets don’t reuse collector numbers within the same set, so **two Totodile in the same set will have different collector numbers**—your first disambiguator.

2. **Secondary disambiguators (tie-breakers & sanity)**

* **Card name** (lexicon-snapped if medium-conf).
* **Rarity class** (from symbol/frame classifier, not OCR).
* **Illustrator** (OCR, then lexicon).
* **Art embedding** (CNN embedding from the art box ROI; see §3).
  These are checked against the chosen print; if they disagree, the record is pushed to “Medium” for a second pass or review.

3. **Record confidence**
   We already compute `p_record`. Only if `p_record ≥ 0.92` (High tier) do we auto-resolve to a `print_id`. Otherwise we return top-k candidates (same set family) for a quick human confirm.

**Result:** you get a unique `print_id` (e.g., `EVS-095-ENG`) that stands for a specific card printing—independent of finish/foil. Variants are layered next.

## 2) Variant layer: holo / reverse / pattern / stamped / alt

Within a print, Pokémon has **finish variants** (non-holo, holo, reverse holo), **pattern families** (galaxy, confetti, cracked ice, e-series energy symbols, etc.), and **stamps** (Pre-Release, 1st Edition on vintage, League, Staff). We model these separately from the print:

* `prints` = text/artwork/number in a set.
* `variants` = physical finish & stamp metadata tied to a `print_id`.

### How we detect variants (two practical tracks)

**A) Single-image classification (works with your current rig)**

* Build a **specular map**: from the rectified RGB, compute a highlight score per pixel (e.g., max(R,G,B) − median blur) and normalize.
* Extract features in ROIs where foil is likely (background fields around the name box, lower text panel, edges).
* Compute:

  * **Specular density** (percentage of high-specular pixels).
  * **FFT radial power** (periodic foil patterns show peaks).
  * **LBP** or **HOG** histograms on the specular map.
  * **Reverse ratio**: specular inside *text background* vs inside *art box*. Reverse holos light up background more than the art (often the opposite of standard holos).
* Feed these into a small classifier to output: `finish = {non_holo, holo, reverse_holo}`, `pattern_family` (if known), `p_finish`.

**B) Two-image reflectance (upgrade path if you add light control)**

* Capture two frames with slightly different incident lighting (or toggle two opposite LED rings).
* Subtract/ratio to isolate **specular-only** response → dramatically cleaner pattern signals and much higher variant accuracy.

**Stamps & badges**

* Separate **stamp detector** (template/feature-based) over known stamp ROIs: “1st Edition”, “Pre-Release”, league/staff logos, set-subset tags. These are crisp logos—classification is reliable from static ROIs.

**Output:** `variant_id = hash(print_id, finish, pattern_family, stamp_code)` with confidences and evidence (specular stats).

## 3) “Two Totodile in the same set” and other edge cases

* In practice, they’ll have **different collector numbers** (e.g., `63/111` vs `76/111`). Your primary key nails this first.
* As a belt-and-suspenders check, compute an **artwork embedding**:

  * Crop the art box precisely (layout-specific ROI).
  * Run a tiny CNN or CLIP-like encoder and store a **128–256-D vector** (and a 16-byte `art_hash`).
  * Store per print the centroid embedding and variance.
    If OCR says `EVS-095` but the art embedding is a far outlier for that print’s centroid, we downgrade confidence and shove to secondary pass or review.

This also helps with:

* **Reprints** with the *same* artwork across sets (embedding matches, but set code/denominator differ → identity stays set-accurate).
* **Theme deck or stamped variants** (art matches but stamp detector adds a `stamp_code` into `variant_id`).

## 4) Rarity: don’t OCR it—classify it

Rarity is more robust from **symbols and frame style** than from text:

* Train a small sprite/shape classifier for rarity mark & set symbol.
* Use **frame/foil cues** (full art, gold border, rainbow) via a lightweight frame-style classifier.
* Map those to canonical rarity enums: `Common/Uncommon/Rare/Rare Holo/Ultra/Secret/…`.

Rarity lives both on the **print** (canonical rarity for that card number) and, when necessary, the **variant** (e.g., reverse holo of a Common).

## 5) Database organization that scales to 40k+ prints

**Core tables**

* `sets(set_id, set_code, name, series, release_date, size_denominator, language)`
* `prints(print_id, set_id, collector_number, name, rarity, illustrator, type, regulation, art_hash_centroid, art_embed_mean, …)`
* `variants(variant_id, print_id, finish, pattern_family, stamp_code, p_finish, p_pattern, evidence JSONB)`
* `inventory(item_id, variant_id, condition_pred, condition_notes, acquisition_batch, location_code, status, cost_basis, …)`
* `images(image_id, item_id, kind, uri, sha256, …)`

**Uniqueness & speed**

* Unique constraint: `(set_id, collector_number, language)` on `prints`.
* Indexes on `(name)`, `(rarity)`, `(series)`, `(release_date)`, `(finish)`.
* Optional `artworks(artwork_id, artist, embed_mean, prints[])` if you want to group reuses of the same art across sets.

**Organization views**

* **By set → rarity buckets → collector order** (classic binder view).
* **By series → set → secret rares** (numbers > denominator, alt subsets like TG/GG).
* **By type → era (regulation D–H)** for competitive relevance.
* **By variant** to count Reverse Holo completion.
* **By acquisition batch & location\_code** for physical retrieval.

## 6) End-to-end flow from the scanner into inventory

1. OCR + symbol/frame classifiers resolve **`print_id`** (High tier → auto; Medium → second pass; Low → review).
2. Variant classifier resolves **`variant_id`** with `p_finish`.
3. Create an **`inventory.item`** per physical copy, linked to `variant_id`.
4. Store both **raw fields** and **normalized** fields with confidences, ROI crops, and the **art\_hash**.
5. If `p_record` or `p_finish` is medium, the UI shows the top-k print candidates + foil prediction widget; human click locks it in.

## 7) Handling oddities you’ll see

* **Reverse vs Holo**: use the **reverse ratio** (specular in background vs art) as the primary feature; it’s surprisingly discriminative.
* **Pattern families**: start coarse (None/Galaxy/Confetti/CrackedIce/Other). Refine per era after you collect a few hundred labeled examples; pattern families are set-correlated.
* **Secret rares & subset tags**: allow collector regex to accept `\d+/\d+`, numbers beyond denominator, and two-letter subsets (e.g., `TG`, `GG`). Your set dictionary maps these to the parent set.
* **Promos (SWSH, SVP, BW-P, etc.)**: treat their **promo series** as `set_code`; denominator is absent—regex must allow “number only” with alpha prefix.
* **Misprints or stamped editions**: stamp detector adds `stamp_code`; if unseen, store `stamp_raw_crop` for labeling and future training.

## 8) Why this scales to >40,000 English prints

* Identity is **symbol/number driven**, not name-only. Names collide across eras; numbers don’t inside a set.
* The **lexicon** is used for *validation and correction*, not as the sole source of truth.
* **Art embeddings** add a strong visual prior that’s independent of text noise.
* **Variants** are explicit first-class entities, so holo/reverse/stamped distinctions don’t pollute “print” identity.

## 9) Concrete thresholds & cues (initial)

* **Print auto-resolve:** `p_record ≥ 0.92`.
* **Variant auto-resolve:** `p_finish ≥ 0.90` or `reverse_ratio ≥ 1.35` for reverse holo.
* **Art mismatch trigger:** cosine distance from print centroid ≥ 0.20 → downgrade tier.
* **Rarity disagreement:** rarity symbol classifier disagrees with catalogue → Medium tier.

## 10) Bite-sized build items for Claude this week

* Implement **set symbol** and **rarity** classifiers (sprite CNNs).
* Add **artwork embedding** extractor for the art ROI; store `art_hash`.
* Implement **specular map** + **reverse ratio** features and a tiny variant classifier.
* Extend DB: add `variants`, `inventory`, `art_hash_*` fields and uniqueness constraints.
* Update the resolver to output `(print_id, variant_id)` + confidences and write inventory rows.

This gives you the tidy ladder: **scan → print → variant → item**, plus the visual and reflective checks needed to separate look-alikes and foil patterns. From there, dashboards like “completion by set,” “reverse holo count,” or “inventory by rarity” fall out naturally.
