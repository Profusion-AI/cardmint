# ROI System Deprecation and Migration Plan

**Date**: September 2, 2025  
**Status**: PLANNING PHASE  
**Objective**: Clean migration from legacy ROI systems to modern Phase 6.1+ architecture

## Executive Summary

Following the completion of Phase 6.1 Coordinate Abstraction Layer, CardMint now has modern ROI infrastructure that supersedes several legacy implementations. This plan outlines the systematic deprecation and archival of legacy code while maintaining production stability.

## Systems to Deprecate

### 1. **Legacy Dashboard ROI Tool** ⚠️ **HIGH PRIORITY**
- **Files**: `/src/dashboard/roi-tool.ts`, `/src/dashboard/roi-calibration.html`
- **Status**: Functional but superseded by Enhanced ROI Tool
- **Users**: Developer calibration workflows
- **Migration Path**: Redirect to Enhanced ROI Tool at `/public/dashboard/roi-calibration-enhanced.html`

### 2. **Duplicate Coordinate Logic** ⚠️ **MEDIUM PRIORITY**
- **Files**: Various coordinate conversion functions scattered across codebase
- **Status**: Duplicated functionality now centralized in UnifiedCoordinateSystem
- **Migration Path**: Replace with Enhanced ROI Registry calls

### 3. **Legacy Type Definitions** ⚠️ **LOW PRIORITY**
- **Files**: ROI type definitions in non-core locations
- **Status**: Maintained for backward compatibility
- **Migration Path**: Re-export from core types, eventually remove

## Deprecation Strategy

### Phase 1: Soft Deprecation (Week 1)
**Goal**: Add warnings and migration notices without breaking functionality

#### 1.1 Add Deprecation Headers
```typescript
/**
 * @deprecated This file is deprecated as of September 2025.
 * Use Enhanced ROI Tool at /public/dashboard/roi-calibration-enhanced.html
 * Will be removed in CardMint v3.0
 */
```

#### 1.2 Runtime Warnings
- Console warnings in deprecated tools
- UI banners directing users to modern alternatives
- Telemetry to track deprecated tool usage

#### 1.3 Documentation Updates
- Update all documentation to reference modern tools
- Add migration guides
- Mark legacy sections clearly

### Phase 2: Redirect Implementation (Week 2)
**Goal**: Seamlessly redirect users to modern tools

#### 2.1 HTTP Redirects
- `/dashboard/roi-calibration.html` → `/public/dashboard/roi-calibration-enhanced.html`
- Add temporary redirect with explanation page

#### 2.2 API Compatibility
- Maintain API endpoints for backward compatibility
- Add deprecation headers to API responses
- Log usage statistics for legacy endpoints

### Phase 3: Archive Legacy Code (Week 3-4)
**Goal**: Move deprecated code to archive while preserving history

#### 3.1 Create Archive Structure
```
/archive/
├── deprecated-2025-09-02/
│   ├── roi-tools/
│   │   ├── legacy-dashboard-tool/
│   │   ├── duplicate-coordinate-logic/
│   │   └── README-DEPRECATED.md
│   └── migration-notes/
```

#### 3.2 Archive Process
- Move deprecated files to archive directory
- Create comprehensive migration documentation
- Preserve git history with proper commit messages

### Phase 4: Clean Removal (Month 2)
**Goal**: Remove deprecated code from active codebase

#### 4.1 Remove Archived Files
- Delete files from active source tree
- Update build scripts and imports
- Clean up any remaining references

#### 4.2 Final Validation
- Ensure no broken imports
- Validate all tests pass
- Confirm production functionality

## Migration Guide for Developers

### From Legacy ROI Tool to Enhanced ROI Tool

#### Before (Legacy):
```html
<!-- OLD: Basic ROI calibration -->
<iframe src="/dashboard/roi-calibration.html"></iframe>
```

#### After (Modern):
```html
<!-- NEW: Enhanced ROI calibration -->
<iframe src="/public/dashboard/roi-calibration-enhanced.html"></iframe>
```

### From Direct ROI Registry to Enhanced ROI Registry

#### Before (Legacy):
```typescript
import { ROIRegistry } from '/src/services/local-matching/ROIRegistry';

const registry = new ROIRegistry();
const rois = await registry.getScaledROIs(width, height, hints);
```

#### After (Modern):
```typescript
import { EnhancedROIRegistry } from '/src/core/roi/EnhancedROIRegistry';

const registry = new EnhancedROIRegistry();
const rois = await registry.getEnhancedScaledROIs(width, height, hints);
// Or use backward-compatible method:
const rois = await registry.getScaledROIs(width, height, hints);
```

### From Manual Coordinate Conversion to Unified System

#### Before (Legacy):
```typescript
function convertToPixels(percentROI: any, imageSize: any) {
  return {
    x: Math.round(percentROI.x_pct * imageSize.width / 100),
    y: Math.round(percentROI.y_pct * imageSize.height / 100),
    width: Math.round(percentROI.width_pct * imageSize.width / 100),
    height: Math.round(percentROI.height_pct * imageSize.height / 100)
  };
}
```

#### After (Modern):
```typescript
import { UnifiedCoordinateSystem } from '/src/core/roi/CoordinateSystem';

const coordinateSystem = new UnifiedCoordinateSystem();
const pixelROI = coordinateSystem.toAbsolute(percentROI, imageSize);
```

## Risk Mitigation

### Production Safety Measures

#### 1. Backward Compatibility Maintained
- Enhanced ROI Registry wraps legacy ROI Registry
- All existing API endpoints continue to work
- No breaking changes to production scanning pipeline

#### 2. Gradual Migration
- Soft deprecation allows time for users to adapt
- Multiple migration paths available
- Rollback capability if issues discovered

#### 3. Comprehensive Testing
- All deprecated functionality tested before removal
- Migration paths validated with real data
- Performance regression testing

### Rollback Plan

If issues arise during deprecation:

1. **Immediate**: Restore archived files to active codebase
2. **Short-term**: Revert routing changes and remove deprecation warnings
3. **Long-term**: Address issues in modern tools, restart deprecation process

## Timeline and Milestones

### Week 1: Soft Deprecation
- [ ] Add deprecation warnings to legacy ROI tool
- [ ] Update documentation to favor Enhanced ROI Tool  
- [ ] Create migration guide documentation
- [ ] Add telemetry to track legacy tool usage

### Week 2: Redirect Implementation
- [ ] Implement HTTP redirects from legacy to enhanced tools
- [ ] Add migration notice banners to legacy interfaces
- [ ] Update all internal links to use modern tools
- [ ] Test all migration paths

### Week 3-4: Archive Preparation
- [ ] Create archive directory structure
- [ ] Move deprecated files to archive
- [ ] Document all archived components
- [ ] Update build scripts and imports

### Month 2: Clean Removal (After validation period)
- [ ] Remove archived files from active source
- [ ] Final cleanup of imports and references  
- [ ] Update version number to reflect breaking changes
- [ ] Create release notes documenting removed functionality

## Success Criteria

### Deprecation Complete When:
- [ ] Zero usage of legacy ROI dashboard tool (telemetry confirmed)
- [ ] All documentation references modern tools
- [ ] No duplicate coordinate conversion logic in codebase
- [ ] Archive directory contains comprehensive migration documentation
- [ ] Production systems continue operating without regression
- [ ] Development team trained on modern ROI tools

## Communication Plan

### Internal Team
- [ ] Announce deprecation plan in team meeting
- [ ] Share migration guide with developers
- [ ] Schedule training session on Enhanced ROI Tool
- [ ] Regular updates on deprecation progress

### External (Future Open Source)
- [ ] Include deprecation notes in release documentation
- [ ] Provide clear migration examples in README
- [ ] Respond to any community questions about removed functionality
- [ ] Maintain migration guide in documentation

## Archive Documentation Requirements

Each archived component must include:

1. **README-DEPRECATED.md**
   - Reason for deprecation
   - Migration path to modern equivalent
   - Date of deprecation and planned removal
   - Contact information for questions

2. **MIGRATION-GUIDE.md**
   - Step-by-step migration instructions
   - Code examples showing before/after
   - Common pitfalls and solutions
   - Testing recommendations

3. **HISTORICAL-NOTES.md**
   - Development history and evolution
   - Key decisions and trade-offs made
   - Lessons learned for future development
   - Performance characteristics and limitations

This deprecation plan ensures a clean, professional migration while preserving CardMint's production stability and providing clear guidance for all stakeholders.

---

*This plan will be executed in coordination with the Phase 6.2+ development roadmap to ensure optimal resource utilization and minimal disruption to ongoing development work.*