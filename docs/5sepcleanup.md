Alright Kyle—here’s a clean, no-nonsense playbook for a **comprehensive code review + deprecation cleanup** with you and Claude tag-teaming it. It’s built for your stack (TypeScript/Node, ROI templating, image pipeline), your hardware reality (HP Fedora box, Pi-5 kiosk, Mac M4), and your 6.2 goals (few, strong templates; OS-agnostic adapters).

I’ll split this into: **your role**, **Claude’s CLI workflow**, **cleanup waves**, **exact commands**, **debug instrumentation to add now**, **safe-removal protocol**, **CI gates**, and a **90-minute pair-review cadence**.

---

# 1) Your role (owner decisions that unblock everything)

**A. Create a “Code Health Ledger” (single source of truth)**
Minimal table (issue tracker or CSV is fine):

* `module` (path or package)
* `role` (core/domain/adapter/utility/test)
* `status` (KEEP | REFACTOR | ARCHIVE | DELETE)
* `risk` (LOW/MED/HIGH)
* `blast_radius` (files touched, critical paths)
* `owner` (you for now)
* `deadline` (date)
* `link` (PR/RFC)
* `notes` (acceptance criteria)

**B. Set the rules of engagement (non-negotiables)**

* **No new features** during review.
* **Strict type checks on** (tsconfig.build.json) and **max warnings = 0**.
* **Deprecations** require `@deprecated` tag + migration note + feature flag to disable old path.
* Every change must pass **6.2 perf/accuracy budgets** (≤50 ms template+ROI stage, ECE ≤5%).

**C. Decide the delete/refactor threshold**

* If a module has **zero inbound references** and no CLI entrypoints → **DELETE**.
* If inbound references exist but the module violates 6.2 abstractions (e.g., direct OpenCV, hardcoded paths) → **REFACTOR or ADAPTERIZE**.
* Anything platform-specific outside `/src/platform/*` → **RELOCATE** or delete.

---

# 2) Claude’s job (expert LLM living in the Linux CLI)

Claude acts like a surgical auditor. You give Claude a directory or topic; Claude returns a **call graph, diffs, and a decision**. Claude always proposes changes as patch-sets (unified diff) and tags edits in comments where needed.

**Turn-by-turn protocol**

1. You: “Review `src/roi` and `src/platform` (goal: kill dead code, adapterize).”
2. Claude (CLI):

   * Runs the tool suite (below), pastes summaries, highlights hotspots, proposes diffs.
   * For each risky change, includes a small **test harness** or **trace snippet**.
3. You: Approve/refine; Claude creates the PR diff and a short migration note.

---

# 3) Cleanup waves (order of attack)

**Wave 0 — Inventory & graph**

* Build a dependency graph, surface circular deps, list unused exports, and orphan files.

**Wave 1 — Fail-fast hygiene**

* Strict TypeScript, ESLint deprecations, unused disable directives, consistent imports.

**Wave 2 — Dead code & unused deps**

* Remove unreachable files, unused exports, stale packages.

**Wave 3 — Boundary enforcement**

* All camera/filesystem/OS stuff behind `/src/platform/*`. No direct SDK calls in domain.

**Wave 4 — ROI/Template hardening**

* One coordinate abstraction. Enforce percent-coords, ROI id naming, tier caps, conditions.

**Wave 5 — Perf sanity**

* Eliminate 1×→1× copy churn, add crop/probe caches, detect slow ROIs, pin memory reuse.

**Wave 6 — Docs & guards**

* Minimal READMEs in `src/roi` and `src/platform`, deprecation map, and CI gates.

---

# 4) Exact commands Claude should run (and what they answer)

> Run in repo root; Claude pastes the outputs and a short diagnosis for each.

**A. Type & lint walls**

```bash
# TypeScript (no emit, strict build subset)
npx tsc -p tsconfig.build.json --noEmit

# ESLint + ban unused disables + deprecation warnings
npx eslint . --max-warnings=0
npx eslint . --report-unused-disable-directives
```

**B. Unused exports / files / deps (the “what can die” trio)**

```bash
# Unused exports (TS)
npx ts-prune -p tsconfig.json

# Code & config that’s never referenced (smart detector)
npx knip

# Declared but unused npm deps
npx depcheck
```

**C. Graph & cycles**

```bash
# Cycles and orphans (fast)
npx madge --extensions ts,tsx --circular --orphans src

# Deeper policy checks (layer rules)
npx depcruise --config .dependency-cruiser.js --output-type dot src | dot -Tsvg > reports/dep-graph.svg
```

**D. Grep archaeology**

```bash
rg -n "TODO|FIXME|HACK|TEMP|WIP|@deprecated" --hidden -S
rg -n "(opencv|cv2|fs\.|path\.join\(|process\.platform)" src
rg -n "(AbsoluteCoordinate|LegacyCoordinate)" src
```

**E. Size & perf hints**

```bash
# Bundle size (if you bundle); otherwise skip
npx size-limit

# Count image processing hotspots
rg -n "resize|affine|deskew|normalize|OCR|ZNCC" src
```

Claude collects: **unused exports**, **orphans**, **cycles**, **bad imports**, **deprecated APIs**, **platform leaks**.

---

# 5) Debug & tracing we should add now (tiny, high-leverage)

**Runtime flags**

* `CONFIG_DUMP=1` — log loaded canon version, families, ROI counts.
* `ROISAN=1` — ROI sanitizer: percent bounds 0..1, non-negative sizes, id prefix matches family, tier caps.
* `SLOWROI_MS=8` — log any ROI scoring > 8 ms with roiId, scale, crop px.
* `TRACE=1` — outputs Chrome trace `trace.json` with phases (decode, normalize, probe, tier loops).
* `DEPRECATION_WARN=1` — one-time warning per `@deprecated` symbol at call site (memoized).

**CLI tools**

* `bin/roi:overlay <image> --template=<id> --tier=ALL --out=overlay.png`
* `bin/roi:explain <image> --out=explain.json`
* `bin/roi:doctor` (counts per family/tier, dead conditions, uplift history)
* `bin/code:inventory` (wraps madge/knip/ts-prune and writes JSON to `/reports`)

Claude should wire these to be **OS-agnostic** (Node + sharp/libvips only).

---

# 6) Safe-removal protocol (no foot-guns)

1. **Mark**: Add `@deprecated` JSDoc with replacement and remove-by date.
2. **Fence**: Guard old path with `FEATURE_OLD_PATH=0` default; enable only if explicitly set.
3. **Log once**: Under `DEPRECATION_WARN=1`, emit a single warning per symbol.
4. **Shadow run** (if critical): Keep both paths for one run over **golden-100** images; compare fused/conf/time budgets.
5. **Delete**: Remove code + tests; add a short note in `CHANGELOG.md` under “Removed”.
6. **Graveyard branch**: Push a tag `archive/<module>@<date>` before final deletion.

Claude automates steps 1–3 with codemods where possible and proposes the shadow-run script for step 4.

---

# 7) CI gates (stop regressions and bloat)

* **Type/lint gates**: `tsc --noEmit`, `eslint --max-warnings=0`, `--report-unused-disable-directives`.
* **Dead code gates**: `knip` and `ts-prune` must report **0 critical** (allow a small allowlist if needed).
* **Graph gate**: `madge` cycles must be **0**; orphans must be on an allowlist.
* **ROI bloat gate**: assert `≤ 40` ROIs per family and enforce tier counts via a small script.
* **Perf gate**: run **golden-100** on Fedora container; **median ≤ 50 ms**, **p95 ≤ 90 ms** for template+ROI stage.
* **Calibration gate**: ECE ≤ 5% and no increase > 1 pp from previous main.

---

# 8) 90-minute pair-review cadence (you + Claude)

**Block 1 — 20 min: Recon**

* Claude runs: `knip`, `ts-prune`, `madge`, `depcheck`, `rg` suite.
* Output: short findings summary + shortlist of **DELETE / REFACTOR** targets.

**Block 2 — 50 min: Surgery**

* Choose 1–2 modules.
* Claude posts diffs:

  * **DELETE**: remove file(s), update import sites, run `tsc/eslint`, add changelog entry.
  * **REFACTOR**: move platform code behind `/src/platform/…`, replace imports, add tests.
  * **ROI**: normalize coords to percent, fix ids (`family:roi-name`), enforce tiers.

**Block 3 — 20 min: Verification**

* Run `golden-100` with `TRACE=1 ROISAN=1 SLOWROI_MS=8`.
* Review `roi:doctor` + perf report; if green → merge PR; else Claude revises.

Rinse and repeat daily. Momentum > perfection.

---

# 9) Common high-value refactors Claude should queue

* **Consolidate coordinates**: kill `AbsoluteCoordinate` persistence; **persist percent only**, compute absolute at runtime with the 6.1 cache.
* **Adapterize I/O**: any direct `fs`, `path.join`, or OS checks move to `/src/platform/*` with interfaces.
* **Logger discipline**: wrap pino in a typed logger; forbid raw `console.*`.
* **Image stack**: prefer `sharp` for decode/affine/resize; isolate OpenCV use behind a single adapter (if you truly still need it).
* **Reusable buffers**: introduce tiny `BufferPool` for crops and score arrays to avoid GC stalls.

---

# 10) What success looks like this week

* `reports/` contains: `dep-graph.svg`, `unused-exports.json`, `orphans.json`, `cycles.json`.
* `src/platform/` hosts **all** system-specific code; domain code is pure.
* 2–3 modules **deleted**; 1–2 refactored to adapters; build is strict and clean.
* ROI registry passes: **id rules**, **tier caps**, **percent bounds**; no family > 40 ROIs.
* `golden-100` median template+ROI time **≤ 50 ms**; ECE **≤ 5%**.

---

If you want to kick this off right now, pick **two targets** for the first 90-minute session (e.g., `src/roi/legacy/` and `src/platform/mixed/`), and have Claude start by pasting the outputs of the tool suite above with a ranked DELETE/REFACTOR plan. I’ll keep you honest on the budgets and the “few, strong templates” doctrine while you two remove the fossils.

