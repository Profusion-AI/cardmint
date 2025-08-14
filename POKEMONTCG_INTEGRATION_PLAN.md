# Pokemon TCG API Integration Plan for CardMint

## Executive Summary

This document outlines the integration of the Pokemon TCG API (pokemontcg.io) into CardMint's existing card identification pipeline. This integration complements the PriceCharting API by providing high-resolution card images, comprehensive metadata, and visual validation capabilities to achieve 99%+ card identification accuracy.

## Integration Overview

### API Credentials
- **API Key**: 8560cda2-6058-41fd-b862-9f4cad531730
- **Base URL**: https://api.pokemontcg.io/v2
- **Documentation**: https://docs.pokemontcg.io

### Key Benefits
1. **High-Resolution Card Images**: Official card scans for visual validation
2. **Comprehensive Metadata**: Complete card attributes including attacks, abilities, types
3. **Dual Pricing Sources**: TCGPlayer prices to cross-reference with PriceCharting
4. **Advanced Search**: Lucene-like syntax for precise card matching
5. **Set Information**: Complete set data and card variations

## Architecture Design

### Data Flow
```
┌─────────────┐      ┌──────────────┐      ┌─────────────────┐
│  Camera     │ ───> │     OCR      │ ───> │ Pokemon TCG API │
│  Capture    │      │  Extraction  │      │   (Card ID)     │
└─────────────┘      └──────────────┘      └─────────────────┘
                                                     │
                                                     ▼
┌─────────────┐      ┌──────────────┐      ┌─────────────────┐
│  Database   │ <─── │   Combined   │ <─── │  PriceCharting  │
│   Storage   │      │   Enrichment │      │   (Pricing)     │
└─────────────┘      └──────────────┘      └─────────────────┘
                            ▲
                            │
                    ┌───────────────┐
                    │ Image         │
                    │ Validation    │
                    └───────────────┘
```

### Service Integration Strategy
1. **Primary Identification**: Pokemon TCG API for card matching
2. **Visual Validation**: Compare OCR image with official card image
3. **Price Enrichment**: Combine TCGPlayer and PriceCharting prices
4. **Data Storage**: Store enriched data with confidence scores

## Implementation Details

### 1. Pokemon TCG Service Module

**File**: `src/services/PokemonTCGService.ts`

```typescript
interface PokemonCard {
  id: string;                    // Unique card ID
  name: string;                  // Card name
  supertype: string;             // Pokemon, Trainer, Energy
  subtypes: string[];            // Stage 1, VMAX, etc.
  hp?: string;                   // Hit points
  types?: string[];              // Pokemon types
  evolvesFrom?: string;          // Evolution chain
  abilities?: Ability[];         // Special abilities
  attacks?: Attack[];            // Attack moves
  weaknesses?: Weakness[];       // Type weaknesses
  resistances?: Resistance[];    // Type resistances
  retreatCost?: string[];        // Retreat energy cost
  convertedRetreatCost?: number; // Numeric retreat cost
  set: Set;                      // Set information
  number: string;                // Card number in set
  artist?: string;               // Card artist
  rarity?: string;               // Card rarity
  flavorText?: string;           // Pokedex entry
  nationalPokedexNumbers?: number[]; // Pokedex numbers
  legalities?: Legalities;       // Tournament legality
  images: CardImages;            // Card images
  tcgplayer?: TCGPlayer;         // TCGPlayer pricing
  cardmarket?: CardMarket;       // European pricing
}

interface CardImages {
  small: string;  // Small resolution image URL
  large: string;  // High resolution image URL
}
```

### 2. Core Service Methods

```typescript
class PokemonTCGService {
  // Search cards with advanced query
  async searchCards(query: SearchQuery): Promise<PokemonCard[]>
  
  // Get specific card by ID
  async getCardById(id: string): Promise<PokemonCard>
  
  // Download and cache card image
  async getCardImage(card: PokemonCard): Promise<Buffer>
  
  // Get all cards in a set
  async getSetCards(setId: string): Promise<PokemonCard[]>
  
  // Validate OCR result against official data
  async validateOCRResult(ocrData: OCRResult, card: PokemonCard): Promise<ValidationResult>
  
  // Find best matching card for OCR result
  async findBestMatch(ocrData: OCRResult): Promise<MatchResult>
}
```

### 3. Image Validation Service

**File**: `src/services/ImageValidationService.ts`

```typescript
class ImageValidationService {
  // Compare two images using multiple algorithms
  async compareImages(image1: Buffer, image2: Buffer): Promise<SimilarityScore>
  
  // Extract visual features for comparison
  async extractFeatures(image: Buffer): Promise<ImageFeatures>
  
  // Validate card orientation and quality
  async validateImageQuality(image: Buffer): Promise<QualityScore>
  
  // Detect card edition markers (1st edition, shadowless, etc.)
  async detectSpecialMarkers(image: Buffer): Promise<SpecialMarkers>
}
```

### 4. Combined Card Matcher

**File**: `src/utils/cardMatcher.ts`

```typescript
class CardMatcher {
  // Main entry point for card identification
  async identifyCard(ocrResult: OCRResult): Promise<EnrichedCardData>
  
  // Combine data from multiple sources
  async enrichCardData(
    ocrResult: OCRResult,
    tcgCard: PokemonCard,
    priceData: PriceChartingProduct
  ): Promise<EnrichedCardData>
  
  // Calculate overall confidence score
  calculateConfidence(
    ocrConfidence: number,
    imageSimularity: number,
    dataMatchScore: number
  ): number
  
  // Determine if manual review needed
  needsManualReview(enrichedData: EnrichedCardData): boolean
}
```

## API Integration Examples

### Search Query Examples

```javascript
// Search by name and set
{
  q: 'name:charizard set.name:"base set"'
}

// Search by card number
{
  q: 'number:4 set.id:base1'
}

// Search for specific variants
{
  q: 'name:pikachu rarity:"rare holo"'
}

// Complex query with multiple conditions
{
  q: '(name:blastoise OR name:venusaur) hp:[100 TO *] set.series:base'
}
```

### Response Processing

```javascript
async function processCardMatch(ocrResult, tcgResponse) {
  const card = tcgResponse.data[0];
  
  // Extract key identifiers
  const cardIdentity = {
    id: card.id,
    name: card.name,
    set: card.set.name,
    number: `${card.number}/${card.set.total}`,
    rarity: card.rarity
  };
  
  // Get pricing from both sources
  const pricing = {
    tcgplayer: {
      market: card.tcgplayer?.prices?.holofoil?.market || 
              card.tcgplayer?.prices?.normal?.market,
      low: card.tcgplayer?.prices?.holofoil?.low || 
           card.tcgplayer?.prices?.normal?.low,
      mid: card.tcgplayer?.prices?.holofoil?.mid || 
           card.tcgplayer?.prices?.normal?.mid
    },
    pricecharting: await priceChartingService.findBestMatch(
      card.name, 
      card.set.name, 
      card.number
    )
  };
  
  // Download official image for validation
  const officialImage = await downloadImage(card.images.large);
  
  // Compare with OCR captured image
  const similarity = await imageValidationService.compareImages(
    ocrResult.image,
    officialImage
  );
  
  return {
    identity: cardIdentity,
    pricing: pricing,
    validation: {
      similarity: similarity,
      confidence: calculateOverallConfidence(ocrResult, similarity, card)
    },
    officialImage: card.images.large
  };
}
```

## Database Schema Updates

### New Fields for Cards Table

```sql
-- Pokemon TCG API fields
ALTER TABLE cards ADD COLUMN pokemontcg_id VARCHAR(100);
ALTER TABLE cards ADD COLUMN pokemontcg_set_id VARCHAR(50);
ALTER TABLE cards ADD COLUMN official_image_url TEXT;
ALTER TABLE cards ADD COLUMN official_image_path TEXT;
ALTER TABLE cards ADD COLUMN image_similarity_score DECIMAL(5,2);

-- TCGPlayer pricing fields
ALTER TABLE cards ADD COLUMN tcgplayer_id VARCHAR(100);
ALTER TABLE cards ADD COLUMN tcgplayer_url TEXT;
ALTER TABLE cards ADD COLUMN tcgplayer_market_price INTEGER;
ALTER TABLE cards ADD COLUMN tcgplayer_low_price INTEGER;
ALTER TABLE cards ADD COLUMN tcgplayer_mid_price INTEGER;
ALTER TABLE cards ADD COLUMN tcgplayer_high_price INTEGER;
ALTER TABLE cards ADD COLUMN tcgplayer_direct_low INTEGER;
ALTER TABLE cards ADD COLUMN tcgplayer_updated_at TIMESTAMP;

-- Enhanced metadata
ALTER TABLE cards ADD COLUMN superttype VARCHAR(50);
ALTER TABLE cards ADD COLUMN subtypes JSONB;
ALTER TABLE cards ADD COLUMN evolves_from VARCHAR(100);
ALTER TABLE cards ADD COLUMN evolves_to JSONB;
ALTER TABLE cards ADD COLUMN rules TEXT[];
ALTER TABLE cards ADD COLUMN ancient_trait JSONB;
ALTER TABLE cards ADD COLUMN national_pokedex_numbers INTEGER[];
ALTER TABLE cards ADD COLUMN legalities JSONB;

-- Validation tracking
ALTER TABLE cards ADD COLUMN visual_validation_status VARCHAR(50);
ALTER TABLE cards ADD COLUMN visual_validation_date TIMESTAMP;
ALTER TABLE cards ADD COLUMN data_sources JSONB; -- Track which APIs provided data

-- Indexes
CREATE INDEX idx_pokemontcg_id ON cards(pokemontcg_id);
CREATE INDEX idx_tcgplayer_id ON cards(tcgplayer_id);
CREATE INDEX idx_image_similarity ON cards(image_similarity_score);
CREATE INDEX idx_visual_validation ON cards(visual_validation_status);
```

## Caching Strategy

### Image Caching
```javascript
const IMAGE_CACHE_DIR = './cache/card_images/';
const IMAGE_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

async function getCachedImage(cardId: string): Promise<Buffer | null> {
  const cachePath = path.join(IMAGE_CACHE_DIR, `${cardId}.jpg`);
  
  if (await fs.exists(cachePath)) {
    const stats = await fs.stat(cachePath);
    const age = Date.now() - stats.mtime.getTime();
    
    if (age < IMAGE_CACHE_TTL) {
      return await fs.readFile(cachePath);
    }
  }
  
  return null;
}
```

### API Response Caching
- Card data: 24-hour TTL
- Set information: 7-day TTL
- Rarities/types: 30-day TTL
- Search results: 1-hour TTL

## Error Handling

### Fallback Strategy
```javascript
async function identifyCardWithFallback(ocrResult) {
  try {
    // Primary: Pokemon TCG API
    const tcgMatch = await pokemonTCGService.findBestMatch(ocrResult);
    
    if (tcgMatch.confidence > 0.85) {
      return enrichWithAllSources(ocrResult, tcgMatch);
    }
  } catch (error) {
    logger.warn('Pokemon TCG API failed', { error });
  }
  
  try {
    // Fallback: PriceCharting only
    const pcMatch = await priceChartingService.findBestMatch(
      ocrResult.card_name,
      ocrResult.set_name,
      ocrResult.card_number
    );
    
    return enrichWithPriceCharting(ocrResult, pcMatch);
  } catch (error) {
    logger.error('All API sources failed', { error });
    
    // Last resort: OCR data only
    return {
      ...ocrResult,
      needs_review: true,
      review_reason: 'API services unavailable'
    };
  }
}
```

## Performance Optimizations

### Parallel API Calls
```javascript
async function fetchCardDataParallel(ocrResult) {
  const [tcgData, pcData, imageData] = await Promise.all([
    pokemonTCGService.searchCards({ q: buildQuery(ocrResult) }),
    priceChartingService.searchProducts(buildPCQuery(ocrResult)),
    ocrResult.image ? processImage(ocrResult.image) : null
  ]);
  
  return combineResults(tcgData, pcData, imageData);
}
```

### Batch Processing
```javascript
async function processBatch(ocrResults: OCRResult[]) {
  // Group by potential set for efficient API usage
  const grouped = groupBySet(ocrResults);
  
  for (const [setId, cards] of grouped) {
    // Fetch all cards in set once
    const setCards = await pokemonTCGService.getSetCards(setId);
    
    // Match each OCR result against cached set data
    for (const ocrResult of cards) {
      const match = findInSet(ocrResult, setCards);
      await processMatch(ocrResult, match);
    }
  }
}
```

## Testing Strategy

### Unit Tests
1. API authentication and connection
2. Search query building
3. Response parsing and normalization
4. Image download and caching
5. Similarity scoring algorithms

### Integration Tests
1. End-to-end card identification
2. Fallback scenarios
3. Cache performance
4. Concurrent request handling
5. Rate limit compliance

### Performance Benchmarks
- Single card identification: <4 seconds
- Batch of 10 cards: <20 seconds
- Image comparison: <500ms
- Cache hit rate: >80%

## Monitoring and Metrics

### Key Metrics to Track
1. **API Performance**
   - Response times per endpoint
   - Error rates and types
   - Rate limit usage

2. **Matching Accuracy**
   - Pokemon TCG match rate
   - PriceCharting match rate
   - Combined confidence scores
   - Manual review rate

3. **Image Validation**
   - Similarity score distribution
   - False positive/negative rates
   - Processing times

4. **System Health**
   - Cache hit rates
   - Memory usage (image caching)
   - API quota consumption

## Security Considerations

### API Key Management
- Store API key in environment variables
- Never commit keys to version control
- Rotate keys periodically
- Monitor for unauthorized usage

### Data Privacy
- Cache personal data separately from card data
- Implement data retention policies
- Secure image storage
- Audit data access

## Future Enhancements

### Phase 1 (Current)
- Basic Pokemon TCG API integration
- Image validation system
- Dual-source pricing

### Phase 2
- Machine learning for image comparison
- Automated set detection
- Condition grading assistance

### Phase 3
- Multi-language card support
- Other TCG support (Yu-Gi-Oh, Magic)
- Mobile app integration
- Real-time market alerts

## Appendix

### A. Pokemon TCG API Endpoints
- `/cards` - Search and retrieve cards
- `/cards/{id}` - Get specific card
- `/sets` - List all sets
- `/sets/{id}` - Get specific set
- `/types` - List all types
- `/subtypes` - List all subtypes
- `/supertypes` - List all supertypes
- `/rarities` - List all rarities

### B. Query Syntax Examples
```
name:charizard                     # Card name contains "charizard"
set.name:"base set"                 # Exact set name match
hp:[100 TO *]                      # HP greater than or equal to 100
types:fire AND types:flying        # Multiple types
rarity:"rare holo"                 # Specific rarity
attacks.damage:>100                # Attack damage greater than 100
nationalPokedexNumbers:6           # Pokedex number
-subtypes:mega                     # Exclude mega Pokemon
(name:pikachu OR name:raichu)      # Either name
set.series:base                    # Set series
artist:"Ken Sugimori"              # Specific artist
```

### C. Rate Limits
- Without API key: 1000 requests/day
- With API key: Higher limits (contact developer)
- Recommended: Implement exponential backoff
- Cache aggressively to minimize API calls

---

*Document Version: 1.0*
*Last Updated: 2025-08-14*
*Author: CardMint Development Team*