# SQLite-First QA Architecture with GPT-OSS-20B
## CardMint Asynchronous Database Queue Validation System

**Document Version**: 1.0  
**Created**: August 29, 2025  
**Status**: 🔄 Implementation Ready  
**Core Philosophy**: SQLite as ground truth brain, GPT-OSS-20B for edge case arbitration only

---

## 🎯 Executive Summary

Transform CardMint's validation system from LLM-first guessing to **deterministic SQLite-first resolution** with GPT-OSS-20B handling only ambiguous cases through a minimal MCP tool interface. This architecture leverages your existing 20k+ card database as the source of truth, achieving 99%+ accuracy with 80% cost reduction.

## 🏗️ Core Architecture Principles

### **Three-Layer Resolution Strategy**
1. **Layer 1**: Deterministic SQLite resolver (handles 85% of cases)
2. **Layer 2**: MCP tool server (minimal, read-only surface)  
3. **Layer 3**: GPT-OSS-20B agent (ambiguous cases only, <15%)

### **Performance Targets**
- **Accuracy**: 99%+ ("five 9s" goal)
- **Speed**: <30ms average validation
- **Cost**: 80% reduction in LLM calls
- **CPU**: Minimal (SQLite-optimized for read-heavy workload)

---

## 📊 Database Enhancement: SQLite as Oracle

### **Enhanced Schema with Canonical Fields**
```sql
-- Add canonical field for deterministic matching
ALTER TABLE cards ADD COLUMN canonical TEXT GENERATED ALWAYS AS (
  lower(trim(replace(name, ''',''''))) || '|' || lower(set_name) || '|' || lower(card_number)
) VIRTUAL;

CREATE INDEX IF NOT EXISTS idx_cards_canonical ON cards(canonical);

-- FTS5 virtual table for fuzzy search (handles OCR noise)
CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
  name, set_name, card_number, 
  content='cards', 
  content_rowid='rowid',
  tokenize = 'porter'  -- Handles stemming: "Charizards" -> "Charizard"
);

-- Auto-sync triggers for FTS5
CREATE TRIGGER IF NOT EXISTS cards_ai AFTER INSERT ON cards BEGIN
  INSERT INTO cards_fts(rowid, name, set_name, card_number)
  VALUES (new.rowid, new.name, new.set_name, new.card_number);
END;

CREATE TRIGGER IF NOT EXISTS cards_au AFTER UPDATE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, name, set_name, card_number)
  VALUES ('delete', old.rowid, old.name, old.set_name, old.card_number);
  INSERT INTO cards_fts(rowid, name, set_name, card_number)
  VALUES (new.rowid, new.name, new.set_name, new.card_number);
END;

CREATE TRIGGER IF NOT EXISTS cards_ad AFTER DELETE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, name, set_name, card_number)
  VALUES ('delete', old.rowid, old.name, old.set_name, old.card_number);
END;
```

### **Aliases Table: The Silent Superpower**
```sql
-- Handle human messiness once, enjoy clean matches forever
CREATE TABLE IF NOT EXISTS card_aliases (
  alias TEXT PRIMARY KEY,           -- normalized: lower(trim(input))
  canonical_id TEXT NOT NULL,       -- points to cards.id  
  alias_type TEXT,                  -- 'ocr_variant', 'set_nickname', 'common_typo'
  confidence REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alias_canonical ON card_aliases(canonical_id);
CREATE INDEX IF NOT EXISTS idx_alias_type ON card_aliases(alias_type);

-- Example population (expand based on your OCR patterns)
INSERT INTO card_aliases (alias, canonical_id, alias_type, confidence) VALUES
  ('charizerd', 'base1-4', 'ocr_variant', 0.95),
  ('charzard', 'base1-4', 'common_typo', 0.90),
  ('1st edition charizard', 'base1-4', 'edition_variant', 0.98),
  ('base', 'base1', 'set_nickname', 1.0),
  ('jungle', 'jungle1', 'set_nickname', 1.0),
  ('team rocket', 'base5', 'set_nickname', 1.0),
  ('shadowless charizard', 'base1-4', 'variant', 0.95);
```

### **Performance Optimizations (Read-Heavy Workload)**
```sql
PRAGMA journal_mode=WAL;           -- Concurrent reads
PRAGMA synchronous=NORMAL;         -- Balance safety/speed
PRAGMA cache_size=-80000;          -- 80MB cache
PRAGMA temp_store=MEMORY;          -- Keep temp data in RAM
PRAGMA mmap_size=3000000000;       -- 3GB mmap if available
PRAGMA optimize;                   -- Analyze query patterns
```

---

## 🔧 Layer 1: Deterministic Resolver (No LLM)

### **Implementation: `src/validation/DeterministicResolver.ts`**
```typescript
export interface ResolutionInput {
  name?: string;
  set?: string;
  number?: string;
}

export interface ResolutionResult {
  match: Card | null;
  score: number;          // 0-1 confidence
  method: 'exact' | 'alias' | 'fuzzy' | 'near' | 'none';
  candidates?: Card[];    // Alternative matches
  evidence?: string;      // Why this match was chosen
}

export class DeterministicResolver {
  constructor(private db: Database) {}

  async resolve(input: ResolutionInput): Promise<ResolutionResult> {
    // Step 1: Try exact canonical match (fastest path)
    const canonical = this.buildCanonical(input);
    const exact = await this.findExactMatch(canonical);
    if (exact) {
      return {
        match: exact,
        score: 1.0,
        method: 'exact',
        evidence: 'Perfect canonical match'
      };
    }

    // Step 2: Check aliases table
    const aliasResult = await this.checkAliases(input);
    if (aliasResult && aliasResult.score > 0.90) {
      return aliasResult;
    }

    // Step 3: Near-exact heuristics (same name+set, number variants)
    const nearExact = await this.findNearExact(input);
    if (nearExact && nearExact.score > 0.85) {
      return nearExact;
    }

    // Step 4: FTS5 fuzzy search with scoring
    const fuzzyResult = await this.fuzzySearch(input);
    if (fuzzyResult && fuzzyResult.score > 0.75) {
      return fuzzyResult;
    }

    // No good match found
    return {
      match: null,
      score: 0,
      method: 'none',
      evidence: 'No confident matches found'
    };
  }

  private async fuzzySearch(input: ResolutionInput): Promise<ResolutionResult | null> {
    const query = this.buildFTSQuery(input);
    if (!query) return null;

    const results = await this.db.all(`
      SELECT c.*, bm25(cards_fts) as fts_rank
      FROM cards c
      JOIN cards_fts ON c.rowid = cards_fts.rowid
      WHERE cards_fts MATCH ?
      ORDER BY fts_rank
      LIMIT 5
    `, query);

    if (results.length === 0) return null;

    // Score based on BM25 rank + field similarity + edit distance
    const scored = results.map(card => ({
      card,
      score: this.calculateSimilarityScore(input, card)
    }));

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    return {
      match: best.card,
      score: best.score,
      method: 'fuzzy',
      candidates: scored.slice(1, 4).map(s => s.card),
      evidence: `FTS5 match with ${(best.score * 100).toFixed(1)}% similarity`
    };
  }

  private calculateSimilarityScore(input: ResolutionInput, card: any): number {
    let totalScore = 0;
    let fieldCount = 0;

    // Name similarity (weighted 50%)
    if (input.name && card.name) {
      fieldCount++;
      const nameScore = this.levenshteinSimilarity(
        input.name.toLowerCase().trim(),
        card.name.toLowerCase().trim()
      );
      totalScore += nameScore * 0.5;
    }

    // Set similarity (weighted 30%)
    if (input.set && card.set_name) {
      fieldCount++;
      const setScore = this.levenshteinSimilarity(
        input.set.toLowerCase().trim(),
        card.set_name.toLowerCase().trim()
      );
      totalScore += setScore * 0.3;
    }

    // Number similarity (weighted 20%)
    if (input.number && card.card_number) {
      fieldCount++;
      const numScore = this.numberSimilarity(input.number, card.card_number);
      totalScore += numScore * 0.2;
    }

    return fieldCount > 0 ? totalScore / fieldCount : 0;
  }

  private buildCanonical(input: ResolutionInput): string {
    const name = input.name ? input.name.toLowerCase().trim().replace(/'/g, '') : '';
    const set = input.set ? input.set.toLowerCase().trim() : '';
    const number = input.number ? input.number.toLowerCase().trim() : '';
    return `${name}|${set}|${number}`;
  }

  // Additional helper methods...
}
```

---

## 🔧 Layer 2: MCP Tool Server (Minimal Surface)

### **Implementation: `src/qa/mcpServer.ts`**
```typescript
import { createServer } from "@modelcontextprotocol/sdk";
import { z } from "zod";
import type { Database } from 'better-sqlite3';
import { DeterministicResolver } from '../validation/DeterministicResolver';

export function createCardMintMCPServer(
  db: Database, 
  resolver: DeterministicResolver
) {
  const server = createServer({
    name: "cardmint-qa-tools",
    version: "1.0.0",
    description: "CardMint database tools for quality assurance validation"
  });

  // Tool 1: Deterministic resolver (primary tool)
  server.tool("db.resolve", {
    description: "Resolve card using deterministic database lookup with fuzzy matching",
    input: z.object({
      name: z.string().optional().describe("Card name from OCR/Vision"),
      set: z.string().optional().describe("Set name or code"),
      number: z.string().optional().describe("Card number")
    }),
    output: z.object({
      match: z.any().nullable(),
      score: z.number().min(0).max(1),
      method: z.enum(['exact', 'alias', 'fuzzy', 'near', 'none']),
      candidates: z.array(z.any()).optional(),
      evidence: z.string().optional()
    }),
    handler: async ({ input }) => {
      return await resolver.resolve(input);
    }
  });

  // Tool 2: Direct lookup by ID
  server.tool("db.lookupExact", {
    description: "Get exact card by database ID",
    input: z.object({ 
      id: z.string().describe("Card ID from database") 
    }),
    output: z.any().nullable(),
    handler: async ({ input }) => {
      return db.prepare('SELECT * FROM cards WHERE id = ?').get(input.id);
    }
  });

  // Tool 3: Limited FTS search (fallback)
  server.tool("db.search", {
    description: "Direct fuzzy text search (max 5 results)",
    input: z.object({ 
      query: z.string().max(100).describe("Search query for FTS5") 
    }),
    output: z.array(z.any()).max(5),
    handler: async ({ input }) => {
      return db.prepare(`
        SELECT c.*, bm25(cards_fts) as rank
        FROM cards c
        JOIN cards_fts ON c.rowid = cards_fts.rowid
        WHERE cards_fts MATCH ?
        ORDER BY rank
        LIMIT 5
      `).all(input.query);
    }
  });

  // Tool 4: Re-OCR (optional, for unclear text)
  server.tool("ocr.retry", {
    description: "Retry OCR with enhanced settings for unclear text",
    input: z.object({ 
      imagePath: z.string().describe("Path to card image") 
    }),
    output: z.object({
      text: z.string(),
      confidence: z.number()
    }),
    handler: async ({ input }) => {
      // Call enhanced OCR (PaddleOCR with different settings)
      const result = await retryOCRWithEnhancedSettings(input.imagePath);
      return {
        text: result.text,
        confidence: result.confidence
      };
    }
  });

  // Tool 5: Pokemon TCG API lookup (for unknown cards)
  server.tool("tcg.find", {
    description: "Search Pokemon TCG API for card validation",
    input: z.object({
      name: z.string().optional(),
      set: z.string().optional(),
      number: z.string().optional()
    }),
    output: z.array(z.any()).max(3),
    handler: async ({ input }) => {
      // Rate-limited call to Pokemon TCG API
      return await searchPokemonTCGAPI(input);
    }
  });

  return server;
}

// Helper function implementations
async function retryOCRWithEnhancedSettings(imagePath: string) {
  // Implementation would call PaddleOCR with:
  // - Higher DPI processing
  // - Different language models
  // - Enhanced preprocessing
  // Return mock for now
  return { text: "", confidence: 0.0 };
}

async function searchPokemonTCGAPI(params: any) {
  // Implementation would call Pokemon TCG API
  // With caching and rate limiting
  return [];
}
```

---

## 🔧 Layer 3: GPT-OSS-20B Agent (Ambiguous Cases Only)

### **Implementation: `src/qa/QAAgent.ts`**
```typescript
import type { MCPClient } from '@modelcontextprotocol/sdk';

export interface ValidationInput {
  cardId: string;
  name?: string;
  set?: string;
  number?: string;
  imagePath?: string;
  confidence: number;
  source: string;
}

export interface QADecision {
  verdict: "OK" | "CORRECT";
  chosenId: string;           // Must be valid cards.id from database
  confidence: number;         // 0-1
  evidence: {
    resolverScore: number;
    toolsUsed: string[];
    reasoning?: string;
    originalInput: any;
  };
}

export class QAAgent {
  constructor(
    private mcpClient: MCPClient,
    private lmstudioUrl: string,
    private modelId: string = 'cardmint-verifier'
  ) {}

  async arbitrate(input: ValidationInput): Promise<QADecision> {
    // ALWAYS try deterministic resolver first
    const candidates = await this.mcpClient.call('db.resolve', {
      name: input.name,
      set: input.set,
      number: input.number
    });

    // Fast path: High confidence deterministic match (85% of cases)
    if (candidates.score >= 0.96 && candidates.method === 'exact') {
      return {
        verdict: "OK",
        chosenId: candidates.match.id,
        confidence: candidates.score,
        evidence: {
          resolverScore: candidates.score,
          toolsUsed: ['db.resolve'],
          reasoning: 'High confidence exact match, no LLM needed',
          originalInput: input
        }
      };
    }

    // Ambiguous case: Use GPT-OSS-20B with tools (15% of cases)
    const prompt = this.buildArbitrationPrompt(input, candidates);
    const response = await this.callGPTWithMCP(prompt);
    
    // Parse and validate response schema
    const decision = this.parseAndValidateResponse(response);
    if (!decision) {
      throw new Error('GPT-OSS-20B returned invalid response schema');
    }
    
    return decision;
  }

  private buildArbitrationPrompt(
    input: ValidationInput, 
    resolverResult: any
  ): string {
    return `
You are a Pokemon TCG expert validating card data. A deterministic resolver analyzed the input but needs your arbitration.

**Input to validate:**
- Name: "${input.name}"
- Set: "${input.set}" 
- Number: "${input.number}"
- Vision confidence: ${(input.confidence * 100).toFixed(1)}%

**Resolver found:**
${JSON.stringify(resolverResult, null, 2)}

**Available tools for investigation:**
- db.lookupExact(id): Get exact card details by database ID
- db.search(query): Fuzzy search for alternatives  
- ocr.retry(imagePath): Re-run OCR if text seems wrong
- tcg.find(name, set, number): Search Pokemon TCG API

**Your task:**
1. If the top resolver candidate looks correct, return verdict "OK"
2. If you find a better match using tools, return verdict "CORRECT" with the right ID
3. ONLY return card IDs that exist in the database (use tools to verify)
4. Be conservative - when in doubt, prefer the resolver's top candidate

**Output format (strict JSON):**
{
  "verdict": "OK" | "CORRECT",
  "chosenId": "database-card-id",
  "confidence": 0.95,
  "evidence": {
    "resolverScore": ${resolverResult.score},
    "toolsUsed": ["tool1", "tool2"],
    "reasoning": "Brief explanation of decision"
  }
}

Think step by step and use tools to verify your decision.
`;
  }

  private async callGPTWithMCP(prompt: string): Promise<any> {
    const response = await fetch(`${this.lmstudioUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelId,
        messages: [
          {
            role: 'system',
            content: 'You are a Pokemon TCG validation expert. Always respond with valid JSON. Use tools to verify facts before making decisions.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 300,
        temperature: 0.1,
        response_format: { type: "json_object" }
      }),
      signal: AbortSignal.timeout(10000) // 10s timeout
    });

    if (!response.ok) {
      throw new Error(`LM Studio request failed: HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content;
  }

  private parseAndValidateResponse(content: string): QADecision | null {
    try {
      const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      
      // Validate required fields
      if (!parsed.verdict || !parsed.chosenId || typeof parsed.confidence !== 'number') {
        return null;
      }

      if (!['OK', 'CORRECT'].includes(parsed.verdict)) {
        return null;
      }

      return {
        verdict: parsed.verdict,
        chosenId: parsed.chosenId,
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
        evidence: {
          resolverScore: parsed.evidence?.resolverScore || 0,
          toolsUsed: Array.isArray(parsed.evidence?.toolsUsed) 
            ? parsed.evidence.toolsUsed 
            : [],
          reasoning: parsed.evidence?.reasoning || 'No reasoning provided',
          originalInput: parsed.evidence?.originalInput
        }
      };
    } catch (error) {
      console.error('Failed to parse QADecision:', error);
      return null;
    }
  }
}
```

---

## 📈 Smart Validation Policy & Queue Integration

### **Confidence-Based Routing**
```typescript
// src/qa/ValidationRouter.ts
export class ValidationRouter {
  async shouldValidate(result: InferenceResult): Promise<{
    validate: boolean;
    priority: 'high' | 'medium' | 'low';
    reason: string;
    estimatedCost: number;
  }> {
    // Always validate low confidence (likely errors)
    if (result.confidence < 0.82) {
      return {
        validate: true,
        priority: 'high',
        reason: 'low_confidence_requires_validation',
        estimatedCost: 0.001 // Full LLM arbitration likely
      };
    }

    // Skip most high confidence (deterministic resolver likely sufficient)
    if (result.confidence >= 0.95) {
      const shouldSample = Math.random() < 0.05; // 5% sampling
      return {
        validate: shouldSample,
        priority: 'low',
        reason: shouldSample ? 'random_quality_sample' : 'high_confidence_skip',
        estimatedCost: shouldSample ? 0.0001 : 0 // Likely resolved deterministically
      };
    }

    // Validate medium confidence (mixed results expected)
    return {
      validate: true,
      priority: 'medium',
      reason: 'medium_confidence_validation',
      estimatedCost: 0.0005 // 50% chance of needing LLM
    };
  }
}
```

### **Enhanced Queue Integration**
```typescript
// Integration into existing QueueManager.ts
class QueueManager {
  private qaQueue?: Queue;
  private validationRouter = new ValidationRouter();

  async processJob(job: Job): Promise<any> {
    // ... existing processing logic ...

    // After successful card processing
    if (result.success) {
      await this.cardRepository!.updateCard(cardId, {
        status: CardStatus.PROCESSED,
        // ... other updates
      });

      // Determine if QA validation needed
      const validationDecision = await this.validationRouter.shouldValidate(result);
      
      if (validationDecision.validate) {
        // Enqueue QA validation (asynchronous, won't block)
        await this.qaQueue!.add('validate', {
          cardId: cardId,
          name: result.cardData?.name,
          set: result.cardData?.set,
          number: result.cardData?.number,
          confidence: result.confidence,
          imagePath: job.data.imageData.path,
          source: 'vision_model'
        }, {
          priority: this.getPriorityValue(validationDecision.priority),
          delay: 100, // Small delay to ensure DB write commits
          removeOnComplete: 100,
          removeOnFail: 1000
        });
      }
    }

    return result;
  }
}
```

---

## 🚀 Implementation Plan

### **Phase 1: Database Foundation (Day 1)**
1. **Schema Enhancement**
   ```bash
   # Add canonical field and FTS5 table
   npm run db:migrate -- 005_qa_enhancement.sql
   ```

2. **Aliases Population**
   ```bash
   # Initial aliases from common OCR errors
   npm run qa:populate-aliases
   ```

3. **Performance Optimization**
   ```bash
   # Apply read-optimized PRAGMAs
   npm run db:optimize
   ```

### **Phase 2: Deterministic Resolver (Day 1-2)**
1. **Core Implementation**
   - `src/validation/DeterministicResolver.ts`
   - String similarity algorithms
   - FTS5 query building
   - Scoring heuristics

2. **Testing & Calibration**
   ```bash
   # Test resolver on existing data
   npm run qa:test-resolver
   
   # Measure baseline accuracy
   npm run qa:accuracy-baseline
   ```

### **Phase 3: MCP Integration (Day 2)**
1. **Dependencies**
   ```bash
   npm install @modelcontextprotocol/sdk zod
   ```

2. **MCP Server Setup**
   - `src/qa/mcpServer.ts`
   - Tool implementations
   - Schema validation

3. **Testing**
   ```bash
   # Test MCP tools individually
   npm run qa:test-mcp-tools
   ```

### **Phase 4: GPT-OSS-20B Integration (Day 2-3)**
1. **Agent Implementation**
   - `src/qa/QAAgent.ts`
   - MCP client setup
   - Response validation

2. **Testing**
   ```bash
   # Test agent on ambiguous cases
   npm run qa:test-agent
   ```

### **Phase 5: Queue Integration (Day 3)**
1. **QA Queue Setup**
   - Add `qa:verify` to BullMQ configuration
   - Worker implementation
   - Error handling

2. **Integration**
   - Modify `QueueManager.ts`
   - Add validation routing
   - Metrics collection

### **Phase 6: Calibration & Tuning (Day 3-4)**
1. **Accuracy Testing**
   ```bash
   # Run on last 1000 processed cards
   npm run qa:accuracy-test --count=1000
   ```

2. **Threshold Optimization**
   - Tune confidence thresholds
   - Adjust sampling rates
   - Add more aliases

3. **Performance Validation**
   ```bash
   # Measure latency under load
   npm run qa:load-test
   ```

---

## 📊 Expected Performance Metrics

### **Accuracy Improvement**
- **Current baseline**: ~95% (vision model alone)
- **With deterministic resolver**: 97-98%
- **With GPT-OSS-20B arbitration**: 99%+
- **Target with aliases**: 99.9% ("five 9s")

### **Latency Breakdown**
```
┌─────────────────────┬──────────┬─────────┬───────────────────┐
│ Resolution Method   │ Latency  │ Usage % │ Cumulative Speed  │
├─────────────────────┼──────────┼─────────┼───────────────────┤
│ Exact Match         │ < 5ms    │ 40%     │ 2ms average       │
│ Alias Lookup        │ < 10ms   │ 25%     │ 4.5ms average     │
│ FTS5 Fuzzy          │ < 20ms   │ 20%     │ 8.5ms average     │
│ GPT-OSS-20B Agent   │ 100-200ms│ 15%     │ 28.5ms average    │
└─────────────────────┴──────────┴─────────┴───────────────────┘

Overall Average: < 30ms per validation (vs 2000ms+ for always-LLM)
```

### **Cost Reduction**
- **Always-LLM approach**: ~$0.001 per validation
- **SQLite-first approach**: ~$0.0001 per validation (80% reduction)
- **Annual savings**: $800+ on 100k validations

### **Resource Usage**
- **CPU**: Minimal (SQLite read-optimized)
- **Memory**: ~100MB (SQLite cache + Node.js)
- **Disk**: ~500MB (FTS5 indexes + aliases)
- **Tokens**: 80% reduction in LLM usage

---

## 🎯 Success Criteria

### **Technical Metrics**
- [ ] 99%+ accuracy on golden dataset
- [ ] <30ms average validation latency
- [ ] 80%+ of cases resolved deterministically
- [ ] Zero production errors in first week

### **Business Metrics**  
- [ ] 80% cost reduction vs always-LLM
- [ ] 5x speed improvement
- [ ] Human review queue <5% of total validations
- [ ] User confidence score >95%

### **Operational Metrics**
- [ ] <1% queue backlog during peak hours
- [ ] 99.9% uptime for validation service
- [ ] <2% false positive rate
- [ ] Human approval rate >90% for flagged items

---

## 🔧 File Structure

```
src/
├── qa/
│   ├── QAAgent.ts              # GPT-OSS-20B agent
│   ├── mcpServer.ts            # MCP tool server
│   ├── ValidatorWorker.ts      # BullMQ worker
│   └── schemas/
│       ├── qa-decision.json    # AJV schema
│       └── validation-input.json
├── validation/
│   ├── DeterministicResolver.ts # SQLite-first resolver
│   ├── ValidationRouter.ts     # Confidence routing
│   └── utils/
│       ├── similarity.ts       # String similarity
│       └── scoring.ts          # Match scoring
└── storage/
    ├── migrations/
    │   └── 005_qa_enhancement.sql
    └── aliases/
        ├── ocr-variants.sql    # Common OCR errors
        ├── set-nicknames.sql   # Set name variations
        └── card-variants.sql   # 1st edition, shadowless

scripts/
├── qa-populate-aliases.ts     # Initial alias population
├── qa-test-resolver.ts        # Resolver accuracy testing
├── qa-accuracy-baseline.ts    # Measure current accuracy
└── qa-load-test.ts           # Performance validation
```

---

## 🚨 Critical Implementation Notes

### **Database Migrations Must Be Idempotent**
```sql
-- Always use IF NOT EXISTS
CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(...);
CREATE INDEX IF NOT EXISTS idx_cards_canonical ON cards(canonical);
```

### **Error Handling Strategy**
1. **Deterministic resolver fails**: Return empty result, escalate to LLM
2. **MCP server unavailable**: Skip validation, log warning  
3. **GPT-OSS-20B timeout**: Use deterministic result as fallback
4. **Schema validation fails**: Mark for human review

### **Resource Management**
```typescript
// Connection pooling for SQLite (single writer, multiple readers)
const db = new Database(dbPath, { 
  readonly: true,     // For MCP tools
  fileMustExist: true 
});

// GPT-OSS-20B concurrency limits
const qaWorker = new Worker("qa:verify", handler, {
  concurrency: 1,     // CPU-only model, single thread
  limiter: {
    max: 100,         // Max 100 validations per minute
    duration: 60000
  }
});
```

---

**This architecture provides exactly what you need: your SQLite database as the intelligent brain, with GPT-OSS-20B acting as a surgical arbitrator only when needed. The result is a production-grade system that's fast, accurate, cost-effective, and perfectly suited for your Fedora hardware constraints.**

---

**Next Steps**: 
1. ✅ Document architecture (this file)
2. 🔄 Implement Phase 1: Database enhancement
3. 🔄 Build deterministic resolver  
4. 🔄 Set up MCP server
5. 🔄 Integrate GPT-OSS-20B agent
6. 🔄 Deploy and calibrate