# Security Advisory - September 1, 2025

**Target Implementation Date**: Friday, September 5, 2025  
**Environment**: Development/Testing → Production Preparation  
**Severity**: HIGH (Critical production vulnerabilities identified)

## Executive Summary

NPM security audit revealed **6 vulnerabilities (4 moderate, 2 critical)** affecting CardMint's production pipeline. While currently in development testing environment, these must be addressed before production deployment.

**Key Finding**: Critical vulnerabilities exist in core ML communication pipeline (`RemoteMLClient`, `MLServiceClient`) and perceptual hash matching system.

## Vulnerability Breakdown

### 🚨 CRITICAL - Production Blocking Issues

#### 1. form-data <2.5.4 (CVE-2025-7783)
- **GHSA**: GHSA-fjxv-7rqg-78g4
- **Severity**: Critical (CVSS 9.4)
- **Impact**: Predictable multipart boundary generation enables HTTP parameter pollution/injection
- **CardMint Usage**: 
  - `src/services/RemoteMLClient.ts:1` - **ACTIVE** Mac ML server communication
  - `src/ml/MLServiceClient.ts:1` - **ACTIVE** ML service integration
- **Risk**: Attackers can predict form boundaries and inject malicious parameters into ML requests
- **Dependency Chain**: `image-hash → request → form-data@2.3.3` (vulnerable)

#### 2. request Package Vulnerabilities (Multiple CVEs)
- **Severity**: Critical/Moderate 
- **Impact**: Server-side request forgery, multiple security issues
- **CardMint Usage**: `src/services/local-matching/matchers/PerceptualHashMatcher.ts`
- **Risk**: SSRF vulnerabilities in duplicate card detection system
- **Status**: Package is deprecated, no fix available

### ⚠️ MODERATE - Development Environment Issues

#### 3. esbuild ≤0.24.2 (GHSA-67mh-4wv8-2f99)
- **Severity**: Moderate (CVSS 5.3)
- **Impact**: CORS bypass allows websites to read from development server
- **CardMint Usage**: Via Vite development server
- **Risk**: Source code exposure during development
- **Production Impact**: None (not used in production builds)

#### 4. tough-cookie <4.1.3 (GHSA-72xf-g2v4-qvf3)
- **Severity**: Moderate (CVSS 6.5)
- **Impact**: Prototype pollution vulnerability
- **Dependency Chain**: `request → tough-cookie` 
- **Risk**: Potential for prototype pollution attacks

## Current System Impact Assessment

### Production-Critical Components Affected
```
CardMint ML Pipeline:
├── RemoteMLClient.ts ← form-data (CRITICAL)
├── MLServiceClient.ts ← form-data (CRITICAL)  
└── PerceptualHashMatcher.ts ← image-hash → request (CRITICAL)

Development Environment:
└── Vite Dev Server ← esbuild (MODERATE)
```

### Risk Analysis by Component

| Component | Vulnerability | Production Impact | Development Impact |
|-----------|---------------|-------------------|-------------------|
| ML Communication | form-data injection | 🚨 HIGH | ⚠️ Medium |
| Duplicate Detection | request SSRF | 🚨 HIGH | ⚠️ Medium |
| Dev Server | esbuild CORS | ❌ None | ⚠️ Medium |
| Cookie Handling | tough-cookie | ⚠️ Low | ⚠️ Low |

## Recommended Implementation Plan - Friday Sept 5

### Phase 1: Critical Security Fixes (2-3 hours)

#### A. Replace form-data Usage
```bash
# Remove vulnerable dependency
npm uninstall form-data
```

**Code Changes Required:**
```typescript
// File: src/services/RemoteMLClient.ts
- import FormData from 'form-data';
+ // Use Node.js built-in FormData (Node 18+)

// File: src/ml/MLServiceClient.ts  
- import FormData from 'form-data';
+ // Use Node.js built-in FormData

// Update prepareFormData() method to use built-in FormData
private async prepareFormData(request: RemoteMLRequest): Promise<FormData> {
  const formData = new FormData(); // Built-in Node.js FormData
  // ... rest of implementation
}
```

#### B. Replace image-hash Package
```bash
# Remove vulnerable package
npm uninstall image-hash

# Already have sharp installed - extend usage
# OR consider: npm install jimp
```

**Implementation Options:**
1. **Sharp-based** (Recommended - already in dependencies):
```typescript
// src/services/local-matching/matchers/PerceptualHashMatcher.ts
- import { imageHash } from 'image-hash';
+ import sharp from 'sharp';

// Replace imageHash() calls with sharp.hash()
const hash = await sharp(imageBuffer).hash();
```

2. **Custom phash implementation** using Canvas (also in dependencies)

### Phase 2: Development Environment Security (1 hour)

#### Update Vite for esbuild Fix
```bash
# Check Node.js version first
node --version  # Must be ≥20.19.0

# Update to Vite 7.x (BREAKING CHANGE)
npm install vite@^7.1.4
```

**Breaking Changes to Review:**
- Node.js 20.19+ requirement
- Browser target changed to 'baseline-widely-available'
- Sass legacy API removed (check dashboard styles)
- Rolldown integration available (optional)

### Phase 3: Validation Testing (1 hour)

#### Security Validation
```bash
# Verify clean audit
npm audit

# Should show: 0 vulnerabilities
```

#### Functional Testing
```bash
# Core pipeline validation
npm run test:controller:smoke
npm run e2e:preflight
npm run dev:full

# ML pipeline specific testing
npm run evaluate:golden10
npm run test:performance:quick

# ROI calibration tool (ensure no regression)
# Navigate to: http://localhost:5173/roi-calibration.html
```

## Implementation Risks & Mitigations

### High-Risk Changes
1. **form-data → Built-in FormData**
   - **Risk**: Mac ML server API compatibility
   - **Mitigation**: Test Mac server communication thoroughly
   - **Rollback**: Keep form-data package available during transition

2. **image-hash → Sharp/alternative**
   - **Risk**: Hash algorithm differences affecting duplicate detection
   - **Mitigation**: Validate hash consistency with existing data
   - **Rollback**: Maintain original image-hash logic as fallback

3. **Vite 7.x Upgrade**
   - **Risk**: ROI calibration tool, dashboard build process
   - **Mitigation**: Test in isolated branch first
   - **Rollback**: Pin to Vite 5.x if blocking issues

### Low-Risk Changes
- tough-cookie: Indirect dependency, minimal impact expected

## Success Criteria

### Security Targets
- [ ] `npm audit` reports 0 vulnerabilities
- [ ] No form-data package in dependency tree
- [ ] No request package in dependency tree  
- [ ] esbuild ≥0.25.0 via Vite 7.x

### Functional Targets
- [ ] Mac ML server communication working
- [ ] Duplicate detection system functional
- [ ] ROI calibration tool operational
- [ ] Dashboard dev server running
- [ ] E2E pipeline tests passing

## Contingency Plans

### If Form-Data Fix Breaks ML Pipeline
```bash
# Quick revert
npm install form-data@^4.0.4  # Latest patched version
# Continue with vulnerable but patched version temporarily
```

### If Vite 7 Breaks Development
```bash
# Revert to Vite 5.x
npm install vite@^5.4.0
# Address esbuild separately via overrides
```

### If Image-Hash Replacement Fails
```bash
# Use patched but deprecated request chain
# Plan migration to custom implementation in Phase 4
```

## Post-Implementation Monitoring

### Week 1 After Deployment
- Monitor ML pipeline error rates
- Validate duplicate detection accuracy
- Check development workflow stability
- Run comprehensive Golden-10 accuracy tests

### Week 2-4 Follow-up
- Performance impact assessment
- Security posture re-evaluation
- Documentation of lessons learned

## Dependencies & Prerequisites

### Environment Requirements
- Node.js ≥20.19.0 (for Vite 7 compatibility)
- Mac M4 server operational for ML testing
- Clean git working directory for rollback capability

### Team Coordination
- **Development Lead**: Security fix implementation
- **QA**: Functional validation testing  
- **Infrastructure**: Environment stability monitoring

---

**Document Status**: Draft for Friday Sept 5 implementation  
**Next Review**: Post-implementation (Sept 8, 2025)  
**Escalation Path**: If any critical system breaks, immediate rollback to current state

## Quick Reference Commands

```bash
# Emergency rollback to current state
git stash && npm install

# Security validation
npm audit

# Core system validation  
npm run test:controller:smoke && npm run e2e:preflight

# Performance regression check
npm run test:performance:quick
```

---
*End of Security Advisory*