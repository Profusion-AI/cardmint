# CLAUDE.md - CardMint Project

This project follows global instructions from `/home/profusionai/CLAUDE.md`
Primary active development occurs in `/home/profusionai/CardMint/`
Ensure to PWD before exploring the codebase.
Additional project-specific guidelines are provided below.

## 🔒 CRITICAL: Database Separation

**Two Completely Separate Database Systems:**
1. **Archon (Supabase)**: Knowledge, documentation, RAG queries, task management ONLY
   - Instance: `rstdauvmrqmtuagkffgy.supabase.co`
   - Access via: MCP tools at localhost:8051
   - NEVER store production card data here

2. **CardMint (SQLite)**: Production card data, captures, OCR, pricing ONLY
   - **MIGRATED**: From Fly.io PostgreSQL to local SQLite (August 20, 2025)
   - Database: `./data/cardmint.db` with WAL mode
   - Performance: Sub-ms queries, zero network latency
   - NEVER store documentation here

This CLAUDE.md provides the guiding principles and workflows for the CardMint development environment. (It builds on global Claude Code guidelines, adding project-specific instructions.) CardMint’s development is conducted with Claude Code as the lead developer persona on a Fedora Linux capture system and an Apple M4 MacBook Pro ML server, ensuring real-time production fidelity.

Project Overview

CardMint is a high-accuracy Pokémon card scanning and inventory management system. It achieves 99%+ overall accuracy through multi-step validation (OCR, image recognition, API cross-checks) while maintaining a practical throughput. The MVP prioritizes correctness over raw speed, targeting roughly one successful card scan every ~10 seconds with comprehensive data verification. In each scan, high-resolution card images are captured, text is extracted and interpreted with Pokémon-specific context, results are verified against official card data, prices are fetched, and the inventory database is reliably updated.

System Architecture & Key Principles
Distributed Capture & Processing

CardMint employs a distributed two-part architecture: a Fedora-based capture system for high-speed image acquisition and a Mac-based ML server for heavy vision processing. These components communicate via a lightweight messaging and API interface, allowing asynchronous operation. The core image capture (camera trigger and save) runs as a standalone optimized service on Fedora, while enhancement tasks like OCR and API calls run on separate threads or the Mac, ensuring the capture loop is never blocked by slow tasks. This design guarantees that the mission-critical capture pathway is isolated from ancillary features.

Never compromise core capture performance for enhancements. Core capturing must remain sacrosanct. The camera capture (∼400ms per photo) is mission-critical and runs in an independent C++ module with minimal dependencies. All other features (OCR, API lookups, database writes) are secondary and must be treated as best-effort additions. If an enhancement fails or lags, the capture process must continue unaffected (graceful degradation).

Core vs Enhancement Responsibilities:

Core (Capture) – Sony ZVE10M2 camera triggered by Sony's proprietary SDK, and image save (400ms guaranteed per card) directly to a Fedora NVME. This runs at the hardware level with real-time priority. No external calls or heavy logic in this loop.

Enhancements – OCR text recognition through the Mac's ML vision models, external API integration, database updates, etc., handled in asynchronous pipelines. These improve the system but are not required for capture to succeed. They can queue or retry without impacting the camera cycle.

Development Rules for Safety:

Core capture must remain independent – It runs as a self-contained service (e.g. a C++ binary derived from Sony's SDK) with zero runtime dependencies on the rest of the system.

Enhancement failures cannot stop capture – Any failure in OCR, ML, database, or network operations should log an error and skip gracefully, never interrupting the camera loop.

Performance testing is required for core changes – Any modification to capture logic must include a performance benchmark to ensure the 400ms target still holds.

External outages must not break capture – The system must handle loss of network or database by queueing or local caching so that capture continues uninterrupted.

Performance Requirements

CardMint’s design meets strict performance targets for the core pipeline, with more flexible goals for the enhancement components:

Core Performance (Guaranteed): The camera capture loop consistently operates in ~400 ms per card, enabling a throughput of 150+ cards/minute on dedicated hardware. Capture operations have zero external dependencies and near-real-time reliability (approaching 100% success under proper conditions). Any transient errors are immediately handled or retried to maintain flow (automatic recovery).

Enhancement Performance (Best Effort): When the vision/OCR pipeline is available, the system strives for end-to-end processing under 3 seconds per card, with ≥98% OCR text accuracy on Pokémon cards. External API integrations (price lookups, card database checks) are utilized whenever available for additional validation. All enhancement failures default to safe behavior (e.g. a missed OCR or API timeout will simply mark a card as unverified but will not stop the overall process).

Processing Workflow

The capture and processing flow is fully asynchronous, ensuring the camera can continue taking pictures while the previous ones are being processed on the ML server. The typical workflow is:

Fedora captures a card image (via camera SDK, ~400 ms per capture).

Async file watcher detects the new image (under 50 ms) and enqueues it for processing.

Remote ML client sends the image to the Mac server asynchronously for analysis.

Mac ML server processes the image using the vision-language model (2–3 s for full recognition).

Results are returned & stored in the local SQLite database (inventory updated, OCR text and metadata saved).

Real-time updates are sent via the messaging channel to the terminal/UI, providing status to the operator.

(If the ML server is unavailable, a fallback OCR pipeline on Fedora can take over to ensure processing still occurs. But this is a future dev consideration and not a current priority as of 26 August.) This pipeline achieves true non-blocking operation – the capture system can continue photographing cards at a steady rate while the ML server works in parallel on previous captures.

## Current System Status (September 2025)

**Production-Ready Pipeline**: The system has reached a production-grade architecture with all core services operational. The current implementation (CardMint v2.0) uses the vlm-optimization codebase featuring the Qwen2.5-VL-7B vision-language model running locally on the Mac for card recognition. This replaced the earlier OCR-based approach, resulting in a massive performance boost. End-to-end scan time has improved from ~12–17 seconds with legacy OCR to around 7.6 seconds on average per card in the new ML pipeline. In testing, the recognition accuracy is ~95–100% for known card types, essentially eliminating false identifications. The 400 ms capture latency remains consistently achieved, preserving the high-frequency input rate (up to ~500 cards/hour in ideal conditions). The distributed Fedora↔Mac design has been validated under load – network communication and queuing overhead are well within tolerances, so the Mac's 2–3s processing time is the dominant factor in total latency.

All critical functionality is confirmed to be bulletproof in production mode. The Mac ML server (M4 chip) is online and stable, communicating with Fedora over dedicated ports. Roughly 60–70% of card scans are automatically approved with high confidence by the system's logic (using confidence thresholds to decide if human verification is needed). Production data storage has been migrated to a local SQLite database (WAL mode) for simplicity and speed – there is no longer any external DB dependency in the core pipeline. (The previous cloud PostgreSQL instance was retired after migration to SQLite, improving query latency to virtually 0.) This means CardMint can operate entirely offline for core scanning duties, which is ideal for on-premises use.

### 🎯 **MAJOR MILESTONE ACHIEVED: Phase 6.1 Coordinate Abstraction Layer (September 2, 2025)**

**Technical Debt Audit Grade: A+ (Exceptional)**

CardMint has successfully completed Phase 6.1 Foundation: Coordinate Abstraction Layer implementation as of 10:45AM CST on September 2, 2025. This represents a significant architectural advancement that positions the system for multi-TCG expansion while maintaining 100% backward compatibility.

#### 🏗️ **Architecture Improvements Delivered**

**1. Unified Coordinate System**
- **Purpose**: Transparent handling of pixel, percentage, and normalized coordinates
- **Implementation**: `UnifiedCoordinateSystem` with automatic format detection
- **Performance**: Sub-millisecond coordinate conversions with LRU caching
- **Compatibility**: Zero breaking changes to existing ROI processing

**2. Enhanced ROI Registry** 
- **Purpose**: Wrapper around legacy system enabling gradual migration
- **Implementation**: `EnhancedROIRegistry` with feature flags and rollback capabilities
- **Migration**: One-time migration utilities with full audit trail
- **Testing**: 200+ unit tests ensuring mathematical accuracy

**3. Future-Proof Template System**
- **Purpose**: Prevents "template explosion" as CardMint expands to other TCGs
- **Implementation**: Hierarchical template inheritance with base templates + variations
- **Scalability**: Lazy-loading ROI system for priority-based processing
- **Confidence**: Target increase from 70% to 85% confidence achieved

#### 🧪 **Comprehensive Testing & Validation**

**Golden-10 Regression Suite**: Validates 100% compatibility with existing production data
- ✅ All Golden-10 test cards process without regression
- ✅ Coordinate conversion accuracy within 2px tolerance
- ✅ Performance targets maintained (<50ms ROI processing)
- ✅ Backward compatibility verified with legacy systems

**Property-Based Testing**: Mathematical integrity validation
- ✅ Round-trip coordinate conversions maintain precision
- ✅ Edge cases (minimum/maximum values) handled gracefully  
- ✅ Format detection accuracy across all coordinate types
- ✅ Cache hit rates >90% for repeated conversions

#### 📈 **Technical Debt Prevention Excellence**

According to the formal technical debt audit performed at 11AM CST on September 2, 2025, this implementation achieved **Exceptional (A+)** rating across all categories:

**Testability (A+)**: 200+ unit tests with regression validation prevents future accuracy bugs
**Scalability (A+)**: Hierarchical template system directly solves "template explosion" problem  
**Migration Safety (A+)**: Gradual migration with feature flags eliminates "big bang" deployment risk
**Code Clarity (A+)**: TypeScript discriminated unions make invalid states compile-time errors
**Resilience (A+)**: Auto-detection and graceful fallbacks ensure production stability
**Performance (A+)**: LRU caching and lazy-loading prevent performance debt accumulation

#### 🔧 **Production Implementation Status**

**Core Components Delivered**:
- `/src/core/roi/CoordinateSystem.ts` - Main coordinate conversion engine
- `/src/core/roi/EnhancedROIRegistry.ts` - Backward-compatible ROI wrapper
- `/src/core/roi/CoordinateMigration.ts` - Migration utilities with rollback
- `/src/core/roi/CoordinateCache.ts` - Performance optimization layer
- `/src/dashboard/coordinate-bridge.ts` - Frontend integration bridge

**Validation & Testing**:
- `/src/core/roi/__tests__/CoordinateSystem.test.ts` - Unit tests (200+ tests)
- `/src/core/roi/__tests__/Golden10Validation.test.ts` - Regression validation
- `/scripts/validate-coordinate-system.ts` - Production readiness validation

**Status**: ✅ **PRODUCTION READY** - All systems validated, zero regression detected

#### 🚀 **Performance Impact**

- **ROI Processing**: Maintained <50ms target with caching improvements
- **Memory Usage**: LRU cache prevents memory leaks during long scanning sessions  
- **Conversion Speed**: Sub-millisecond coordinate transformations
- **Scalability**: System ready for multi-TCG expansion without template proliferation

#### 🔄 **Migration Strategy**

The implementation uses a **zero-disruption migration approach**:
1. **Dual Registry Operation**: Old and new systems run side-by-side
2. **Feature Flags**: Gradual rollout with instant rollback capability
3. **Audit Trail**: Full migration logging for debugging and verification
4. **Backward Compatibility**: Existing API endpoints unchanged

#### 📊 **Next Phase Readiness**

Phase 6.1 completion enables the next architectural phases:
- **Phase 6.2**: Hierarchical Template System (foundation laid)
- **Phase 6.3**: Lazy-Loading ROI System (framework established)  
- **Phase 6.4**: Multi-TCG Template Support (coordinate abstraction complete)

**Development Philosophy Evolution**: With Phase 6.1 complete, CardMint has transitioned from "make it work, then make it elegant" to a more mature "elegant architecture enables scalable work" approach. The coordinate abstraction layer demonstrates that production systems can be enhanced without compromising stability or performance.

### 🧹 **Legacy Code Deprecation (September 2, 2025)**

Following Phase 6.1 completion, CardMint has **deprecated legacy ROI tools** in favor of modern Phase 6.1+ architecture:

#### **Deprecated Systems**:
- ⚠️ **Legacy ROI Dashboard Tool** (`/src/dashboard/roi-calibration.html`) - Use Enhanced ROI Tool instead
- ⚠️ **Direct ROI Registry Usage** - Prefer Enhanced ROI Registry for new development
- ⚠️ **Manual Coordinate Conversion** - Use UnifiedCoordinateSystem abstraction

#### **Modern Alternatives**:
- ✅ **Enhanced ROI Tool**: `/public/dashboard/roi-calibration-enhanced.html` (glass morphism UI, undo system, dynamic scaling)
- ✅ **Enhanced ROI Registry**: `/src/core/roi/EnhancedROIRegistry.ts` (coordinate abstraction, performance optimization)
- ✅ **Unified Coordinate System**: `/src/core/roi/CoordinateSystem.ts` (type-safe coordinate handling)

#### **Migration Resources**:
- 📋 **Deprecation Plan**: `/docs/ROI-DEPRECATION-PLAN.md`
- 🔄 **Migration Guide**: `/archive/deprecated-2025-09-02/migration-notes/ROI-TOOL-MIGRATION-GUIDE.md`
- 📚 **Archive Documentation**: `/archive/deprecated-2025-09-02/README-ARCHIVE.md`

**Timeline**: Legacy tools will be archived September 16, 2025 and removed in CardMint v3.0 (November 2025).

### 📝 **Pokemon Card Naming Standardization (September 2, 2025)**

**CRITICAL: Single Source-of-Truth Naming System**

CardMint now implements a **canonical naming system** to standardize Pokemon card identification across 25 years of card evolution. This prevents logic from falling through cracks and ensures consistent handling of acronyms, eras, layout families, and naming conventions.

#### **Core Naming Architecture**:

**1. Canonical Configuration**:
- **Location**: `/config/naming/pokemon.json` (single source-of-truth)
- **Version**: 2025-09-02 (versioned for migration safety)
- **Namespace**: `cardmint.pkm` (prevents cross-contamination)

**2. Canonicalization Engine**:
- **Location**: `/src/lib/canon.ts` (TypeScript implementation)
- **Primary API**: `canon.normalize(ocrExtract, features)` → `NormalizedCard`
- **Key Methods**: 
  - `canon.acronym(str)` → canonical acronym (EX_2012, ex_2003, ex_2023)
  - `canon.era(setName|features)` → era ID (classic_wotc, bw, xy, sun_moon, etc.)
  - `canon.family(features)` → layout family (bw_xy, scarlet_violet, etc.)
  - `canon.number(str)` → normalized number format
  - `canon.name(str)` → normalized card name

#### **Mandatory Usage Patterns**:

**Before ROI Processing**:
```typescript
import { canon } from '../lib/canon';

// REQUIRED: Canonicalize before ROI selection
const normalized = canon.normalize(ocrResult, features);
const roiFamily = normalized.family;
const era = normalized.era;

// Pass canonical data to Enhanced ROI Registry
const rois = await enhancedROIRegistry.getEnhancedScaledROIs(
  width, height, 
  { 
    layout_family: roiFamily,
    era: era,
    ruleBox: normalized.ruleBoxCanonical 
  }
);
```

**Era & Acronym Handling**:
```typescript
// OLD: Manual string matching (error-prone)
if (cardName.includes('EX') || cardName.includes('ex')) { ... }

// NEW: Canonical acronym system
const acronyms = canon.normalize(ocrExtract).acronyms;
if (acronyms.includes('EX_2012')) { /* BW/XY era EX with rule box */ }
if (acronyms.includes('ex_2003')) { /* RS era ex without rule box */ }
if (acronyms.includes('ex_2023')) { /* SV era ex with rule box */ }
```

**ROI Family Selection**:
```typescript
// OLD: Hard-coded template mapping
const template = hints.layout_hint === 'neo' ? 'neo_era' : 'modern_standard';

// NEW: Canonical family resolution
const features = { set_name, layout_hint, rarity_hints };
const family = canon.family(features);
const roiConfig = canon.getROIConfig(family, 'critical');
```

#### **ROI ID Naming Convention**:

**Format**: `{familyId}:{roiName}`
- ✅ `scarlet_violet:name_band` 
- ✅ `bw_xy:rule_box`
- ✅ `ex_dp:delta_species_band`
- ✅ `legend_split:split_detector`
- ❌ `modern_standard` (legacy format, no family context)

#### **Era Coverage & Expansion**:

**10 Distinct Eras** (vs. previous 4):
1. `classic_wotc` (1999–2002): Base, Jungle, Fossil, Gym, Neo
2. `e_card` (2002–2004): Expedition, Aquapolis, Skyridge  
3. `ex` (2003–2007): Ruby/Sapphire, Delta Species, Power Keepers
4. `diamond_pearl` (2007–2009): DP, Platinum, LV.X cards
5. `hgss` (2010–2011): HeartGold/SoulSilver, Prime cards
6. `bw` (2011–2013): Black & White, EX with rule boxes
7. `xy` (2013–2016): XY, BREAK landscape cards
8. `sun_moon` (2016–2020): GX, TAG TEAM variants
9. `sword_shield` (2020–2023): V/VMAX/VSTAR, landscape layouts
10. `scarlet_violet` (2023–present): Modern ex with rule boxes, Radiant

#### **Layout Family Hierarchy**:

**11 Layout Families** (vs. previous 4 templates):
- `classic_wotc` → WotC era standard layouts
- `e_card` → e-Card series with dotcode borders
- `ex_dp` → EX/DP transitional (handles Delta Species, LV.X)
- `hgss` → HGSS with Prime variant support
- `bw_xy` → BW/XY with rule boxes, BREAK landscape
- `sun_moon` → SM with GX rule boxes, TAG TEAM variants
- `sword_shield` → SWSH with V-series rule boxes
- `scarlet_violet` → SV with modern ex rule boxes
- `legend_split` → LEGEND two-card split layouts  
- `vmax_vstar_landscape` → Landscape VMAX/VSTAR variants
- `trainer_ownership` → Gym/VS "Trainer's Pokémon" format

#### **Development Rules**:

**1. ALWAYS Use Canon Before Processing**:
```typescript
// REQUIRED at start of any card processing pipeline
const canonical = canon.normalize(ocrExtract, hints);
```

**2. NEVER Hard-Code Card Logic**:
```typescript
// ❌ BANNED: Hard-coded acronym logic
if (cardName.includes('EX')) { ... }

// ✅ REQUIRED: Canonical acronym system  
if (canonical.acronyms.includes('EX_2012')) { ... }
```

**3. Template Selection Must Use Family**:
```typescript
// ❌ BANNED: Direct template names
const template = 'modern_standard';

// ✅ REQUIRED: Family-based selection
const family = canon.family(features);
const rois = canon.getROIConfig(family, 'critical');
```

**4. Validation Required**:
```typescript
const validation = canon.validate(inputData);
if (!validation.valid) {
  logger.error('Canon validation failed:', validation.errors);
}
```

#### **Migration Path**:

**Phase 1** (Immediate): Canon implementation in place, legacy system still works
**Phase 2** (September 16, 2025): ROI system migrated to family-based selection  
**Phase 3** (CardMint v3.0): Legacy template IDs removed, full canonical system

This naming standardization **prevents the "template explosion" problem** and ensures CardMint can scale to other TCGs while maintaining accuracy across 25+ years of Pokemon card variants.

#### **🔒 Zod Schema Integration (September 2, 2025)**

**Enhanced Type Safety and Runtime Validation**

CardMint's canonical naming system now includes **Zod schema integration** for comprehensive type safety and runtime validation:

**1. Type-Safe Configuration**:
- **Location**: `/src/canon/pokemonCanon.schema.ts` (Zod schema with literal unions)
- **Validation**: Runtime schema validation with comprehensive error reporting
- **Type Safety**: Compile-time type checking prevents configuration drift
- **Integration**: `/src/canon/index.ts` provides unified API with backward compatibility

**2. Enhanced Canon Class**:
```typescript
import { canon } from '../lib/canon';

// Enhanced validation with Zod (automatically enabled)
const validation = canon.validateOCRExtract(ocrInput);
if (!validation.valid) {
  console.log('Validation errors:', validation.errors);
  console.log('Warnings:', validation.warnings);
}

// Enhanced normalization with validation
const { result, validation } = canon.normalizeWithValidation(ocrExtract, features);
```

**3. Validation Diagnostics**:
```typescript
const diagnostics = canon.getValidationDiagnostics();
console.log('Zod Enabled:', diagnostics.zodEnabled);
console.log('Config Version:', diagnostics.configVersion);
console.log('Validation Status:', diagnostics.validationResult);
```

**4. Development Benefits**:
- ✅ **Configuration Drift Prevention**: Schema catches invalid configurations at startup
- ✅ **Type Safety**: Literal union types ensure compile-time correctness
- ✅ **Enhanced Error Reporting**: Detailed validation messages for debugging
- ✅ **Backward Compatibility**: Existing code continues to work unchanged
- ✅ **ROI ID Validation**: Ensures ROI IDs follow `familyId:roiName` format
- ✅ **Migration Safety**: Validates configuration changes between versions

**5. Production Integration**:
The enhanced canon system runs with full Zod validation enabled by default, providing runtime safety while maintaining the same API. Validation failures gracefully fall back to basic parsing, ensuring system resilience.

**6. Testing & Validation**:
- **Test Suite**: `/src/canon/test-integration.ts` validates all integration points
- **Configuration Test**: Validates complete `pokemon.json` against schema
- **Backward Compatibility**: Ensures legacy code works with enhanced system
- **Error Handling**: Tests validation error reporting and recovery

This integration represents a significant advancement in CardMint's type safety and configuration validation, providing enterprise-grade reliability while maintaining the flexibility needed for ongoing development.

## 🚨 CRITICAL: Dual LM Studio Instances Configuration

**PRODUCTION PIPELINE USES TWO SEPARATE LM STUDIO INSTANCES:**

### 1. **Primary Production Instance (Mac M4)**
- **Location**: Remote Mac M4 server 
- **Endpoint**: `10.0.24.174:1234` (OpenAI-compatible API)
- **Purpose**: HIGH-PERFORMANCE vision-language processing for card recognition
- **Model**: Qwen2.5-VL-7B optimized for card scanning
- **Performance**: 2-3 seconds per card, 95-100% accuracy
- **Status**: PRODUCTION-READY, always use for E2E pipeline

### 2. **Local Fallback Instance (Fedora)**
- **Location**: Local Fedora capture system
- **Endpoint**: `localhost:41343` (autostart enabled)
- **Purpose**: EMERGENCY fallback, development testing, offline capability
- **Performance**: CPU-only inference, slower than Mac
- **Status**: Available but NOT primary production path

### ⚠️ CRITICAL DEVELOPMENT RULES:

1. **NEVER mix up endpoints in production code**
   - Production API calls → `10.0.24.174:1234` (Mac)
   - Local testing only → `localhost:41343` (Fedora)

2. **Configuration management**
   - Use environment variables to distinguish instances
   - Default production config must point to Mac instance
   - Local instance only for graceful degradation scenarios

3. **Code logic separation**
   - Primary inference routing → Mac M4 LM Studio 
   - Fallback logic → Local Fedora LM Studio
   - Clear error handling when Mac instance unavailable

**Examples of CORRECT usage:**
```typescript
// Production inference (Mac M4)
const PRODUCTION_LM_ENDPOINT = 'http://10.0.24.174:1234'

// Fallback inference (Local Fedora) 
const FALLBACK_LM_ENDPOINT = 'http://localhost:41343'
```

This dual-instance architecture ensures maximum reliability while preventing configuration confusion in the production CardMint E2E pipeline.

Active Development Workflow (Claude Code)

CardMint’s development is conducted using Anthropic’s Claude Code AI coding assistant, which operates directly in the repository via CLI. The following best practices and tools ensure productive, repeatable, and high-quality development:

Keep CLAUDE.md Updated: This file is automatically pulled into context by Claude Code on each session, so it should concisely document the key commands, codebase structure, and conventions of the project
anthropic.com
. As development progresses, update CLAUDE.md (manually or using the # instruction in Claude) to include new common commands, config changes, or gotchas. A well-tuned CLAUDE.md guides the AI developer effectively and improves instruction-following

. (For example, ensure any custom CLI flags or workflows unique to CardMint are noted here so Claude can use them.)

Claude Code CLI Configuration: Configure Claude Code to work seamlessly with our toolchain. Notably, install the GitHub CLI (gh) on development machines – Claude can use gh to create issues, open pull requests, read comments, and otherwise interact with GitHub directly

. This allows the AI to manage version control and code reviews autonomously. Also consider curating the allowed tool list in Claude Code to avoid constant permission prompts. For instance, you can always allow file edits and test runs, or permit git commit commands so Claude can save changes without asking every time

. Adjust the allowlist via the /permissions command or by editing the Claude settings JSON, and share that config with the team to standardize the development environment

Leverage CLI Automation: Claude Code can integrate with your shell environment and custom scripts. We have various NPM/package scripts and custom tools in this repo (e.g. scripts/validate-core-services.js, test runners, data exporters). Document these in CLAUDE.md and teach Claude to use them. Claude inherits the full Bash environment, so it can run anything you can. If you have a new script (say generate-report.sh), tell Claude about it and provide usage examples; it can then execute it as needed

By expanding Claude’s toolkit (even adding external MCP servers or APIs if needed), you increase its power – but always ensure safety by reviewing what new tools do.

Preferred Workflow – Plan then Code: To maximize correctness, use Claude Code in an iterative, plan-first manner. Rather than immediately asking for a code change, first ask Claude to analyze the relevant parts of the codebase and formulate a plan leveraged by the user in "Plan Mode."

. This gives it more time to consider alternatives and generate a step-by-step approach. Review that plan (Claude can even summarize it in a scratchpad or GitHub issue) before execution

. Once the approach is sound, instruct Claude to implement the solution. This extra upfront step significantly improves outcomes for non-trivial problems by preventing hasty or incorrect coding attempts

. Finally, when the code changes are completed and tested, have Claude commit the changes with a clear message and even open a pull request if it’s a larger change – it can handle the entire PR flow via gh commands

Test-Driven Development with Claude: We encourage a TDD approach using Claude Code for new features and bug fixes, which greatly enhances quality assurance. You can ask Claude to write tests first (unit tests, integration tests, etc.) for the expected behavior before any implementation code exists
. (Be explicit that it should not attempt to implement the functionality yet – only produce tests for the desired outcomes
.) Run these tests – Claude can execute the test suite – to see them fail initially, confirming the tests are valid

. Then ask Claude to implement the code needed to make the tests pass. Instruct it to iterate: it should run the tests after writing code, and if some tests still fail, adjust the code and retest, until all tests pass

. This cycle can often be done in an automated fashion with Claude continuously refining the solution. Once tests are green, have Claude commit the new code and tests. This workflow ensures we always have test coverage for new changes and that the code meets expected behavior before it’s finalized

. Our repository includes a comprehensive test suite (health checks, single-card tests, end-to-end pipeline tests, accuracy benchmarks, etc.) – integrate these into your development cycle. Claude can run these as needed to verify that core functionality and performance targets are not regressing.

Continuous Verification: Key portions of our system (capture timing, ML integration, etc.) have validation scripts (e.g. validate-core-services.js and shell tests in the scripts/ directory). Use these regularly. A typical development session should include running the core validation script to ensure no breaking changes. Claude Code can execute these and parse the output to confirm all checks passed. For example, you might instruct: “Run the core service validation script and verify all services initialize correctly.” If any check fails, address it before proceeding. Keeping this habit maintains real-time production fidelity – we only merge changes that have been sanity-checked in an environment closely mirroring production.

Use Claude for Routine Tasks: Aside from coding, Claude Code can speed up many development chores. It can generate documentation updates, perform code refactoring, and even handle some project management. For instance, after implementing a new feature or fix, ask Claude to update documentation (README, config comments, changelogs) to explain the change. It is adept at summarizing its code changes into human-readable, natural language notes

## 🔬 Human-in-the-Loop Testing Methodology

**CRITICAL DEVELOPMENT PHILOSOPHY: Production-Fidelity Testing**

CardMint uses a **human-in-the-loop** testing approach that has proven superior to pure automation for catching production-critical bugs. This methodology leverages human pattern recognition combined with real browser environments to surface integration issues that automated tests consistently miss.

### Why This Approach Works

**Proven Success Examples:**
- ✅ **Infinite Recursion Bug**: GUI behavior observation → Console inspection → Root cause analysis → Targeted fix
- ✅ **Asset Serving Issues**: Real 404 errors → Router enhancement → Complete resolution  
- ✅ **Telemetry Pipeline**: Data integrity validation → CSV verification → Schema fixes
- ✅ **WebSocket Integration**: Real network conditions → Reconnection logic → Stability improvements

**Core Advantages:**
- **Real Browser Environment**: Actual DOM, network conditions, storage behavior
- **Cross-System Integration**: Browser + API + WebSocket + CSV all tested together
- **Human Pattern Recognition**: Intuitive bug spotting that automation can't replicate
- **Production-Fidelity Conditions**: No hot reloading, no test doubles, real latency
- **Immediate Context**: Full stack traces, network timing, visual feedback

### Standard Testing Iteration Workflow

#### 1. Pre-Testing Setup
```bash
# Clean state for fresh test iteration
./scripts/development-reset.sh

# Start services with comprehensive preflight checks  
./scripts/e2e-preflight.sh
```

#### 2. Manual Testing Phase
1. **Browser Testing**: Open `http://localhost:3000/dashboard/verification.html`
2. **Functional Testing**: Test core functions (keyboard inputs, visual feedback, WebSocket)
3. **Console Monitoring**: Watch browser DevTools for errors, warnings, network failures
4. **Performance Observation**: Monitor input latency, response timing, memory usage

#### 3. Issue Discovery & Comprehensive Reporting
**When problems are encountered:**
```bash
# Collect complete system state snapshot
./scripts/collect-debug-info.sh

# Copy output + browser console errors + network tab + performance metrics
# Paste everything to Claude for multi-source analysis
```

**Copy/Paste Feedback Quality Standards:**
- ✅ Complete console output (errors + info logs + warnings)
- ✅ Network request timing from DevTools
- ✅ Screenshot of UI state for visual bugs
- ✅ Performance measurements (input latency, memory usage)
- ✅ CSV data samples for telemetry validation
- ✅ System resource utilization

#### 4. Fix Implementation & Validation
- **Claude Analysis**: Multi-source feedback analysis for root cause identification
- **Targeted Implementation**: Surgical fixes based on comprehensive context
- **Impact Assessment**: Explanation of changes and potential side effects
- **Regression Prevention**: Verification that fixes don't break existing functionality

#### 5. Validation Loop
```bash
# Reset to clean state
./scripts/development-reset.sh

# Re-test the specific issue to confirm resolution
# Verify no regression in other system areas  
# Test edge cases around the fix
```

### Feature Development Process

#### For New Features:
1. **Design Phase**: Plan API endpoints, data flow, UI integration patterns
2. **Implement Core**: Build backend/frontend components in isolation
3. **Integration Test**: Human-in-the-loop for end-to-end validation
4. **Performance Test**: Measure real-world latency and throughput under load
5. **Edge Case Discovery**: Human testing reveals unexpected interaction patterns

#### Example: Adding Controller Support
```bash
# 1. Clean environment
./scripts/development-reset.sh

# 2. Implement controller adapter  
# Claude: writes BrowserControllerAdapter enhancements

# 3. Human integration testing
# Human: plugs in controller, tests inputs, reports behavior patterns

# 4. Issue debugging with comprehensive data
./scripts/collect-debug-info.sh  
# Human: copies gamepad API errors, timing issues, connection problems

# 5. Fix implementation and validation
# Claude: fixes async gamepad polling, connection state management
# Human: confirms smooth operation across browsers and hardware
```

### Performance Validation Standards

#### Real-World Metrics Collection:
- **Input Latency**: Browser Performance API measurements (`performance.now()`)
- **Network Timing**: DevTools Network tab analysis
- **Memory Usage**: Browser Task Manager monitoring  
- **CSV Write Speed**: File system timestamp analysis
- **WebSocket Stability**: Connection persistence testing

#### Success Criteria Validation:
- ✅ Sub-100ms input-to-action response time
- ✅ Zero dropped events over 10-card test sequences
- ✅ Stable WebSocket connection through network instability  
- ✅ Clean browser console (no errors, minimal warnings)
- ✅ CSV data integrity (exact match with input events)

### Error Recovery & Resilience Testing

#### Network Resilience Validation:
```bash
# Simulate API downtime for localStorage fallback testing
sudo iptables -A OUTPUT -p tcp --dport 3000 -j DROP
# Test graceful degradation behavior in browser
sudo iptables -D OUTPUT -p tcp --dport 3000 -j DROP  
# Verify automatic recovery when service restored
```

#### State Corruption Testing:
```bash
# Introduce malformed CSV data
echo "invalid,data,row,structure" >> data/input-telemetry.csv
# Verify graceful degradation and error handling
```

#### Browser Storage Corruption:
```javascript
// Corrupt localStorage state
localStorage.setItem('cardmint_telemetry_test', 'invalid_json_data');
// Test recovery mechanisms
```

### Why This Beats Pure Automation

#### Complex State Interaction Discovery:
```javascript
// Automated tests would need to explicitly predict this scenario:
keyboard.press('Space') → 
  emitInput() → 
    handleCaptureAction() → 
      emitInput() →  // Infinite recursion loop!
        handleCaptureAction() → 
          emitInput() → ...

// Human testing naturally discovers this through actual usage patterns
// Console shows "Maximum call stack size exceeded" immediately
// Browser behavior becomes unresponsive, providing clear feedback
```

#### Integration Edge Cases That Automation Misses:
- **Browser-Specific WebSocket Behavior**: Reconnection timing, message queuing
- **Timing-Dependent Race Conditions**: Real network latency effects on event ordering
- **Actual Filesystem I/O Performance**: CSV write contention, disk space handling
- **Cross-Origin Resource Sharing**: Real browser security policy enforcement
- **Memory Pressure Scenarios**: Garbage collection impact on input responsiveness

### Development Workflow Optimizations

#### State Management Between Iterations:
- ✅ **Always reset state**: Clean CSV, localStorage, queue state between test runs
- ✅ **Validate starting conditions**: Confirm clean environment before testing
- ✅ **Document state changes**: Track what each test iteration modifies

#### Feedback Quality Enhancement:
- ✅ **Multi-Source Context**: Console + Network + Performance + Visual state
- ✅ **Timing Information**: Precise timestamps for event correlation
- ✅ **Resource Monitoring**: Memory, CPU, network utilization during issues
- ✅ **Reproducible Steps**: Clear sequence to recreate discovered problems

#### Systematic Coverage Approach:
1. **Happy Path First**: Core functionality under ideal conditions
2. **Edge Cases Second**: Network failures, malformed data, timing issues
3. **Stress Testing Third**: Rapid inputs, long sessions, resource exhaustion
4. **Recovery Testing Fourth**: System restart, data corruption, service failures

### Available Development Tools

#### Reset & Debug Scripts:
```bash
# Clean state between iterations
./scripts/development-reset.sh

# Comprehensive system state collection  
./scripts/collect-debug-info.sh

# Complete E2E preflight validation
./scripts/e2e-preflight.sh
```

#### Browser Test Commands:
- **Input Bus Validation**: `./scripts/browser-test-commands.md`
- **Performance Measurement**: Built-in browser Performance API usage
- **WebSocket Testing**: Real-time connection validation
- **Telemetry Verification**: CSV data integrity checking

This human-in-the-loop methodology ensures CardMint maintains production-grade quality while enabling rapid iteration and comprehensive bug discovery. The approach scales naturally from bug fixes to feature development, leveraging human intuition for complex debugging while maintaining systematic validation standards.

Team Collaboration and Automation: As we prepare to open source, we are exploring automated integration of Claude Code into our GitHub workflow. One idea is using the Claude Code GitHub Action/App to assist with issue triage and simple fixes. During internal testing, we found that we could trigger Claude to “take a stab” at a newly opened issue – it reads the issue, attempts a fix on a fresh branch, and proposes a pull request, all automatically

While a human will review and polish such PRs, this can significantly accelerate the resolution of minor bugs or routine tasks. We will consider enabling this for the open-source repository (with appropriate safeguards) to handle community-reported issues swiftly.

Open-Sourcing Plan (Target: September 1, 2025)

With the core system now production-ready, the next focus is to open source CardMint. Below is the plan to prepare the codebase and project for a public release, ensuring no sensitive information is exposed and that the project is welcoming to contributors.

1. Secret Audit and Purge: Thoroughly scan the repository for API keys, credentials, and secrets. This includes environment files, configuration constants, and historical commit data. For example, API keys for services like Pokemon TCG or database URLs must be removed or replaced with placeholders (e.g. use environment variables for runtime injection). We will invalidate any secrets that were previously committed and ensure they are scrubbed from the git history. If necessary, use tools like git-filter-repo or BFG to rewrite history and remove sensitive data from all commits

. The goal is that no private key or password exists anywhere in the public repo’s history. Going forward, an .env.example file will be provided to illustrate required config keys, and real secrets will be injected via secure means (not stored in the repo).

2. Codebase Cleanup and Restructuring: Remove or refactor any code that is proprietary, deprecated, or not intended for open source. This includes any references to internal systems (for instance, the “Archon” integration and project IDs used internally will be stripped out or made optional), as well as legacy code branches that are no longer used (the old OCR implementation on the main branch is already archived). We will simplify the repository structure for clarity – for example, ensure all source code resides in a logical path, and remove clutter like old migration scripts or one-off experiment directories. The resulting repository should reflect the current production architecture (Fedora capture service, Mac ML service, etc.) in a clear way, without leftover cruft from earlier prototypes. Where appropriate, add comments or documentation for any complex setup steps that were previously tribal knowledge.

3. Documentation & Licensing: Prepare high-quality documentation to accompany the code release. This includes an extensive README that explains what CardMint is, how to set it up, and a basic usage guide. Include screenshots or examples of it in action if possible. We will also provide documentation for the scanning workflow, data pipeline, and any configuration tuning that users might need to do (for instance, camera setup or model download instructions). In addition, we’ll create a CONTRIBUTING.md with guidelines on how to contribute (coding style, branch strategy, how to run tests, etc.), and a CODE_OF_CONDUCT.md to set expectations for community interaction. All existing inline code comments and docstrings will be reviewed and expanded for clarity where needed. We will choose an open-source license (likely MIT) and include a LICENSE file so that the community clearly knows the terms of use.

4. Community Preparation: Present CardMint attractively to the open-source community. This involves writing a concise project description and tagging the repository with relevant topics (e.g. computer-vision, OCR, trading-cards, etc.). We will prepare a launch announcement (on the project page or a blog) explaining the project’s goals and the current state. It’s important to set the right expectations: for example, note that it’s an MVP focusing on accuracy over speed, and that it requires specific hardware (Sony camera, M-series Mac) to replicate the exact performance. We’ll also ensure the project is easy to engage with: set up a Discussions or Discord channel for community support, and create issue templates for bug reports and feature requests to guide new contributors. The initial set of issues in the tracker will be curated with some “good first issue” tags to help onboard contributors. The public presentation of the project should make a great first impression – clean documentation, clear build instructions, and no obvious errors when following the setup steps.

5. Automation & CI Pipeline: To maintain quality in an open-source setting, we will configure continuous integration workflows. A GitHub Actions pipeline will run the test suite and linter on every pull request, so contributions are automatically validated. Our existing test scripts (unit tests for the ML server, end-to-end integration tests, etc.) will be integrated into this CI workflow. We’ll also add checks for coding style (ESLint/Prettier for JavaScript/TypeScript, etc.) to ensure consistency in incoming contributions. If feasible, we might include a step where Claude Code can be used in a CI context to analyze a PR and provide an initial code review or verify that documentation was updated – but such advanced automation will be approached carefully. The emphasis is on reproducibility: any developer should be able to fork the repo, run npm install (or the equivalent setup scripts), and then run the test suite and see all tests pass. We will document this process in the README. Additionally, we will set up release automation for versioning – e.g., using tags or GitHub Releases – so that users can track changes and we can distribute any packaged components (if applicable).

6. Repository Reset and Launch: The existing CardMint GitHub repository (which contains earlier code and history) will be treated as deprecated. We plan a hard reset for the public release – essentially publishing the current code as a fresh initial commit (or in a new repo altogether), without carrying over the old commit history that contains experimental phases and possibly sensitive data. This clean start means the commit history will begin from the open-source release date, and prior development history will be available only in the old private repo or as an archived snapshot. We will clearly communicate this in the project notes, so that it’s understood by the community (transparency about why history was reset – mainly to remove secrets and simplify the codebase). Once the new repository is live, we will archive or delete the old public repository to avoid confusion. The launch will include a version bump to v1.0.0 (or v2.0.0 to reflect the internal version) to signify a stable release.

By executing the above steps, CardMint will be ready for a successful open-source launch by September 1, 2025. The result will be a clean, secure, and well-documented codebase that external developers can easily set up and contribute to, without any lingering internal artifacts. This will transform CardMint from an internal project into a community-driven one, while maintaining the high standards of performance and reliability we have established. We look forward to sharing CardMint with the world and collaborating with others to take it to the next level!
