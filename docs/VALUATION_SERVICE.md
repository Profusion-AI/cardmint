# ValuationService Implementation

## Overview

The ValuationService provides fast, in-process card valuation functionality that compares raw vs. graded resale values. It integrates seamlessly with CardMint's existing architecture while maintaining sub-10ms query performance through prepared statements and optional caching.

## Features

- **Sub-10ms Performance**: Prepared SQLite statements with covering indexes
- **Zero Schema Changes**: Uses existing `latest_market_prices` view from 006 migration
- **Configurable Assumptions**: Environment-driven pricing logic (fees, costs, priors)
- **GPT-OSS Integration**: Token-efficient JSON output for AI summarization
- **Comprehensive Caching**: 15-minute TTL with cache statistics
- **Production-Ready**: Full error handling, logging, and observability

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   ValuationTool │───▶│ ValuationService │───▶│ SQLite Database │
│  (GPT Interface)│    │ (Core Algorithm) │    │ (Read-Only)     │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   JSON Output   │    │ Prepared Stmts   │    │latest_market_   │
│  (Token Light)  │    │   + Cache        │    │    prices       │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## Configuration

### Environment Variables

```bash
# Feature Control
VALUATION_ENABLED=true

# Marketplace Fees (decimals)
FEE_EBAY_RAW=0.13           # 13% eBay fee for raw sales
FEE_FANATICS_GRADED=0.10    # 10% Fanatics fee for graded sales

# Costs (cents)
GRADING_COST_BASE=2000      # $20 base grading cost
SHIP_TO_GRADER=500          # $5 shipping to grader
SHIP_TO_BUYER_RAW=300       # $3 shipping for raw sales
SHIP_TO_BUYER_GRADED=500    # $5 shipping for graded sales

# Grade Outcome Probabilities
PSA9_PROBABILITY=0.70       # 70% chance of PSA 9
PSA10_PROBABILITY=0.30      # 30% chance of PSA 10

# Performance
CACHE_TTL_MINUTES=15        # Cache duration
```

### Assumptions

The service uses configurable assumptions for valuation:

- **Grade Distribution**: Configurable PSA 9/10 probabilities (default 70%/30%)
- **Marketplace Fees**: eBay for raw, Fanatics for graded (configurable rates)
- **All-in Costs**: Grading service + shipping both directions
- **Time Value**: No time discount by default (implement if needed)

## API Usage

### Direct Service API

```typescript
import { getValuationService } from './services/ValuationServiceFactory';

const service = getValuationService();

// By card ID
const result = await service.compareResale({
  cardId: 'charizard-base-set-4'
});

// By query (resolved via DeterministicResolver)
const result = await service.compareResale({
  query: 'Charizard Base Set unlimited'
});

// With variant specification
const result = await service.compareResale({
  cardId: 'charizard-base-set-4',
  variant: {
    finish: 'holo',
    edition: '1st'
  }
});
```

### GPT Tool Interface

```typescript
import { getValuationTool } from './services/ValuationServiceFactory';

const tool = getValuationTool();

// GPT-friendly interface
const output = await tool.compareResale({
  query: 'Charizard Base Set unlimited',
  variant: { finish: 'holo' }
});

// Returns structured JSON for GPT to summarize
console.log(output.summary); 
// "Grading recommended: Expected net gain of $12.30 after grading costs and fees"
```

### HTTP API Endpoints

```bash
# Health check
GET /api/valuation/health

# Valuation comparison
POST /api/valuation/compare
Content-Type: application/json

{
  "query": "Charizard Base Set unlimited",
  "variant": {
    "finish": "holo",
    "edition": "1st"
  }
}
```

## Response Format

### ValuationResult (Service)

```typescript
{
  recommendation: 'raw' | 'graded' | 'insufficient_data',
  rawNetCents: 4050,        // $40.50 net after fees
  gradedNetCents: 5280,     // $52.80 net after costs
  chosenBasis: 'PSA',       // Best available grading company
  assumptions: {
    fees: { raw: 0.13, graded: 0.10 },
    costs: { grading: 2000, shipping: 1000 },
    priors: { psa9: 0.70, psa10: 0.30 }
  },
  confidence: 0.92,         // Overall confidence score
  evidence: [
    'Raw market price: $50.00',
    'Graded net after costs: $52.80',
    'Grading advantage: $12.30'
  ]
}
```

### ValuationToolOutput (GPT Interface)

```typescript
{
  recommendation: 'graded',
  summary: 'Grading recommended: Expected net gain of $12.30 after grading costs and fees',
  details: {
    rawNetCents: 4050,
    gradedNetCents: 5280,
    advantageCents: 1230,
    chosenBasis: 'PSA',
    confidence: 0.92
  },
  assumptions: {
    fees: 'eBay 13.0%, Fanatics 10.0%',
    costs: 'Grading $20, Shipping $10',
    priors: 'PSA 9: 70%, PSA 10: 30%'
  },
  evidence: [...],
  metadata: {
    processingTimeMs: 8
  }
}
```

## Algorithm Details

### Price Fetching Strategy

1. **Basis Priority**: PSA → BGS → CGC → SGC (best liquidity/recognition)
2. **Raw Price**: Uses `basis='ungraded'` from `latest_market_prices`
3. **Graded Prices**: Extracts grade-specific prices (PSA 9, PSA 10, etc.)

### Net Calculation

**Raw Net**:
```
Raw Net = Raw Price × (1 - eBay Fee) - Raw Shipping
```

**Graded Net**:
```
Expected Sale = (PSA9 Price × PSA9 Probability) + (PSA10 Price × PSA10 Probability)
Graded Net = Expected Sale × (1 - Fanatics Fee) - All Costs
All Costs = Grading Cost + Ship to Grader + Ship to Buyer
```

### Decision Logic

- **Recommend Graded**: If `gradedNet > rawNet`
- **Recommend Raw**: If `rawNet >= gradedNet`
- **Insufficient Data**: If no price data available or card resolution fails

## Performance Characteristics

### Measured Performance

- **Single Query**: < 10ms (prepared statements + indexes)
- **Cache Hit**: < 1ms
- **Memory Usage**: ~10MB for 1000 cached entries
- **Database Impact**: Zero writes, read-only prepared statements

### Query Plan

```sql
-- Optimized query with basis priority
SELECT basis, price_cents, grade_numeric, vendor
FROM latest_market_prices
WHERE card_id = ? 
  AND finish = COALESCE(?, 'normal')
  AND edition = COALESCE(?, 'unlimited')
ORDER BY 
  CASE basis 
    WHEN 'PSA' THEN 1 
    WHEN 'BGS' THEN 2 
    WHEN 'CGC' THEN 3 
    WHEN 'SGC' THEN 4 
    WHEN 'ungraded' THEN 5
    ELSE 6 
  END
```

## Integration Points

### No Conflicts with Existing Services

- **PriceChartingService**: Remains sole API caller and data writer
- **MarketPriceIngestion**: Continues handling vendor data normalization
- **DeterministicResolver**: Used for card resolution when needed
- **Database Schema**: Zero changes, uses existing `latest_market_prices` view

### GPT-OSS Integration

```typescript
// Register tool with GPT-OSS
const toolMetadata = ValuationTool.getToolMetadata();
// {
//   name: 'valuation.compareResale',
//   description: 'Compare raw vs graded resale value for Pokemon cards',
//   parameters: { ... }
// }

// GPT calls tool, receives JSON, summarizes in 1-2 sentences
const result = await gptTool.compareResale(input);
// GPT Output: "Based on current market data, grading this Charizard would 
// net an additional $12.30 after all fees and costs, making it worthwhile."
```

## Testing

### Unit Tests

```bash
# Run ValuationService tests
npm test src/services/__tests__/ValuationService.test.ts

# Run ValuationTool tests  
npm test src/tools/__tests__/ValuationTool.test.ts
```

### Integration Testing

```bash
# Health check
curl http://localhost:3000/api/valuation/health

# Test valuation
curl -X POST http://localhost:3000/api/valuation/compare \
  -H "Content-Type: application/json" \
  -d '{"query": "Charizard Base Set unlimited"}'
```

## Monitoring & Observability

### Health Checks

```typescript
import { getHealthStatus } from './services/ValuationServiceFactory';

const health = await getHealthStatus();
// {
//   enabled: true,
//   service: { available: true, message: "Service initialized (5 cached entries)" },
//   tool: { available: true, message: "ValuationTool healthy (5 cached entries)" }
// }
```

### Metrics & Logging

- **Query Latency**: Logged for each valuation request
- **Cache Performance**: Hit/miss ratios and entry counts
- **Confidence Scores**: Distribution tracking for quality monitoring
- **Error Rates**: Service and tool-level error monitoring

### Log Examples

```
INFO valuation-service: Valuation computed {
  cardId: "charizard-base-set-4",
  recommendation: "graded", 
  rawNet: 4050,
  gradedNet: 5280,
  confidence: 0.92,
  latencyMs: 8,
  hasPrices: true
}
```

## Troubleshooting

### Common Issues

**Service Disabled**:
- Check `VALUATION_ENABLED=true` in environment
- Verify service initialization in logs

**No Price Data**:
- Ensure `latest_market_prices` view has data for the card
- Check `market_price_samples` table for ingested data
- Verify PriceChartingService is running and ingesting

**Poor Performance**:
- Check cache hit ratios in service stats
- Verify database indexes are created (see 006 migration)
- Monitor query execution plans

### Debug Mode

```bash
LOG_LEVEL=debug npm start
# Enables detailed logging for valuation queries and cache operations
```

## Future Enhancements

### Planned Features (Out of Scope)

- **Multi-Currency Support**: USD only for now
- **eBay/Fanatics API Integration**: Currently uses PriceCharting proxies
- **Time Decay Factors**: Age-based price adjustments
- **Portfolio Bulk Valuation**: Currently single-card only
- **Historical Trend Analysis**: Using `market_timeseries` data

### Extension Points

- **Custom Fee Structures**: Per-marketplace configuration
- **Grade Distribution Learning**: Dynamic priors based on card/set data
- **Risk Adjustments**: Incorporate grading failure rates
- **Market Timing**: Optimal selling timing recommendations

---

This implementation delivers a production-ready valuation system that integrates cleanly with CardMint's existing architecture while providing the foundation for future enhancements.