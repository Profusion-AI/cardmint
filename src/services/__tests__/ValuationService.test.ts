/**
 * Unit tests for ValuationService
 * 
 * Tests core valuation logic, caching, and edge cases without
 * requiring actual database connections or external services.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ValuationService } from '../ValuationService';
import { DeterministicResolver } from '../../resolution/DeterministicResolver';

// Mock DeterministicResolver
class MockDeterministicResolver extends DeterministicResolver {
  constructor() {
    super(null as any); // Don't need real DB for mocking
  }

  async resolve(input: any) {
    // Return a mock successful resolution
    return {
      verdict: 'CERTAIN' as const,
      chosen_card: {
        id: 'test-card-id',
        name: 'Test Card',
        set_name: 'Base Set',
        card_number: '1',
        normalized_name: 'test card',
        normalized_set: 'base set',
        normalized_number: '1'
      },
      confidence: 0.95,
      evidence: ['Exact match found'],
      alternatives: []
    };
  }
}

// Mock Database
function createMockDatabase() {
  const mockRows = [
    { basis: 'ungraded', price_cents: 5000, vendor: 'pricecharting' }, // $50 raw
    { basis: 'PSA', price_cents: 8000, grade_numeric: 9, vendor: 'pricecharting' }, // $80 PSA 9
    { basis: 'PSA', price_cents: 12000, grade_numeric: 10, vendor: 'pricecharting' }, // $120 PSA 10
  ];

  return {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue(mockRows)
    })
  } as any;
}

describe('ValuationService', () => {
  let mockDatabase: Database.Database;
  let mockResolver: DeterministicResolver;
  let valuationService: ValuationService;

  beforeEach(() => {
    // Set environment variables for testing
    process.env.VALUATION_ENABLED = 'true';
    process.env.FEE_EBAY_RAW = '0.13';
    process.env.FEE_FANATICS_GRADED = '0.10';
    process.env.GRADING_COST_BASE = '2000'; // $20
    process.env.SHIP_TO_GRADER = '500'; // $5
    process.env.SHIP_TO_BUYER_RAW = '300'; // $3
    process.env.SHIP_TO_BUYER_GRADED = '500'; // $5
    process.env.PSA9_PROBABILITY = '0.70';
    process.env.PSA10_PROBABILITY = '0.30';
    process.env.CACHE_TTL_MINUTES = '15';

    mockDatabase = createMockDatabase();
    mockResolver = new MockDeterministicResolver();
    valuationService = new ValuationService(mockDatabase, mockResolver);
  });

  afterEach(() => {
    // Clean up environment
    delete process.env.VALUATION_ENABLED;
    delete process.env.FEE_EBAY_RAW;
    delete process.env.FEE_FANATICS_GRADED;
    delete process.env.GRADING_COST_BASE;
    delete process.env.SHIP_TO_GRADER;
    delete process.env.SHIP_TO_BUYER_RAW;
    delete process.env.SHIP_TO_BUYER_GRADED;
    delete process.env.PSA9_PROBABILITY;
    delete process.env.PSA10_PROBABILITY;
    delete process.env.CACHE_TTL_MINUTES;

    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with proper configuration', () => {
      expect(valuationService).toBeDefined();
      
      const cacheStats = valuationService.getCacheStats();
      expect(cacheStats.ttlMinutes).toBe(15);
    });

    it('should handle disabled service', () => {
      process.env.VALUATION_ENABLED = 'false';
      const disabledService = new ValuationService(mockDatabase, mockResolver);
      expect(disabledService).toBeDefined();
    });
  });

  describe('compareResale', () => {
    it('should compute correct raw vs graded comparison', async () => {
      const result = await valuationService.compareResale({
        cardId: 'test-card-id'
      });

      expect(result).toBeDefined();
      expect(result.recommendation).toBe('graded'); // Should recommend grading
      expect(result.rawNetCents).toBeGreaterThan(0);
      expect(result.gradedNetCents).toBeGreaterThan(0);
      expect(result.gradedNetCents).toBeGreaterThan(result.rawNetCents);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.evidence).toHaveLength.greaterThan(0);
    });

    it('should resolve card from query', async () => {
      const result = await valuationService.compareResale({
        query: 'Charizard Base Set'
      });

      expect(result).toBeDefined();
      expect(result.recommendation).toMatch(/raw|graded/);
      expect(mockResolver.resolve).toHaveBeenCalled();
    });

    it('should calculate raw net correctly', async () => {
      const result = await valuationService.compareResale({
        cardId: 'test-card-id'
      });

      // Raw: $50 - 13% fee - $3 shipping = $50 - $6.50 - $3 = $40.50 = 4050 cents
      const expectedRawNet = 5000 - (5000 * 0.13) - 300;
      expect(result.rawNetCents).toBeCloseTo(expectedRawNet, 0);
    });

    it('should calculate graded net with priors', async () => {
      const result = await valuationService.compareResale({
        cardId: 'test-card-id'
      });

      // Expected sale: $80 * 0.7 + $120 * 0.3 = $56 + $36 = $92
      // Net: $92 - 10% fee - $20 grading - $5 ship to grader - $5 ship to buyer
      // = $92 - $9.20 - $20 - $5 - $5 = $52.80 = 5280 cents
      const expectedSalePrice = (8000 * 0.7) + (12000 * 0.3); // 9200 cents
      const expectedNet = expectedSalePrice - (expectedSalePrice * 0.1) - 2000 - 500 - 500;
      expect(result.gradedNetCents).toBeCloseTo(expectedNet, 0);
    });

    it('should handle missing price data', async () => {
      // Mock empty price data
      const mockDbNoData = {
        prepare: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([])
        })
      } as any;

      const serviceNoData = new ValuationService(mockDbNoData, mockResolver);
      const result = await serviceNoData.compareResale({
        cardId: 'test-card-id'
      });

      expect(result.recommendation).toBe('insufficient_data');
      expect(result.confidence).toBe(0);
      expect(result.evidence).toContain('No market price data available');
    });

    it('should handle card resolution failure', async () => {
      const failingResolver = {
        resolve: vi.fn().mockResolvedValue({
          verdict: 'UNCERTAIN',
          confidence: 0,
          evidence: ['Could not resolve'],
          chosen_card: null
        })
      } as any;

      const serviceWithFailingResolver = new ValuationService(mockDatabase, failingResolver);
      const result = await serviceWithFailingResolver.compareResale({
        query: 'Unknown Card'
      });

      expect(result.recommendation).toBe('insufficient_data');
      expect(result.evidence).toContain('Could not resolve card from query');
    });

    it('should use cache for repeated queries', async () => {
      const input = { cardId: 'test-card-id' };

      // First call
      const result1 = await valuationService.compareResale(input);
      
      // Second call should use cache
      const result2 = await valuationService.compareResale(input);

      expect(result1).toEqual(result2);
      
      // Database should only be called once (for the first query)
      expect(mockDatabase.prepare).toHaveBeenCalledTimes(1);
    });

    it('should handle variant parameters', async () => {
      const result = await valuationService.compareResale({
        cardId: 'test-card-id',
        variant: {
          finish: 'holo',
          edition: '1st'
        }
      });

      expect(result).toBeDefined();
      expect(result.recommendation).toMatch(/raw|graded|insufficient_data/);
    });
  });

  describe('edge cases', () => {
    it('should handle very low raw prices', async () => {
      // Mock low price data
      const lowPriceMock = {
        prepare: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([
            { basis: 'ungraded', price_cents: 100, vendor: 'pricecharting' }, // $1 raw
          ])
        })
      } as any;

      const serviceWithLowPrices = new ValuationService(lowPriceMock, mockResolver);
      const result = await serviceWithLowPrices.compareResale({
        cardId: 'test-card-id'
      });

      // Should recommend raw sale for very low value cards
      expect(result.recommendation).toBe('raw');
      expect(result.rawNetCents).toBeGreaterThan(0);
    });

    it('should handle only graded prices available', async () => {
      // Mock only graded prices
      const gradedOnlyMock = {
        prepare: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([
            { basis: 'PSA', price_cents: 10000, grade_numeric: 10, vendor: 'pricecharting' },
          ])
        })
      } as any;

      const serviceGradedOnly = new ValuationService(gradedOnlyMock, mockResolver);
      const result = await serviceGradedOnly.compareResale({
        cardId: 'test-card-id'
      });

      expect(result.rawNetCents).toBe(0);
      expect(result.gradedNetCents).toBeGreaterThan(0);
      expect(result.recommendation).toBe('graded');
    });

    it('should handle service errors gracefully', async () => {
      const errorResolver = {
        resolve: vi.fn().mockRejectedValue(new Error('Database connection failed'))
      } as any;

      const serviceWithError = new ValuationService(mockDatabase, errorResolver);
      const result = await serviceWithError.compareResale({
        query: 'Test Card'
      });

      expect(result.recommendation).toBe('insufficient_data');
      expect(result.evidence).toContain('Internal error during valuation');
    });
  });

  describe('caching', () => {
    it('should provide cache statistics', () => {
      const stats = valuationService.getCacheStats();
      
      expect(stats).toHaveProperty('entries');
      expect(stats).toHaveProperty('hits');
      expect(stats).toHaveProperty('misses');
      expect(stats).toHaveProperty('ttlMinutes');
      expect(stats.ttlMinutes).toBe(15);
    });

    it('should clear cache', async () => {
      // Make a call to populate cache
      await valuationService.compareResale({ cardId: 'test-card-id' });
      
      let stats = valuationService.getCacheStats();
      expect(stats.entries).toBeGreaterThan(0);

      // Clear cache
      valuationService.clearCache();
      
      stats = valuationService.getCacheStats();
      expect(stats.entries).toBe(0);
    });
  });
});