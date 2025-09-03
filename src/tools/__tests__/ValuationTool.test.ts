/**
 * Unit tests for ValuationTool
 * 
 * Tests the GPT-OSS tool interface and JSON transformation logic.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ValuationTool } from '../ValuationTool';
import { ValuationService, ValuationResult } from '../../services/ValuationService';

// Mock ValuationService
const createMockValuationService = (): ValuationService => {
  const mockResult: ValuationResult = {
    recommendation: 'graded',
    rawNetCents: 4050, // $40.50
    gradedNetCents: 5280, // $52.80
    chosenBasis: 'PSA',
    assumptions: {
      fees: { raw: 0.13, graded: 0.10 },
      costs: { grading: 2000, shipping: 1000 },
      priors: { psa9: 0.70, psa10: 0.30 }
    },
    confidence: 0.92,
    evidence: [
      'Raw market price: $50.00',
      'Raw net after fees: $40.50',
      'Best graded price: PSA 10 at $120.00',
      'Graded net after costs: $52.80',
      'Grading advantage: $12.30'
    ]
  };

  return {
    compareResale: vi.fn().mockResolvedValue(mockResult),
    getCacheStats: vi.fn().mockReturnValue({ entries: 5, hits: 10, misses: 2, ttlMinutes: 15 }),
    clearCache: vi.fn()
  } as any;
};

describe('ValuationTool', () => {
  let mockValuationService: ValuationService;
  let valuationTool: ValuationTool;

  beforeEach(() => {
    mockValuationService = createMockValuationService();
    valuationTool = new ValuationTool(mockValuationService);
  });

  describe('compareResale', () => {
    it('should transform ValuationResult to tool output format', async () => {
      const result = await valuationTool.compareResale({
        query: 'Charizard Base Set unlimited'
      });

      expect(result).toBeDefined();
      expect(result.recommendation).toBe('graded');
      expect(result.summary).toContain('Grading recommended');
      expect(result.summary).toContain('$12.30');
      
      expect(result.details).toEqual({
        rawNetCents: 4050,
        gradedNetCents: 5280,
        advantageCents: 1230, // 5280 - 4050
        chosenBasis: 'PSA',
        confidence: 0.92
      });

      expect(result.assumptions).toEqual({
        fees: 'eBay 13.0%, Fanatics 10.0%',
        costs: 'Grading $20, Shipping $10',
        priors: 'PSA 9: 70%, PSA 10: 30%'
      });

      expect(result.evidence).toHaveLength(5);
      expect(result.metadata.processingTimeMs).toBeGreaterThan(0);
    });

    it('should handle raw recommendation', async () => {
      const mockRawResult: ValuationResult = {
        recommendation: 'raw',
        rawNetCents: 5000,
        gradedNetCents: 4500,
        chosenBasis: 'PSA',
        assumptions: {
          fees: { raw: 0.13, graded: 0.10 },
          costs: { grading: 2000, shipping: 1000 },
          priors: { psa9: 0.70, psa10: 0.30 }
        },
        confidence: 0.85,
        evidence: ['Raw advantage: $5.00']
      };

      mockValuationService.compareResale = vi.fn().mockResolvedValue(mockRawResult);

      const result = await valuationTool.compareResale({
        cardId: 'test-card-id'
      });

      expect(result.recommendation).toBe('raw');
      expect(result.summary).toContain('Sell raw recommended');
      expect(result.summary).toContain('$5.00');
      expect(result.details.advantageCents).toBe(-500); // negative advantage for grading
    });

    it('should handle insufficient data', async () => {
      const mockInsufficientResult: ValuationResult = {
        recommendation: 'insufficient_data',
        rawNetCents: 0,
        gradedNetCents: 0,
        chosenBasis: 'none',
        assumptions: {
          fees: { raw: 0.13, graded: 0.10 },
          costs: { grading: 2000, shipping: 1000 },
          priors: { psa9: 0.70, psa10: 0.30 }
        },
        confidence: 0,
        evidence: ['No market price data available']
      };

      mockValuationService.compareResale = vi.fn().mockResolvedValue(mockInsufficientResult);

      const result = await valuationTool.compareResale({
        query: 'Unknown Card'
      });

      expect(result.recommendation).toBe('insufficient_data');
      expect(result.summary).toBe('Unable to provide valuation due to insufficient price data');
      expect(result.details.confidence).toBe(0);
      expect(result.details.advantageCents).toBe(0);
    });

    it('should pass through variant parameters', async () => {
      const input = {
        cardId: 'test-card-id',
        variant: {
          finish: 'holo' as const,
          edition: '1st' as const
        }
      };

      await valuationTool.compareResale(input);

      expect(mockValuationService.compareResale).toHaveBeenCalledWith({
        cardId: 'test-card-id',
        query: undefined,
        variant: {
          finish: 'holo',
          edition: '1st'
        }
      });
    });

    it('should handle service errors gracefully', async () => {
      mockValuationService.compareResale = vi.fn().mockRejectedValue(
        new Error('Database connection failed')
      );

      const result = await valuationTool.compareResale({
        query: 'Test Card'
      });

      expect(result.recommendation).toBe('insufficient_data');
      expect(result.summary).toBe('Valuation service temporarily unavailable');
      expect(result.details.confidence).toBe(0);
      expect(result.evidence).toContain('Service error occurred during valuation');
    });

    it('should measure processing time', async () => {
      const result = await valuationTool.compareResale({
        cardId: 'test-card-id'
      });

      expect(result.metadata.processingTimeMs).toBeGreaterThan(0);
      expect(result.metadata.processingTimeMs).toBeLessThan(1000); // Should be fast
    });
  });

  describe('tool metadata', () => {
    it('should provide correct tool metadata', () => {
      const metadata = ValuationTool.getToolMetadata();

      expect(metadata.name).toBe('valuation.compareResale');
      expect(metadata.description).toContain('Compare raw vs graded resale value');
      expect(metadata.parameters).toHaveProperty('type', 'object');
      expect(metadata.parameters.properties).toHaveProperty('query');
      expect(metadata.parameters.properties).toHaveProperty('cardId');
      expect(metadata.parameters.properties).toHaveProperty('variant');
    });
  });

  describe('health check', () => {
    it('should return healthy status', async () => {
      const health = await valuationTool.healthCheck();

      expect(health.available).toBe(true);
      expect(health.message).toContain('ValuationTool healthy');
      expect(health.message).toContain('cached entries');
    });

    it('should handle unhealthy service', async () => {
      mockValuationService.getCacheStats = vi.fn().mockImplementation(() => {
        throw new Error('Service unavailable');
      });

      const health = await valuationTool.healthCheck();

      expect(health.available).toBe(false);
      expect(health.message).toContain('ValuationTool unavailable');
      expect(health.message).toContain('Service unavailable');
    });
  });
});