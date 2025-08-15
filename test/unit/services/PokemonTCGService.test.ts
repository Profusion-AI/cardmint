import { PokemonTCGService, PokemonCard } from '../../../src/services/PokemonTCGService';
import axios from 'axios';
import { logger } from '../../../src/utils/logger';

jest.mock('axios');
jest.mock('../../../src/utils/logger');

describe('PokemonTCGService', () => {
  let service: PokemonTCGService;
  let mockAxios: jest.Mocked<typeof axios>;

  const mockPikachuCard: PokemonCard = {
    id: 'base1-58',
    name: 'Pikachu',
    supertype: 'Pokémon',
    subtypes: ['Basic'],
    hp: '60',
    types: ['Lightning'],
    evolvesTo: ['Raichu'],
    attacks: [
      {
        name: 'Thunder Jolt',
        cost: ['Lightning', 'Colorless'],
        convertedEnergyCost: 2,
        damage: '30',
        text: 'Flip a coin. If tails, Pikachu does 10 damage to itself.'
      }
    ],
    weaknesses: [{ type: 'Fighting', value: '×2' }],
    retreatCost: ['Colorless'],
    convertedRetreatCost: 1,
    number: '58',
    artist: 'Mitsuhiro Arita',
    rarity: 'Common',
    set: {
      id: 'base1',
      name: 'Base Set',
      series: 'Base',
      printedTotal: 102,
      total: 102,
      releaseDate: '1999-01-09',
      images: {
        symbol: 'https://images.pokemontcg.io/base1/symbol.png',
        logo: 'https://images.pokemontcg.io/base1/logo.png'
      }
    },
    images: {
      small: 'https://images.pokemontcg.io/base1/58.png',
      large: 'https://images.pokemontcg.io/base1/58_hires.png'
    },
    tcgplayer: {
      url: 'https://prices.pokemontcg.io/tcgplayer/base1-58',
      updatedAt: '2025-08-15',
      prices: {
        normal: {
          low: 0.50,
          mid: 1.50,
          high: 5.00,
          market: 2.00,
          directLow: 0.75
        }
      }
    },
    cardmarket: {
      url: 'https://prices.pokemontcg.io/cardmarket/base1-58',
      updatedAt: '2025-08-15',
      prices: {
        averageSellPrice: 1.80,
        lowPrice: 0.45,
        trendPrice: 1.95
      }
    }
  };

  beforeEach(() => {
    mockAxios = axios as jest.Mocked<typeof axios>;
    mockAxios.create.mockReturnValue(mockAxios as any);
    service = new PokemonTCGService();
    jest.clearAllMocks();
  });

  describe('searchCards', () => {
    it('should search cards with proper query formatting', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: {
          data: [mockPikachuCard],
          page: 1,
          pageSize: 20,
          count: 1,
          totalCount: 1
        }
      });

      const results = await service.searchCards('name:Pikachu set.name:"Base Set"');

      expect(mockAxios.get).toHaveBeenCalledWith('/cards', {
        params: {
          q: 'name:Pikachu set.name:"Base Set"',
          page: 1,
          pageSize: 20
        }
      });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Pikachu');
    });

    it('should handle API errors gracefully', async () => {
      mockAxios.get.mockRejectedValueOnce(new Error('API Error'));

      const results = await service.searchCards('name:InvalidCard');

      expect(results).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to search Pokemon TCG cards',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it('should handle rate limiting with retry', async () => {
      // First call fails with 429
      mockAxios.get.mockRejectedValueOnce({
        response: { status: 429 }
      });

      // Second call succeeds
      mockAxios.get.mockResolvedValueOnce({
        data: {
          data: [mockPikachuCard],
          totalCount: 1
        }
      });

      const results = await service.searchCards('name:Pikachu');

      expect(mockAxios.get).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(1);
    });
  });

  describe('findBestMatch', () => {
    const mockOCRResult = {
      card_name: 'Pikachu',
      hp: 60,
      pokemon_type: 'Lightning',
      set_name: 'Base Set',
      set_number: '58',
      set_total: 102,
      rarity: 'Common',
      overall_confidence: 0.95
    };

    it('should find exact match with high confidence', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: {
          data: [mockPikachuCard],
          totalCount: 1
        }
      });

      const result = await service.findBestMatch(mockOCRResult);

      expect(result.card).toEqual(mockPikachuCard);
      expect(result.confidence).toBeGreaterThanOrEqual(0.90);
      expect(result.matchType).toBe('exact');
    });

    it('should find fuzzy match when exact match fails', async () => {
      // First exact search returns nothing
      mockAxios.get.mockResolvedValueOnce({
        data: { data: [], totalCount: 0 }
      });

      // Fuzzy search returns results
      mockAxios.get.mockResolvedValueOnce({
        data: {
          data: [mockPikachuCard],
          totalCount: 1
        }
      });

      const result = await service.findBestMatch({
        ...mockOCRResult,
        card_name: 'Pikchu' // Typo
      });

      expect(mockAxios.get).toHaveBeenCalledTimes(2);
      expect(result.card).toEqual(mockPikachuCard);
      expect(result.confidence).toBeLessThan(0.90);
      expect(result.matchType).toBe('fuzzy');
    });

    it('should return null when no match found', async () => {
      mockAxios.get.mockResolvedValue({
        data: { data: [], totalCount: 0 }
      });

      const result = await service.findBestMatch({
        card_name: 'Nonexistent Card',
        set_name: 'Fake Set'
      });

      expect(result.card).toBeNull();
      expect(result.confidence).toBe(0);
      expect(result.matchType).toBe('none');
    });

    it('should score multiple matches and return best', async () => {
      const pikachu2 = { ...mockPikachuCard, id: 'base2-60', set: { ...mockPikachuCard.set, name: 'Base Set 2' } };
      
      mockAxios.get.mockResolvedValueOnce({
        data: {
          data: [mockPikachuCard, pikachu2],
          totalCount: 2
        }
      });

      const result = await service.findBestMatch(mockOCRResult);

      expect(result.card).toEqual(mockPikachuCard); // Should prefer Base Set over Base Set 2
      expect(result.alternatives).toHaveLength(1);
      expect(result.alternatives![0]).toEqual(pikachu2);
    });
  });

  describe('validateOCRResult', () => {
    const mockOCRResult = {
      card_name: 'Pikachu',
      hp: 60,
      pokemon_type: 'Lightning',
      set_name: 'Base Set',
      set_number: '58',
      attacks: [
        {
          name: 'Thunder Jolt',
          damage: '30',
          energy_cost: ['Lightning', 'Colorless']
        }
      ],
      weakness: 'Fighting',
      retreat_cost: 1
    };

    it('should validate matching OCR data', () => {
      const validation = service.validateOCRResult(mockOCRResult, mockPikachuCard);

      expect(validation.isValid).toBe(true);
      expect(validation.confidence).toBeGreaterThan(0.90);
      expect(validation.discrepancies).toHaveLength(0);
    });

    it('should detect HP mismatch', () => {
      const validation = service.validateOCRResult(
        { ...mockOCRResult, hp: 70 }, // Wrong HP
        mockPikachuCard
      );

      expect(validation.isValid).toBe(false);
      expect(validation.discrepancies).toContain('HP mismatch: OCR says 70, API says 60');
      expect(validation.confidence).toBeLessThan(0.90);
    });

    it('should detect card number mismatch', () => {
      const validation = service.validateOCRResult(
        { ...mockOCRResult, set_number: '59' }, // Wrong number
        mockPikachuCard
      );

      expect(validation.isValid).toBe(false);
      expect(validation.discrepancies).toContain('Card number mismatch: OCR says 59, API says 58');
    });

    it('should detect attack differences', () => {
      const validation = service.validateOCRResult(
        {
          ...mockOCRResult,
          attacks: [
            {
              name: 'Thunder Shock', // Wrong attack name
              damage: '30'
            }
          ]
        },
        mockPikachuCard
      );

      expect(validation.isValid).toBe(false);
      expect(validation.discrepancies).toContain('Attack mismatch: Thunder Shock not found in API data');
    });

    it('should provide suggestions for close matches', () => {
      const validation = service.validateOCRResult(
        { ...mockOCRResult, card_name: 'Pikchu' }, // Typo
        mockPikachuCard
      );

      expect(validation.suggestions).toContain('Card name might be: Pikachu');
    });
  });

  describe('getCardById', () => {
    it('should fetch card by ID', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: { data: mockPikachuCard }
      });

      const card = await service.getCardById('base1-58');

      expect(mockAxios.get).toHaveBeenCalledWith('/cards/base1-58');
      expect(card).toEqual(mockPikachuCard);
    });

    it('should cache repeated requests', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: { data: mockPikachuCard }
      });

      // First call
      await service.getCardById('base1-58');
      // Second call - should use cache
      await service.getCardById('base1-58');

      expect(mockAxios.get).toHaveBeenCalledTimes(1);
    });

    it('should handle 404 errors', async () => {
      mockAxios.get.mockRejectedValueOnce({
        response: { status: 404 }
      });

      const card = await service.getCardById('invalid-id');

      expect(card).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'Card not found',
        { cardId: 'invalid-id' }
      );
    });
  });

  describe('getCardImage', () => {
    it('should download and return card image', async () => {
      const mockImageData = Buffer.from('fake-image-data');
      mockAxios.get.mockResolvedValueOnce({
        data: mockImageData
      });

      const image = await service.getCardImage(mockPikachuCard);

      expect(mockAxios.get).toHaveBeenCalledWith(
        mockPikachuCard.images.large,
        { responseType: 'arraybuffer' }
      );
      expect(image).toEqual(mockImageData);
    });

    it('should handle image download failure', async () => {
      mockAxios.get.mockRejectedValueOnce(new Error('Network error'));

      const image = await service.getCardImage(mockPikachuCard);

      expect(image).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to download card image',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  describe('extractTCGPlayerPrices', () => {
    it('should extract normal prices correctly', () => {
      const prices = service.extractTCGPlayerPrices(mockPikachuCard);

      expect(prices).toEqual({
        market: 2.00,
        low: 0.50,
        mid: 1.50,
        high: 5.00,
        directLow: 0.75,
        url: 'https://prices.pokemontcg.io/tcgplayer/base1-58',
        updatedAt: '2025-08-15'
      });
    });

    it('should extract holofoil prices when available', () => {
      const holoCard = {
        ...mockPikachuCard,
        tcgplayer: {
          url: 'https://prices.pokemontcg.io/tcgplayer/base1-4',
          updatedAt: '2025-08-15',
          prices: {
            holofoil: {
              low: 50.00,
              mid: 100.00,
              high: 200.00,
              market: 120.00
            }
          }
        }
      };

      const prices = service.extractTCGPlayerPrices(holoCard);

      expect(prices?.market).toBe(120.00);
      expect(prices?.low).toBe(50.00);
    });

    it('should handle missing TCGPlayer data', () => {
      const cardWithoutPrices = {
        ...mockPikachuCard,
        tcgplayer: undefined
      };

      const prices = service.extractTCGPlayerPrices(cardWithoutPrices as any);

      expect(prices).toBeNull();
    });
  });

  describe('buildSearchQuery', () => {
    it('should build exact search query', () => {
      const query = service.buildSearchQuery({
        card_name: 'Pikachu',
        set_name: 'Base Set',
        set_number: '58'
      });

      expect(query).toBe('name:"Pikachu" set.name:"Base Set" number:58');
    });

    it('should build fuzzy search query', () => {
      const query = service.buildSearchQuery(
        { card_name: 'Pikachu' },
        true // fuzzy
      );

      expect(query).toBe('name:Pikachu*');
    });

    it('should handle special characters', () => {
      const query = service.buildSearchQuery({
        card_name: "Pikachu & Zekrom-GX"
      });

      expect(query).toBe('name:"Pikachu & Zekrom-GX"');
    });

    it('should handle partial data', () => {
      const query = service.buildSearchQuery({
        set_name: 'Vivid Voltage'
      });

      expect(query).toBe('set.name:"Vivid Voltage"');
    });
  });

  describe('calculateMatchScore', () => {
    it('should score exact matches highest', () => {
      const score = service.calculateMatchScore(
        {
          card_name: 'Pikachu',
          hp: 60,
          set_name: 'Base Set',
          set_number: '58',
          rarity: 'Common'
        },
        mockPikachuCard
      );

      expect(score).toBeGreaterThan(0.95);
    });

    it('should penalize mismatches', () => {
      const score = service.calculateMatchScore(
        {
          card_name: 'Raichu', // Wrong name
          hp: 90, // Wrong HP
          set_name: 'Jungle', // Wrong set
          set_number: '14' // Wrong number
        },
        mockPikachuCard
      );

      expect(score).toBeLessThan(0.30);
    });

    it('should handle partial matches', () => {
      const score = service.calculateMatchScore(
        {
          card_name: 'Pikachu',
          set_name: 'Base Set'
          // Missing other fields
        },
        mockPikachuCard
      );

      expect(score).toBeGreaterThan(0.60);
      expect(score).toBeLessThan(0.90);
    });
  });
});