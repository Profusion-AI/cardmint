# ROI Calibration Tool Enhancement PRD

## Executive Summary

CardMint's ROI calibration tool requires strategic enhancements to support the full spectrum of Pokémon card identification across 25+ years of card evolution. Current limitations in template coverage and ROI definitions are constraining accuracy improvements that could boost the high-confidence pipeline from 70% to 85%+ of cards.

**Business Impact**: Each percentage point improvement in ROI accuracy reduces verification workload and increases throughput toward the sub-500ms performance target.

## Problem Statement

### Current Limitations

1. **Template Coverage Gap**: Only 4 templates for 12+ distinct card eras (1996-2025)
2. **ROI Definition Gaps**: Missing 15+ critical card regions needed for comprehensive identification
3. **Template Selection UX**: Basic dropdown lacks era context and visual guidance
4. **Accuracy Bottleneck**: Sub-optimal ROI positioning forces cards into 70-89% confidence range unnecessarily

### Quantified Impact

- **Golden-10 Results**: Current templates achieve 78% set icon accuracy vs 95% target
- **Confidence Distribution**: 30% of cards require verification due to ROI misalignment
- **Processing Overhead**: Each misaligned ROI adds ~50ms to pipeline latency

## Solution Overview

### Phase 1: Template Architecture Expansion
Systematically add missing card era templates with proper ROI definitions for comprehensive coverage.

### Phase 2: ROI Type System Enhancement  
Expand from 8 to 23+ ROI types to capture all card identification elements.

### Phase 3: Intelligent Template Selection
Implement era-aware, confidence-guided template selection with visual feedback.

## Technical Specifications

### 1. Template Architecture Expansion

#### 1.1 New Template Definitions

**Add to**: `/home/profusionai/CardMint/src/services/local-matching/ROIRegistry.ts`

```typescript
// Missing Era Templates (Priority Order)
templates: {
  // Existing: modern_standard, neo_era, base_set, mcd_promo
  
  // HIGH PRIORITY
  "e_card_series": {        // 2001-2003 (Expedition, Aquapolis, Skyridge)
    era: "e_card",
    layout_hint: "e_series",
    confidence: 0.88
  },
  
  "ex_era": {              // 2003-2007 (Ruby/Sapphire through Delta Species)
    era: "ex", 
    layout_hint: "ex_series",
    confidence: 0.85
  },
  
  "diamond_pearl": {       // 2007-2010 (DP through HeartGold/SoulSilver)
    era: "dp",
    layout_hint: "dp_series", 
    confidence: 0.87
  },
  
  // MEDIUM PRIORITY
  "black_white": {         // 2011-2014 (BW through XY transition)
    era: "bw",
    layout_hint: "bw_series",
    confidence: 0.89
  },
  
  "xy_era": {             // 2014-2017 (XY through Sun/Moon transition)
    era: "xy", 
    layout_hint: "xy_series",
    confidence: 0.91
  },
  
  "sun_moon": {           // 2017-2019 (SM through SWSH transition)
    era: "sm",
    layout_hint: "sm_series", 
    confidence: 0.93
  },
  
  // SPECIAL LAYOUTS
  "tag_team_gx": {        // Oversized dual-Pokémon cards
    era: "modern",
    layout_hint: "tag_team",
    confidence: 0.82
  },
  
  "vmax_gigantamax": {    // VMAX oversized layout
    era: "modern", 
    layout_hint: "vmax",
    confidence: 0.84
  }
}
```

#### 1.2 Template Metadata Enhancement

**Add era classification system**:

```typescript
interface TemplateMetadata {
  era_category: 'vintage' | 'neo' | 'e_series' | 'ex' | 'dp' | 'bw' | 'xy' | 'sm' | 'swsh' | 'sv';
  years_active: [number, number]; // [start_year, end_year]
  representative_sets: string[];
  layout_complexity: 'simple' | 'standard' | 'complex';
  special_features: string[]; // ['first_edition', 'regulation_marks', 'texture_foil']
  confidence_baseline: number;
}
```

### 2. ROI Type System Enhancement

#### 2.1 New ROI Definitions

**Add to**: `/home/profusionai/CardMint/src/dashboard/roi-tool.ts`

```typescript
const ENHANCED_DEFAULT_KEYS = [
  // EXISTING (8 ROIs)
  'set_icon', 'bottom_band', 'regulation_mark', 'artwork', 'card_bounds',
  'card_name', 'promo_star', 'first_edition_stamp',
  
  // CORE IDENTIFICATION (Priority 1 - Add First)
  'hp_number',              // HP value (top-right corner)
  'pokemon_type_icons',     // Type symbols (colorless, fire, water, etc.)
  'card_number_only',       // Isolated card number (without "/total")
  'set_total_only',         // Isolated set total (without "card/")
  
  // BATTLE MECHANICS (Priority 2) 
  'attack_names',           // Move names (middle section)
  'attack_damage',          // Damage values (right of attacks)
  'energy_costs',           // Energy requirements (left of attacks)
  'retreat_cost',           // Retreat energy count (bottom)
  'weakness_resistance',    // Type effectiveness (bottom)
  
  // METADATA (Priority 3)
  'illustrator_credit',     // Artist name
  'flavor_text',           // Pokédex entry text
  'evolution_indicator',    // "Evolves from X" text
  'copyright_notice',       // Bottom legal text
  
  // SPECIAL FEATURES (Priority 4)
  'texture_foil_region',    // Holographic/texture area
  'gx_vmax_label',         // Special card type identifiers
  'rarity_symbol'          // Rarity indicator (separate from set icon)
];

const ENHANCED_COLORS = {
  // Core identification
  hp_number: '#e91e63',
  pokemon_type_icons: '#607d8b', 
  card_number_only: '#ff1744',
  set_total_only: '#ff6b9d',
  
  // Battle mechanics  
  attack_names: '#4caf50',
  attack_damage: '#f44336',
  energy_costs: '#ff9800',
  retreat_cost: '#795548',
  weakness_resistance: '#ff5722',
  
  // Metadata
  illustrator_credit: '#9c27b0',
  flavor_text: '#9e9e9e', 
  evolution_indicator: '#00bcd4',
  copyright_notice: '#607d8b',
  
  // Special features
  texture_foil_region: '#ffc107',
  gx_vmax_label: '#e91e63',
  rarity_symbol: '#00e676'
};
```

#### 2.2 Conditional ROI Logic Enhancement

**Extend conditions system**:

```typescript
interface EnhancedROIConditions {
  // Existing
  promoOnly?: boolean;
  firstEditionOnly?: boolean;
  era?: 'classic' | 'neo' | 'modern' | 'promo';
  
  // NEW
  cardType?: 'basic' | 'stage1' | 'stage2' | 'ex' | 'gx' | 'vmax' | 'tag_team';
  hasTexture?: boolean;      // Holographic/textured cards
  hasAttacks?: boolean;      // Non-basic energy cards
  rarityLevel?: 'common' | 'uncommon' | 'rare' | 'ultra_rare' | 'secret_rare';
  layoutVariant?: 'standard' | 'oversized' | 'split_card' | 'full_art';
}
```

### 3. Intelligent Template Selection

#### 3.1 Enhanced Template Dropdown

**Enhance**: `/home/profusionai/CardMint/public/dashboard/enhanced-roi-tool.js`

```javascript
class EnhancedTemplateSelector {
  refreshTemplateSelect() {
    // Group templates by era with visual hierarchy
    const eraGroups = {
      'Vintage Era (1996-2003)': ['base_set', 'neo_era', 'e_card_series'],
      'EX Era (2003-2010)': ['ex_era', 'diamond_pearl'], 
      'Modern Era (2011-2025)': ['black_white', 'xy_era', 'sun_moon', 'modern_standard'],
      'Special Layouts': ['tag_team_gx', 'vmax_gigantamax', 'mcd_promo']
    };
    
    // Add ROI coverage indicators
    this.addROICoverageIndicators();
    
    // Add confidence score display
    this.addConfidenceIndicators();
  }
  
  suggestTemplateFromImage(imageBitmap) {
    // Auto-detection logic based on:
    // - Aspect ratio analysis
    // - Regulation mark presence
    // - Layout pattern recognition
    // - Color scheme detection
  }
}
```

#### 3.2 Template Quality Metrics

**Add template effectiveness tracking**:

```typescript
interface TemplateQualityMetrics {
  template_id: string;
  success_rate: number;           // % of cards achieving >90% confidence
  avg_confidence: number;         // Mean confidence score
  roi_accuracy: Record<string, number>; // Per-ROI success rates
  common_failures: string[];      // Frequent failure patterns
  last_updated: Date;
  calibration_card_count: number; // Number of reference cards
}
```

## Implementation Strategy

### Phase 1: Foundation (Week 1-2)
1. **Template Infrastructure**: Add new era templates to `ROIRegistry.ts`
2. **ROI Type Definitions**: Extend `roi-tool.ts` with Priority 1 ROIs
3. **Basic UI Enhancement**: Improve template dropdown grouping

### Phase 2: Intelligence (Week 3-4) 
1. **Smart Selection Logic**: Auto-suggest templates based on image analysis
2. **ROI Coverage Indicators**: Visual feedback for missing/incomplete ROIs
3. **Priority 2 ROIs**: Add battle mechanics ROI types

### Phase 3: Polish (Week 5-6)
1. **Advanced ROI Types**: Complete Priority 3-4 ROI definitions  
2. **Quality Metrics**: Template effectiveness tracking
3. **Golden-10 Validation**: Comprehensive accuracy testing

## Risk Mitigation & Pitfalls to Avoid

### 🚨 Critical Pitfalls

#### 1. **Template Explosion Anti-Pattern**
**Risk**: Creating too many hyper-specific templates
**Mitigation**: 
- Maximum 12 templates total (8 new + 4 existing)
- Use conditional ROIs instead of template multiplication
- Consolidate similar eras (e.g., combine XY subtypes)

```typescript
// WRONG: Creating template for every set
"xy_breakthrough": {...}, "xy_breakpoint": {...}, "xy_roaring_skies": {...}

// RIGHT: Single template with conditions
"xy_era": {
  rois: {
    regulation_mark: { 
      conditions: { setPattern: /xy.*/ } 
    }
  }
}
```

#### 2. **ROI Definition Sprawl**
**Risk**: Adding ROIs that don't improve accuracy meaningfully
**Mitigation**:
- Require measurable accuracy improvement (≥2%) for new ROI types
- Focus on high-variance regions that impact identification
- Avoid micro-optimizations that add complexity without value

```typescript
// WRONG: Overly granular ROIs  
'attack_1_name', 'attack_2_name', 'attack_3_name', 'attack_4_name'

// RIGHT: Single flexible ROI
'attack_names' // Handle multiple attacks with array logic
```

#### 3. **Coordinate System Inconsistency**
**Risk**: Mixing pixel and percentage coordinates creating scaling bugs
**Mitigation**:
- **Enforce percentage coordinates for all new templates**
- Convert existing pixel coordinates during migration
- Add validation to prevent mixed coordinate systems

```typescript
// Template validation rule
validateTemplate(template: ROITemplate): boolean {
  const hasPixel = Object.values(template.rois).some(roi => 'x' in roi);
  const hasPercent = Object.values(template.rois).some(roi => 'x_pct' in roi);
  
  if (hasPixel && hasPercent) {
    throw new Error(`Template ${template.id} mixes coordinate systems`);
  }
  return true;
}
```

#### 4. **Backward Compatibility Breakage**
**Risk**: Breaking existing calibrations and exports
**Mitigation**:
- Maintain existing template IDs unchanged
- Add new ROI types as optional (don't require them)
- Version the manifest format properly

```typescript
// Migration strategy
interface ROIManifest {
  version: "1.1"; // Increment for new features
  backward_compatible: boolean; // Flag for safety checks
  migration_notes?: string;
}
```

### ⚠️ Technical Debt Risks

#### 1. **Performance Degradation**
**Risk**: Too many ROI types slowing down pipeline
**Monitoring**: Track ROI extraction time per template
**Threshold**: Keep total ROI processing <50ms per card

#### 2. **UI Complexity Creep**
**Risk**: Template selector becoming overwhelming
**Mitigation**: 
- Progressive disclosure (show advanced options only when needed)
- Smart defaults based on image analysis
- Guided workflow for template selection

#### 3. **Configuration Drift**
**Risk**: Production and calibration templates becoming inconsistent
**Mitigation**:
- Single source of truth (`roi_templates.json`)
- Automated validation in CI/CD pipeline
- Template checksums for drift detection

### 🔧 Implementation Guidelines

#### Code Organization
```
src/services/local-matching/
├── ROIRegistry.ts              # Template definitions (data)
├── ROITemplateValidator.ts     # NEW: Template validation logic
└── TemplateMetadata.ts         # NEW: Era classification system

src/dashboard/
├── roi-tool.ts                 # Core ROI manipulation logic
├── TemplateSelector.ts         # NEW: Smart template selection
└── ROITypeManager.ts          # NEW: ROI type definition management

public/dashboard/
├── enhanced-roi-tool.js        # UI implementation
├── template-suggestion.js      # NEW: Auto-suggestion logic
└── roi-coverage-indicator.js   # NEW: Coverage visualization
```

#### Quality Gates
1. **Golden-10 Regression Prevention**: All changes must maintain or improve Golden-10 scores
2. **Performance Budgets**: ROI processing time limits per template
3. **Template Coverage**: Minimum 95% confidence on representative cards per era
4. **Backward Compatibility**: Existing exports must remain valid

#### Success Metrics
- **Primary**: Increase high-confidence cards from 70% to 85%+
- **Secondary**: Reduce average ROI calibration time from 10min to 5min per template
- **Tertiary**: Achieve ≥95% Golden-10 accuracy across all templates

## Acceptance Criteria

### Phase 1 Complete When:
- [ ] 8 new era templates added with proper ROI definitions
- [ ] 4 Priority 1 ROI types implemented and tested
- [ ] Template dropdown shows era-based grouping
- [ ] Golden-10 accuracy improved by ≥5% average across templates
- [ ] No regression in existing template performance

### Phase 2 Complete When:
- [ ] Auto-suggestion logic correctly identifies template for 80% of test images
- [ ] ROI coverage indicators show missing/incomplete ROIs visually
- [ ] 5 Priority 2 ROI types implemented
- [ ] Template selection workflow reduced from 3+ steps to 1 step for common cases

### Phase 3 Complete When:
- [ ] All 15+ new ROI types implemented and calibrated
- [ ] Quality metrics dashboard shows template effectiveness
- [ ] ≥85% of cards achieve high-confidence classification
- [ ] Sub-500ms total pipeline latency maintained
- [ ] Production deployment with zero-downtime migration

## Rollback Strategy

Each phase includes explicit rollback procedures:

1. **Database Migration Rollback**: Revert to previous `roi_templates.json` version
2. **Code Rollback**: Remove all enhancements while preserving existing functionality  
3. **Performance Rollback**: Disable new ROI types if latency exceeds budgets
4. **Quality Rollback**: Fall back to existing templates if accuracy degrades

The modular architecture ensures that enhancements can be disabled independently without breaking core functionality.