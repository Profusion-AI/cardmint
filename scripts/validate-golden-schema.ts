#!/usr/bin/env tsx

import { readFileSync } from 'fs';
import { join } from 'path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('golden-schema-validator');

class GoldenSchemaValidator {
  private ajv: Ajv;
  
  constructor() {
    this.ajv = new Ajv({ allErrors: true, verbose: true });
    addFormats(this.ajv);
  }
  
  async validate(): Promise<boolean> {
    console.log('🔍 Validating Golden Dataset Schema');
    console.log('==================================');
    
    try {
      // Load schema and manifest
      const schemaPath = join(__dirname, '../tests/e2e/golden/schema.json');
      const manifestPath = join(__dirname, '../tests/e2e/golden/manifest.json');
      
      const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      
      // Compile schema for card objects
      const validate = this.ajv.compile(schema);
      
      let allValid = true;
      const errors: string[] = [];
      
      console.log(`Validating ${manifest.cards.length} cards against schema...\n`);
      
      // Validate each card
      for (let i = 0; i < manifest.cards.length; i++) {
        const card = manifest.cards[i];
        const valid = validate(card);
        
        if (valid) {
          console.log(`✅ Card ${card.index}: ${card.card_title} - VALID`);
        } else {
          console.log(`❌ Card ${card.index}: ${card.card_title} - INVALID`);
          allValid = false;
          
          if (validate.errors) {
            for (const error of validate.errors) {
              const errorMsg = `   - ${error.instancePath}: ${error.message}`;
              console.log(errorMsg);
              errors.push(`Card ${card.index} ${errorMsg}`);
            }
          }
        }
      }
      
      console.log();
      
      // Additional validation checks
      const additionalChecks = this.performAdditionalChecks(manifest);
      if (!additionalChecks.valid) {
        allValid = false;
        errors.push(...additionalChecks.errors);
        additionalChecks.errors.forEach(error => console.log(`❌ ${error}`));
      }
      
      // Summary
      if (allValid) {
        console.log('🎉 Schema Validation: ALL PASSED');
        console.log('Golden dataset is production-ready');
      } else {
        console.log('💥 Schema Validation: FAILED');
        console.log(`Found ${errors.length} validation errors`);
        console.log('\nErrors:');
        errors.forEach(error => console.log(`  - ${error}`));
      }
      
      return allValid;
      
    } catch (error: any) {
      logger.error('Schema validation failed:', { error: error.message });
      console.log(`❌ Critical error: ${error.message}`);
      return false;
    }
  }
  
  private performAdditionalChecks(manifest: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    // Check for duplicate indices
    const indices = manifest.cards.map((c: any) => c.index);
    const duplicateIndices = indices.filter((index: number, i: number) => indices.indexOf(index) !== i);
    if (duplicateIndices.length > 0) {
      errors.push(`Duplicate indices found: ${duplicateIndices.join(', ')}`);
    }
    
    // Check for duplicate filenames
    const filenames = manifest.cards.map((c: any) => c.filename);
    const duplicateFilenames = filenames.filter((filename: string, i: number) => filenames.indexOf(filename) !== i);
    if (duplicateFilenames.length > 0) {
      errors.push(`Duplicate filenames found: ${duplicateFilenames.join(', ')}`);
    }
    
    // Check index sequence (should be 1 to N)
    const expectedIndices = Array.from({ length: manifest.cards.length }, (_, i) => i + 1);
    const actualIndices = indices.sort((a: number, b: number) => a - b);
    if (JSON.stringify(expectedIndices) !== JSON.stringify(actualIndices)) {
      errors.push('Index sequence is not consecutive 1 to N');
    }
    
    // Check pricing consistency
    for (const card of manifest.cards) {
      if (card.raw_price_usd <= 0) {
        errors.push(`Card ${card.index}: Invalid price ${card.raw_price_usd}`);
      }
      
      if (card.pricing_source !== 'PriceCharting') {
        errors.push(`Card ${card.index}: Invalid pricing source ${card.pricing_source}`);
      }
      
      if (card.currency !== 'USD') {
        errors.push(`Card ${card.index}: Invalid currency ${card.currency}`);
      }
    }
    
    // Check identifier consistency
    for (const card of manifest.cards) {
      const hasNumberPair = card.identifier.number && card.identifier.set_size;
      const hasPromoCode = card.identifier.promo_code;
      
      if (hasNumberPair && hasPromoCode) {
        errors.push(`Card ${card.index}: Cannot have both number/set_size and promo_code`);
      }
      
      if (!hasNumberPair && !hasPromoCode) {
        errors.push(`Card ${card.index}: Must have either number/set_size or promo_code`);
      }
    }
    
    // Check first_edition logic
    for (const card of manifest.cards) {
      if (card.first_edition === false) {
        errors.push(`Card ${card.index}: first_edition should be omitted rather than false`);
      }
    }
    
    return { valid: errors.length === 0, errors };
  }
}

// Add Ajv as dependency check
if (require.main === module) {
  try {
    require('ajv');
  } catch (error) {
    console.error('❌ Missing dependency: ajv');
    console.log('Install with: npm install ajv ajv-formats');
    process.exit(1);
  }
  
  const validator = new GoldenSchemaValidator();
  validator.validate().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(error => {
    logger.error('Schema validation failed:', error);
    process.exit(1);
  });
}

export { GoldenSchemaValidator };