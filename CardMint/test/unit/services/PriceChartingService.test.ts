import { PriceChartingService } from '../../../src/services/PriceChartingService';
import axios from 'axios';
import NodeCache from 'node-cache';
import { logger } from '../../../src/utils/logger';

jest.mock('axios');
jest.mock('../../../src/utils/logger');

describe('PriceChartingService', () => {
  let service: PriceChartingService;
  let mockAxios: jest.Mocked<typeof axios>;

  beforeEach(() => {
    mockAxios = axios as jest.Mocked<typeof axios>;
    // Create a new instance for each test
    service = new PriceChartingService();
    jest.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize and fetch bulk data successfully', async () => {
      const mockCSVData = `console-name,product-name,id,ungraded-price,psa-9,psa-10,bgs-10
Pokemon Cards,Pikachu - Base Set,12345,250,1000,2500,2400
Pokemon Cards,Charizard - Base Set,12346,50000,100000,250000,240000`;

      mockAxios.get.mockResolvedValueOnce({
        data: mockCSVData,
        status: 200
      });

      await service.initialize();

      expect(mockAxios.get).toHaveBeenCalledWith(
        'https://www.pricecharting.com/api/products',
        expect.objectContaining({
          params: { t: expect.any(String) },
          headers: { 'X-API-KEY': expect.any(String) }
        })
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('bulk data loaded'),
        expect.objectContaining({ count: 2 })
      );
    });

    it('should handle initialization failure gracefully', async () => {
      mockAxios.get.mockRejectedValueOnce(new Error('Network error'));

      await service.initialize();

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to fetch PriceCharting bulk data',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  describe('findBestMatch', () => {
    beforeEach(async () => {
      const mockCSVData = `console-name,product-name,id,ungraded-price,psa-9,psa-10,bgs-10
Pokemon Cards,Pikachu - Base Set,12345,250,1000,2500,2400
Pokemon Cards,Pikachu - Jungle,12347,200,800,2000,1900
Pokemon Cards,Charizard - Base Set,12346,50000,100000,250000,240000
Pokemon Cards,Pikachu VMAX - Vivid Voltage,12348,3000,5000,8000,7500`;

      mockAxios.get.mockResolvedValueOnce({
        data: mockCSVData,
        status: 200
      });

      await service.initialize();
    });

    it('should find exact match with high confidence', async () => {
      const result = await service.findBestMatch('Pikachu', 'Base Set', '58');

      expect(result.product).toBeDefined();
      expect(result.product?.['product-name']).toBe('Pikachu - Base Set');
      expect(result.confidence).toBeGreaterThanOrEqual(0.90);
      expect(result.matchType).toBe('exact');
    });

    it('should find fuzzy match with moderate confidence', async () => {
      const result = await service.findBestMatch('Pikachu VMAX', 'Vivid Voltage');

      expect(result.product).toBeDefined();
      expect(result.product?.['product-name']).toContain('Pikachu VMAX');
      expect(result.confidence).toBeGreaterThanOrEqual(0.70);
      expect(result.matchType).toBe('fuzzy');
    });

    it('should return null for no match', async () => {
      const result = await service.findBestMatch('Nonexistent Card', 'Fake Set');

      expect(result.product).toBeNull();
      expect(result.confidence).toBe(0);
      expect(result.matchType).toBe('none');
    });

    it('should handle special characters in card names', async () => {
      const result = await service.findBestMatch('Pikachu', 'Base Set', '58/102');

      expect(result.product).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0);
    });
  });

  describe('searchByName', () => {
    it('should search API when no bulk data available', async () => {
      const mockApiResponse = {
        data: {
          products: [
            {
              id: '12345',
              'product-name': 'Pikachu - Base Set',
              'ungraded-price': '$2.50'
            }
          ]
        }
      };

      mockAxios.get.mockResolvedValueOnce(mockApiResponse);

      const result = await service.searchByName('Pikachu Base Set');

      expect(mockAxios.get).toHaveBeenCalledWith(
        'https://www.pricecharting.com/api/products',
        expect.objectContaining({
          params: { q: 'Pikachu Base Set' }
        })
      );
      expect(result).toHaveLength(1);
      expect(result[0]['product-name']).toBe('Pikachu - Base Set');
    });

    it('should handle API errors with circuit breaker pattern', async () => {
      // Simulate multiple failures
      mockAxios.get.mockRejectedValue(new Error('API Error'));

      const results = await Promise.all([
        service.searchByName('Card 1'),
        service.searchByName('Card 2'),
        service.searchByName('Card 3')
      ]);

      // Should return empty arrays on failure
      results.forEach(result => {
        expect(result).toEqual([]);
      });

      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('extractPrices', () => {
    it('should extract all price fields correctly', () => {
      const product = {
        id: 12345,
        'product-name': 'Charizard - Base Set',
        'ungraded-price': 50000,
        'psa-9': 100000,
        'psa-10': 250000,
        'bgs-9': 95000,
        'bgs-9.5': 150000,
        'bgs-10': 240000,
        'cgc-9': 90000,
        'cgc-9.5': 140000,
        'cgc-10': 230000
      };

      const prices = service.extractPrices(product);

      expect(prices.ungraded).toBe(50000);
      expect(prices.psa9).toBe(100000);
      expect(prices.psa10).toBe(250000);
      expect(prices.bgs9).toBe(95000);
      expect(prices.bgs95).toBe(150000);
      expect(prices.bgs10).toBe(240000);
      expect(prices.cgc9).toBe(90000);
      expect(prices.cgc95).toBe(140000);
      expect(prices.cgc10).toBe(230000);
      expect(prices.market).toBe(50000); // Should default to ungraded
    });

    it('should handle missing price fields', () => {
      const product = {
        id: 12345,
        'product-name': 'Unknown Card'
      };

      const prices = service.extractPrices(product);

      expect(prices.ungraded).toBeUndefined();
      expect(prices.psa10).toBeUndefined();
      expect(prices.market).toBeUndefined();
    });

    it('should convert string prices to numbers', () => {
      const product = {
        id: 12345,
        'product-name': 'Test Card',
        'ungraded-price': '$25.00',
        'psa-10': '$100.00'
      };

      const prices = service.extractPrices(product);

      expect(prices.ungraded).toBe(2500); // $25.00 in cents
      expect(prices.psa10).toBe(10000); // $100.00 in cents
    });
  });

  describe('getProductById', () => {
    it('should retrieve product by ID from API', async () => {
      const mockProduct = {
        id: '12345',
        'product-name': 'Pikachu - Base Set',
        'ungraded-price': 250
      };

      mockAxios.get.mockResolvedValueOnce({ data: mockProduct });

      const result = await service.getProductById('12345');

      expect(mockAxios.get).toHaveBeenCalledWith(
        'https://www.pricecharting.com/api/product/12345',
        expect.objectContaining({
          headers: { 'X-API-KEY': expect.any(String) }
        })
      );
      expect(result).toEqual(mockProduct);
    });

    it('should return null on API error', async () => {
      mockAxios.get.mockRejectedValueOnce(new Error('Not found'));

      const result = await service.getProductById('99999');

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalled();
    });

    it('should use cache for repeated requests', async () => {
      const mockProduct = {
        id: '12345',
        'product-name': 'Cached Card'
      };

      mockAxios.get.mockResolvedValueOnce({ data: mockProduct });

      // First call - hits API
      const result1 = await service.getProductById('12345');
      expect(mockAxios.get).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      const result2 = await service.getProductById('12345');
      expect(mockAxios.get).toHaveBeenCalledTimes(1); // Still only 1 call

      expect(result1).toEqual(result2);
    });
  });

  describe('confidence scoring', () => {
    beforeEach(async () => {
      const mockCSVData = `console-name,product-name,id,ungraded-price,psa-9,psa-10
Pokemon Cards,Pikachu - Base Set,12345,250,1000,2500
Pokemon Cards,Pikachu - Base Set 2,12346,200,900,2200
Pokemon Cards,Raichu - Base Set,12347,500,1500,3000`;

      mockAxios.get.mockResolvedValueOnce({
        data: mockCSVData,
        status: 200
      });

      await service.initialize();
    });

    it('should score exact matches highest', async () => {
      const exactMatch = await service.findBestMatch('Pikachu', 'Base Set', '58');
      const fuzzyMatch = await service.findBestMatch('Pika', 'Base', '58');
      const poorMatch = await service.findBestMatch('Raichu', 'Jungle', '14');

      expect(exactMatch.confidence).toBeGreaterThan(fuzzyMatch.confidence);
      expect(fuzzyMatch.confidence).toBeGreaterThan(poorMatch.confidence);
    });

    it('should boost confidence for matching card numbers', async () => {
      const withNumber = await service.findBestMatch('Pikachu', 'Base Set', '58');
      const withoutNumber = await service.findBestMatch('Pikachu', 'Base Set');

      // Card number should provide additional confidence
      expect(withNumber.confidence).toBeGreaterThanOrEqual(withoutNumber.confidence);
    });
  });

  describe('formatForQuery', () => {
    it('should format Pokemon card names correctly', () => {
      const formatted = service.formatForQuery('Pikachu', 'Base Set', '58');
      expect(formatted).toBe('Pikachu Base Set 58');
    });

    it('should handle special characters', () => {
      const formatted = service.formatForQuery('Pikachu VMAX', "Champion's Path", '9/73');
      expect(formatted).toBe("Pikachu VMAX Champion's Path 9/73");
    });

    it('should handle missing values', () => {
      const formatted = service.formatForQuery('Pikachu');
      expect(formatted).toBe('Pikachu');
    });
  });

  describe('cache management', () => {
    it('should respect cache TTL', async () => {
      const service = new PriceChartingService();
      const cache = (service as any).cache as NodeCache;
      
      // Set a short TTL for testing
      cache.options.stdTTL = 1; // 1 second

      const mockProduct = {
        id: '12345',
        'product-name': 'Test Card'
      };

      mockAxios.get.mockResolvedValue({ data: mockProduct });

      // First call
      await service.getProductById('12345');
      expect(mockAxios.get).toHaveBeenCalledTimes(1);

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Second call after expiry
      await service.getProductById('12345');
      expect(mockAxios.get).toHaveBeenCalledTimes(2);
    });
  });
});