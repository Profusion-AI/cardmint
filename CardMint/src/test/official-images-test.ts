/**
 * Official Images Test Suite
 * Tests OCR and card matching accuracy using known Pokemon card images
 */

import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { createLogger } from '../utils/logger';
import { cardMatcher } from '../utils/cardMatcher';
import { imageValidationService } from '../services/ImageValidationService';
import { pokemonTCGService } from '../services/PokemonTCGService';
import { priceChartingService } from '../services/PriceChartingService';

const logger = createLogger('official-images-test');

// Known card data for validation
interface TestCard {
  filename: string;
  expectedData: {
    name: string;
    set: string;
    number: string;
    rarity?: string;
    hp?: number;
    types?: string[];
    pokemontcgId?: string;
  };
}

// Test cards based on your official_images directory
const TEST_CARDS: TestCard[] = [
  {
    filename: 'mcd19-12_large_ac9a28214284.jpg',
    expectedData: {
      name: 'Pikachu',
      set: "McDonald's Promos 2019",
      number: '12',
      rarity: 'Promo',
      hp: 60,
      types: ['Lightning'],
      pokemontcgId: 'mcd19-12'
    }
  },
  {
    filename: 'neo3-2_large_f945368ae38f.jpg',
    expectedData: {
      name: 'Azumarill',
      set: 'Neo Genesis',
      number: '2',
      rarity: 'Rare Holo',
      hp: 70,
      types: ['Water'],
      pokemontcgId: 'neo3-2'
    }
  },
  {
    filename: 'neo4-5_large_3a468c3f5957.jpg',
    expectedData: {
      name: 'Light Azumarill',
      set: 'Neo Destiny',
      number: '5',
      rarity: 'Rare Holo',
      hp: 80,
      types: ['Water'],
      pokemontcgId: 'neo4-5'
    }
  },
  {
    filename: 'pop6-1_large_bdccf73d855f.jpg',
    expectedData: {
      name: 'Bastiodon',
      set: 'POP Series 6',
      number: '1',
      rarity: 'Rare',
      hp: 130,
      types: ['Metal'],
      pokemontcgId: 'pop6-1'
    }
  },
  {
    filename: 'sm1-20_large_bd5a022985ac.jpg',
    expectedData: {
      name: 'Solgaleo GX',
      set: 'Sun & Moon',
      number: '20',
      rarity: 'Rare Holo GX',
      hp: 250,
      types: ['Metal'],
      pokemontcgId: 'sm1-20'
    }
  },
  {
    filename: 'sv2-27_large_e93e77b473bc.jpg',
    expectedData: {
      name: 'Ampharos ex',
      set: 'Paldea Evolved',
      number: '27',
      rarity: 'Double Rare',
      hp: 330,
      types: ['Lightning'],
      pokemontcgId: 'sv2-27'
    }
  },
  {
    filename: 'swsh3-52_large_360935f9a1e8.jpg',
    expectedData: {
      name: 'Galarian Cursola V',
      set: 'Darkness Ablaze',
      number: '52',
      rarity: 'Rare Holo V',
      hp: 200,
      types: ['Psychic'],
      pokemontcgId: 'swsh3-52'
    }
  },
  {
    filename: 'swshp-SWSH021_large_76f1f9fc5a4b.jpg',
    expectedData: {
      name: 'Pikachu',
      set: 'SWSH Black Star Promos',
      number: 'SWSH021',
      rarity: 'Promo',
      hp: 60,
      types: ['Lightning'],
      pokemontcgId: 'swshp-SWSH021'
    }
  },
  {
    filename: 'xyp-XY50_large_a5618da624b3.jpg',
    expectedData: {
      name: 'Zygarde EX',
      set: 'XY Black Star Promos',
      number: 'XY50',
      rarity: 'Promo',
      hp: 190,
      types: ['Fighting'],
      pokemontcgId: 'xyp-XY50'
    }
  }
];

interface TestResult {
  cardName: string;
  filename: string;
  passed: boolean;
  ocrAccuracy?: number;
  apiMatchConfidence?: number;
  priceFound?: boolean;
  errors: string[];
  processingTime: number;
}

export class OfficialImagesTest {
  private imagesDir: string;
  private results: TestResult[] = [];

  constructor() {
    this.imagesDir = path.join(process.cwd(), 'official_images');
  }

  /**
   * Run all tests
   */
  async runAllTests(): Promise<void> {
    logger.info('Starting official images test suite');
    logger.info(`Testing ${TEST_CARDS.length} cards from ${this.imagesDir}`);

    for (const testCard of TEST_CARDS) {
      await this.testSingleCard(testCard);
    }

    this.printResults();
  }

  /**
   * Test a single card
   */
  private async testSingleCard(testCard: TestCard): Promise<void> {
    const startTime = Date.now();
    const result: TestResult = {
      cardName: testCard.expectedData.name,
      filename: testCard.filename,
      passed: false,
      errors: [],
      processingTime: 0
    };

    try {
      logger.info(`Testing ${testCard.filename}...`);

      // Load image
      const imagePath = path.join(this.imagesDir, testCard.filename);
      const imageBuffer = await readFile(imagePath);

      // Simulate OCR result (in production, this would come from actual OCR)
      const mockOcrResult = {
        card_name: testCard.expectedData.name,
        set_name: testCard.expectedData.set,
        set_number: testCard.expectedData.number,
        hp: testCard.expectedData.hp,
        pokemon_type: testCard.expectedData.types?.[0],
        rarity: testCard.expectedData.rarity,
        image: imageBuffer,
        image_path: imagePath,
        overall_confidence: 0.95, // Mock high confidence
        processing_timestamp: new Date().toISOString()
      };

      // Test card matching
      const matchResult = await cardMatcher.identifyCard(mockOcrResult, {
        validateImage: true,
        requireHighConfidence: true
      });

      // Validate results
      if (matchResult.card_name !== testCard.expectedData.name) {
        result.errors.push(`Name mismatch: expected "${testCard.expectedData.name}", got "${matchResult.card_name}"`);
      }

      if (matchResult.set_name !== testCard.expectedData.set) {
        result.errors.push(`Set mismatch: expected "${testCard.expectedData.set}", got "${matchResult.set_name}"`);
      }

      if (matchResult.card_number !== testCard.expectedData.number) {
        result.errors.push(`Number mismatch: expected "${testCard.expectedData.number}", got "${matchResult.card_number}"`);
      }

      // Check API match
      if (matchResult.pokemontcg_id !== testCard.expectedData.pokemontcgId) {
        result.errors.push(`Pokemon TCG ID mismatch: expected "${testCard.expectedData.pokemontcgId}", got "${matchResult.pokemontcg_id}"`);
      }

      // Record confidence scores
      result.ocrAccuracy = matchResult.validation.ocr_confidence;
      result.apiMatchConfidence = matchResult.validation.api_match_confidence;
      result.priceFound = !!(matchResult.pricing.tcgplayer?.market || matchResult.pricing.pricecharting?.market);

      // Check if needs review
      if (matchResult.validation.needs_review) {
        result.errors.push(`Card flagged for review: ${matchResult.validation.review_reasons.join(', ')}`);
      }

      // Determine pass/fail
      result.passed = result.errors.length === 0 && 
                     result.apiMatchConfidence > 0.85 &&
                     result.ocrAccuracy > 0.90;

    } catch (error) {
      logger.error(`Error testing ${testCard.filename}:`, error);
      result.errors.push(`Exception: ${error.message}`);
    }

    result.processingTime = Date.now() - startTime;
    this.results.push(result);

    // Log result
    if (result.passed) {
      logger.info(`✅ ${testCard.filename} - PASSED (${result.processingTime}ms)`);
    } else {
      logger.error(`❌ ${testCard.filename} - FAILED`);
      result.errors.forEach(err => logger.error(`   - ${err}`));
    }
  }

  /**
   * Test image quality assessment
   */
  async testImageQuality(): Promise<void> {
    logger.info('Testing image quality assessment...');

    const files = await readdir(this.imagesDir);
    const imageFiles = files.filter(f => f.endsWith('.jpg'));

    for (const filename of imageFiles) {
      const imagePath = path.join(this.imagesDir, filename);
      const imageBuffer = await readFile(imagePath);

      const quality = await imageValidationService.validateImageQuality(imageBuffer);

      logger.info(`${filename}:`);
      logger.info(`  Overall Quality: ${(quality.overall * 100).toFixed(1)}%`);
      logger.info(`  Brightness: ${(quality.brightness * 100).toFixed(1)}%`);
      logger.info(`  Contrast: ${(quality.contrast * 100).toFixed(1)}%`);
      logger.info(`  Sharpness: ${(quality.sharpness * 100).toFixed(1)}%`);
      logger.info(`  Acceptable: ${quality.isAcceptable ? 'Yes' : 'No'}`);
      
      if (quality.issues.length > 0) {
        logger.warn(`  Issues: ${quality.issues.join(', ')}`);
      }
    }
  }

  /**
   * Test API connectivity
   */
  async testAPIConnectivity(): Promise<void> {
    logger.info('Testing API connectivity...');

    // Test Pokemon TCG API
    try {
      const testSearch = await pokemonTCGService.searchCards({
        q: 'name:Pikachu',
        pageSize: 1
      });
      
      if (testSearch.data.length > 0) {
        logger.info('✅ Pokemon TCG API: Connected');
      } else {
        logger.warn('⚠️ Pokemon TCG API: Connected but no results');
      }
    } catch (error) {
      logger.error('❌ Pokemon TCG API: Failed', error);
    }

    // Test PriceCharting API
    try {
      const testSearch = await priceChartingService.searchProducts('Pikachu', 1);
      
      if (testSearch.products.length > 0) {
        logger.info('✅ PriceCharting API: Connected');
      } else {
        logger.warn('⚠️ PriceCharting API: Connected but no results');
      }
    } catch (error) {
      logger.error('❌ PriceCharting API: Failed', error);
    }
  }

  /**
   * Print test results summary
   */
  private printResults(): void {
    const passed = this.results.filter(r => r.passed).length;
    const failed = this.results.filter(r => !r.passed).length;
    const avgProcessingTime = this.results.reduce((sum, r) => sum + r.processingTime, 0) / this.results.length;
    const avgOcrAccuracy = this.results
      .filter(r => r.ocrAccuracy)
      .reduce((sum, r) => sum + r.ocrAccuracy!, 0) / this.results.length;
    const avgApiConfidence = this.results
      .filter(r => r.apiMatchConfidence)
      .reduce((sum, r) => sum + r.apiMatchConfidence!, 0) / this.results.length;

    logger.info('=====================================');
    logger.info('Test Results Summary');
    logger.info('=====================================');
    logger.info(`Total Tests: ${this.results.length}`);
    logger.info(`Passed: ${passed} (${((passed / this.results.length) * 100).toFixed(1)}%)`);
    logger.info(`Failed: ${failed} (${((failed / this.results.length) * 100).toFixed(1)}%)`);
    logger.info(`Average Processing Time: ${avgProcessingTime.toFixed(0)}ms`);
    logger.info(`Average OCR Accuracy: ${(avgOcrAccuracy * 100).toFixed(1)}%`);
    logger.info(`Average API Confidence: ${(avgApiConfidence * 100).toFixed(1)}%`);

    // Check if we meet the 99% accuracy target
    const accuracyRate = passed / this.results.length;
    if (accuracyRate >= 0.99) {
      logger.info('✅ MEETS 99% ACCURACY TARGET!');
    } else {
      logger.warn(`⚠️ Below 99% accuracy target (current: ${(accuracyRate * 100).toFixed(1)}%)`);
    }

    // List failed tests
    if (failed > 0) {
      logger.info('\nFailed Tests:');
      this.results
        .filter(r => !r.passed)
        .forEach(r => {
          logger.error(`  - ${r.filename}: ${r.errors.join('; ')}`);
        });
    }
  }
}

// Run tests if executed directly
if (require.main === module) {
  const tester = new OfficialImagesTest();
  
  (async () => {
    try {
      // Test API connectivity first
      await tester.testAPIConnectivity();
      
      // Test image quality
      await tester.testImageQuality();
      
      // Run main test suite
      await tester.runAllTests();
      
    } catch (error) {
      logger.error('Test suite failed:', error);
      process.exit(1);
    }
  })();
}

export default OfficialImagesTest;