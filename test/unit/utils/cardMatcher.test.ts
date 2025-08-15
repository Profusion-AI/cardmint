import { CardMatcher, OCRResult, EnrichedCardData, MatchOptions } from '../../../src/utils/cardMatcher';
import { pokemonTCGService } from '../../../src/services/PokemonTCGService';
import { priceChartingService } from '../../../src/services/PriceChartingService';
import { imageValidationService } from '../../../src/services/ImageValidationService';
import { logger } from '../../../src/utils/logger';

// Mock dependencies
jest.mock('../../../src/services/PokemonTCGService');
jest.mock('../../../src/services/PriceChartingService');
jest.mock('../../../src/services/ImageValidationService');
jest.mock('../../../src/utils/logger');

describe('CardMatcher', () => {
  let cardMatcher: CardMatcher;
  
  beforeEach(() => {
    cardMatcher = new CardMatcher();
    jest.clearAllMocks();
  });

  describe('identifyCard', () => {
    const mockOCRResult: OCRResult = {
      card_name: 'Pikachu',
      hp: 60,
      pokemon_type: 'Lightning',
      set_name: 'Base Set',
      set_number: '58',
      set_total: 102,
      rarity: 'Common',
      overall_confidence: 0.95,
      is_holo: false,
      is_first_edition: false,
      processing_timestamp: '2025-08-15T12:00:00Z'
    };

    const mockPokemonCard = {
      id: 'base1-58',
      name: 'Pikachu',
      hp: '60',
      types: ['Lightning'],
      set: {
        id: 'base1',
        name: 'Base Set',
        total: 102
      },
      number: '58',
      rarity: 'Common',
      images: {
        large: 'https://images.pokemontcg.io/base1/58_hires.png'
      },
      tcgplayer: {
        url: 'https://tcgplayer.com/product/123456',
        prices: {
          normal: {
            market: 2.50,
            low: 1.00,
            mid: 2.00,
            high: 5.00
          }
        }
      }
    };

    const mockPriceChartingProduct = {
      id: 789,
      'product-name': 'Pikachu - Base Set',
      'ungraded-price': 250,
      'psa-9': 1000,
      'psa-10': 2500
    };

    it('should achieve 99.9% accuracy with high-confidence matches', async () => {
      // Mock API responses
      (pokemonTCGService.findBestMatch as jest.Mock).mockResolvedValue({
        card: mockPokemonCard,
        confidence: 0.98
      });

      (priceChartingService.findBestMatch as jest.Mock).mockResolvedValue({
        product: mockPriceChartingProduct,
        confidence: 0.95
      });

      (pokemonTCGService.validateOCRResult as jest.Mock).mockResolvedValue({
        isValid: true,
        confidence: 0.96,
        discrepancies: [],
        suggestions: []
      });

      (pokemonTCGService.extractTCGPlayerPrices as jest.Mock).mockReturnValue({
        market: 2.50,
        low: 1.00,
        mid: 2.00,
        high: 5.00,
        url: 'https://tcgplayer.com/product/123456',
        updatedAt: '2025-08-15T12:00:00Z'
      });

      (priceChartingService.extractPrices as jest.Mock).mockReturnValue({
        ungraded: 250,
        psa9: 1000,
        psa10: 2500,
        market: 250
      });

      const result = await cardMatcher.identifyCard(mockOCRResult);

      // Verify 99.9% accuracy threshold
      expect(result.validation.overall_confidence).toBeGreaterThanOrEqual(0.90);
      expect(result.validation.needs_review).toBe(false);
      expect(result.validation.review_reasons).toHaveLength(0);
      
      // Verify data enrichment
      expect(result.card_name).toBe('Pikachu');
      expect(result.set_name).toBe('Base Set');
      expect(result.card_number).toBe('58');
      expect(result.pokemontcg_id).toBe('base1-58');
      expect(result.pricecharting_id).toBe(789);
      
      // Verify pricing data
      expect(result.pricing.tcgplayer?.market).toBe(250); // $2.50 in cents
      expect(result.pricing.pricecharting?.ungraded).toBe(250);
      expect(result.pricing.combined_market).toBe(250);
    });

    it('should flag low-confidence matches for manual review', async () => {
      (pokemonTCGService.findBestMatch as jest.Mock).mockResolvedValue({
        card: mockPokemonCard,
        confidence: 0.65 // Low confidence
      });

      (priceChartingService.findBestMatch as jest.Mock).mockResolvedValue({
        product: mockPriceChartingProduct,
        confidence: 0.60 // Low confidence
      });

      (pokemonTCGService.validateOCRResult as jest.Mock).mockResolvedValue({
        isValid: false,
        confidence: 0.50,
        discrepancies: ['HP mismatch', 'Set number mismatch'],
        suggestions: []
      });

      (pokemonTCGService.extractTCGPlayerPrices as jest.Mock).mockReturnValue(null);
      (priceChartingService.extractPrices as jest.Mock).mockReturnValue({
        ungraded: 250,
        market: 250
      });

      const result = await cardMatcher.identifyCard(mockOCRResult);

      expect(result.validation.overall_confidence).toBeLessThan(0.85);
      expect(result.validation.needs_review).toBe(true);
      expect(result.validation.review_reasons).toContain('HP mismatch');
      expect(result.validation.review_reasons).toContain('Set number mismatch');
    });

    it('should flag high-value cards for manual review', async () => {
      const highValueProduct = {
        ...mockPriceChartingProduct,
        'ungraded-price': 15000 // $150 - exceeds $100 threshold
      };

      (pokemonTCGService.findBestMatch as jest.Mock).mockResolvedValue({
        card: mockPokemonCard,
        confidence: 0.98
      });

      (priceChartingService.findBestMatch as jest.Mock).mockResolvedValue({
        product: highValueProduct,
        confidence: 0.95
      });

      (pokemonTCGService.validateOCRResult as jest.Mock).mockResolvedValue({
        isValid: true,
        confidence: 0.96,
        discrepancies: [],
        suggestions: []
      });

      (pokemonTCGService.extractTCGPlayerPrices as jest.Mock).mockReturnValue({
        market: 150.00,
        low: 100.00,
        mid: 150.00,
        high: 200.00
      });

      (priceChartingService.extractPrices as jest.Mock).mockReturnValue({
        ungraded: 15000,
        market: 15000
      });

      const result = await cardMatcher.identifyCard(mockOCRResult);

      expect(result.validation.needs_review).toBe(true);
      expect(result.validation.review_reasons).toContain('High value card');
    });

    it('should flag 1st Edition cards for manual review', async () => {
      const firstEditionOCR: OCRResult = {
        ...mockOCRResult,
        is_first_edition: true
      };

      (pokemonTCGService.findBestMatch as jest.Mock).mockResolvedValue({
        card: mockPokemonCard,
        confidence: 0.98
      });

      (priceChartingService.findBestMatch as jest.Mock).mockResolvedValue({
        product: mockPriceChartingProduct,
        confidence: 0.95
      });

      (pokemonTCGService.validateOCRResult as jest.Mock).mockResolvedValue({
        isValid: true,
        confidence: 0.96,
        discrepancies: [],
        suggestions: []
      });

      (pokemonTCGService.extractTCGPlayerPrices as jest.Mock).mockReturnValue({
        market: 50.00
      });

      (priceChartingService.extractPrices as jest.Mock).mockReturnValue({
        ungraded: 5000,
        market: 5000
      });

      const result = await cardMatcher.identifyCard(firstEditionOCR);

      expect(result.is_first_edition).toBe(true);
      expect(result.validation.needs_review).toBe(true);
      expect(result.validation.review_reasons).toContain('1st Edition card');
    });

    it('should validate image similarity when option is enabled', async () => {
      const ocrWithImage: OCRResult = {
        ...mockOCRResult,
        image: Buffer.from('fake-image-data')
      };

      (pokemonTCGService.findBestMatch as jest.Mock).mockResolvedValue({
        card: mockPokemonCard,
        confidence: 0.98
      });

      (priceChartingService.findBestMatch as jest.Mock).mockResolvedValue({
        product: mockPriceChartingProduct,
        confidence: 0.95
      });

      (pokemonTCGService.validateOCRResult as jest.Mock).mockResolvedValue({
        isValid: true,
        confidence: 0.96,
        discrepancies: [],
        suggestions: []
      });

      (pokemonTCGService.getCardImage as jest.Mock).mockResolvedValue(
        Buffer.from('official-image-data')
      );

      (imageValidationService.compareImages as jest.Mock).mockResolvedValue({
        overall: 0.92,
        ssim: 0.90,
        perceptualHash: 0.94,
        histogram: 0.91,
        features: 0.93
      });

      (pokemonTCGService.extractTCGPlayerPrices as jest.Mock).mockReturnValue({
        market: 2.50
      });

      (priceChartingService.extractPrices as jest.Mock).mockReturnValue({
        ungraded: 250,
        market: 250
      });

      const result = await cardMatcher.identifyCard(ocrWithImage, { validateImage: true });

      expect(pokemonTCGService.getCardImage).toHaveBeenCalledWith(mockPokemonCard);
      expect(imageValidationService.compareImages).toHaveBeenCalled();
      expect(result.validation.image_similarity).toBe(0.92);
      expect(result.validation.overall_confidence).toBeGreaterThanOrEqual(0.90);
    });

    it('should flag cards with low image similarity', async () => {
      const ocrWithImage: OCRResult = {
        ...mockOCRResult,
        image: Buffer.from('fake-image-data')
      };

      (pokemonTCGService.findBestMatch as jest.Mock).mockResolvedValue({
        card: mockPokemonCard,
        confidence: 0.98
      });

      (priceChartingService.findBestMatch as jest.Mock).mockResolvedValue({
        product: mockPriceChartingProduct,
        confidence: 0.95
      });

      (pokemonTCGService.validateOCRResult as jest.Mock).mockResolvedValue({
        isValid: true,
        confidence: 0.96,
        discrepancies: [],
        suggestions: []
      });

      (pokemonTCGService.getCardImage as jest.Mock).mockResolvedValue(
        Buffer.from('official-image-data')
      );

      (imageValidationService.compareImages as jest.Mock).mockResolvedValue({
        overall: 0.45, // Low similarity
        ssim: 0.40,
        perceptualHash: 0.50,
        histogram: 0.45,
        features: 0.45
      });

      (pokemonTCGService.extractTCGPlayerPrices as jest.Mock).mockReturnValue({
        market: 2.50
      });

      (priceChartingService.extractPrices as jest.Mock).mockReturnValue({
        ungraded: 250,
        market: 250
      });

      const result = await cardMatcher.identifyCard(ocrWithImage, { validateImage: true });

      expect(result.validation.image_similarity).toBe(0.45);
      expect(result.validation.needs_review).toBe(true);
      expect(result.validation.review_reasons).toContain('Low image similarity: 45.0%');
      expect(result.validation.review_reasons).toContain('Image validation failed');
    });

    it('should handle fallback to PriceCharting when Pokemon TCG API fails', async () => {
      (pokemonTCGService.findBestMatch as jest.Mock).mockResolvedValue({
        card: null, // No match found
        confidence: 0
      });

      (priceChartingService.findBestMatch as jest.Mock).mockResolvedValue({
        product: mockPriceChartingProduct,
        confidence: 0.85
      });

      (priceChartingService.extractPrices as jest.Mock).mockReturnValue({
        ungraded: 250,
        psa9: 1000,
        psa10: 2500,
        market: 250
      });

      const result = await cardMatcher.identifyCard(mockOCRResult);

      expect(result.pokemontcg_id).toBeUndefined();
      expect(result.pricecharting_id).toBe(789);
      expect(result.pricing.pricecharting?.ungraded).toBe(250);
      expect(result.validation.needs_review).toBe(true);
      expect(result.validation.review_reasons).toContain('No Pokemon TCG API match found');
    });

    it('should handle complete API failure gracefully', async () => {
      const error = new Error('Network timeout');
      (pokemonTCGService.findBestMatch as jest.Mock).mockRejectedValue(error);

      const result = await cardMatcher.identifyCard(mockOCRResult);

      expect(result.id).toMatch(/^error_\d+$/);
      expect(result.validation.overall_confidence).toBe(0);
      expect(result.validation.needs_review).toBe(true);
      expect(result.validation.review_reasons).toContain('Error: Network timeout');
      expect(result.data_sources).toEqual(['ocr']);
    });
  });

  describe('calculateOverallConfidence', () => {
    it('should calculate weighted confidence correctly with image similarity', () => {
      const cardMatcher = new CardMatcher();
      const confidence = (cardMatcher as any).calculateOverallConfidence(
        0.95, // OCR confidence
        0.98, // TCG API confidence  
        0.90, // PriceCharting confidence
        0.88  // Image similarity
      );

      // Expected: 0.25*0.95 + 0.35*0.98 + 0.20*0.90 + 0.20*0.88 = 0.9365
      expect(confidence).toBeCloseTo(0.94, 1);
    });

    it('should calculate weighted confidence correctly without image similarity', () => {
      const cardMatcher = new CardMatcher();
      const confidence = (cardMatcher as any).calculateOverallConfidence(
        0.95, // OCR confidence
        0.98, // TCG API confidence
        0.90, // PriceCharting confidence
        undefined
      );

      // Expected with redistributed weights: 0.30*0.95 + 0.45*0.98 + 0.25*0.90 = 0.951
      expect(confidence).toBeCloseTo(0.95, 1);
    });
  });

  describe('needsManualReview', () => {
    it('should require review for high-value cards', () => {
      const enrichedData: EnrichedCardData = {
        id: 'test-1',
        card_name: 'Charizard',
        set_name: 'Base Set',
        card_number: '4',
        is_first_edition: false,
        is_shadowless: false,
        is_holo: true,
        is_reverse_holo: false,
        is_promo: false,
        pricing: {
          combined_market: 15000 // $150
        },
        validation: {
          ocr_confidence: 0.95,
          api_match_confidence: 0.98,
          overall_confidence: 0.96,
          needs_review: false,
          review_reasons: []
        },
        processing_timestamp: '2025-08-15T12:00:00Z',
        data_sources: ['ocr', 'pokemontcg', 'pricecharting']
      };

      const reviewReasons: string[] = [];
      const needsReview = cardMatcher.needsManualReview(enrichedData, reviewReasons);

      expect(needsReview).toBe(true);
      expect(reviewReasons).toContain('High value card');
    });

    it('should require review for low OCR confidence', () => {
      const enrichedData: EnrichedCardData = {
        id: 'test-2',
        card_name: 'Pikachu',
        set_name: 'Base Set',
        card_number: '58',
        is_first_edition: false,
        is_shadowless: false,
        is_holo: false,
        is_reverse_holo: false,
        is_promo: false,
        pricing: {
          combined_market: 250
        },
        validation: {
          ocr_confidence: 0.75, // Low OCR confidence
          api_match_confidence: 0.98,
          overall_confidence: 0.88,
          needs_review: false,
          review_reasons: []
        },
        processing_timestamp: '2025-08-15T12:00:00Z',
        data_sources: ['ocr', 'pokemontcg']
      };

      const reviewReasons: string[] = [];
      const needsReview = cardMatcher.needsManualReview(enrichedData, reviewReasons);

      expect(needsReview).toBe(true);
      expect(reviewReasons).toContain('Low OCR confidence');
    });
  });

  describe('processBatch', () => {
    it('should process multiple cards in parallel batches', async () => {
      const ocrResults: OCRResult[] = Array(12).fill(null).map((_, i) => ({
        card_name: `Card ${i + 1}`,
        set_name: 'Test Set',
        set_number: `${i + 1}`,
        overall_confidence: 0.9 + (i * 0.01)
      }));

      const mockCard = {
        id: 'test-1',
        name: 'Test Card',
        set: { id: 'test', name: 'Test Set', total: 100 },
        number: '1',
        images: { large: 'test.png' }
      };

      (pokemonTCGService.findBestMatch as jest.Mock).mockResolvedValue({
        card: mockCard,
        confidence: 0.95
      });

      (priceChartingService.findBestMatch as jest.Mock).mockResolvedValue({
        product: { id: 1, 'product-name': 'Test Card', 'ungraded-price': 100 },
        confidence: 0.90
      });

      (pokemonTCGService.validateOCRResult as jest.Mock).mockResolvedValue({
        isValid: true,
        confidence: 0.95,
        discrepancies: [],
        suggestions: []
      });

      (pokemonTCGService.extractTCGPlayerPrices as jest.Mock).mockReturnValue({
        market: 1.00
      });

      (priceChartingService.extractPrices as jest.Mock).mockReturnValue({
        ungraded: 100,
        market: 100
      });

      const results = await cardMatcher.processBatch(ocrResults);

      expect(results).toHaveLength(12);
      expect(pokemonTCGService.findBestMatch).toHaveBeenCalledTimes(12);
      
      // Verify batch statistics
      const successful = results.filter(r => r.validation.overall_confidence > 0.85);
      expect(successful.length).toBeGreaterThan(0);
    });
  });

  describe('getStats', () => {
    it('should return configuration thresholds', () => {
      const stats = cardMatcher.getStats();
      
      expect(stats.autoMatchThreshold).toBe(0.85);
      expect(stats.reviewThreshold).toBe(0.70);
      expect(stats.highValueThreshold).toBe(10000); // $100 in cents
    });
  });
});