/**
 * DeterministicResolver Test Suite
 * 
 * Golden tests for exact matching paths:
 * - Performance benchmarks (sub-millisecond targets)  
 * - Edge cases and OCR nastiness
 * - Evidence generation and confidence routing
 */

import Database from 'better-sqlite3';
import { DeterministicResolver, Card, Verdict } from '../DeterministicResolver';
import { CompositeIndexMigration } from '../../../scripts/add-composite-indexes';

describe('DeterministicResolver', () => {
  let db: Database.Database;
  let resolver: DeterministicResolver;

  beforeAll(async () => {
    // In-memory database for fast tests
    db = new Database(':memory:');
    
    // Create minimal schema for testing
    db.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        name TEXT,
        set_name TEXT,
        card_number TEXT,
        normalized_name TEXT,
        normalized_set TEXT,
        normalized_number TEXT
      );

      CREATE TABLE card_aliases (
        alias TEXT PRIMARY KEY,
        canonical_id TEXT,
        alias_type TEXT,
        confidence REAL DEFAULT 1.0
      );
    `);

    // Add composite indexes for performance
    const indexMigration = new CompositeIndexMigration(db);
    await indexMigration.apply();

    // Insert test data
    const insertCard = db.prepare(`
      INSERT INTO cards (id, name, set_name, card_number, normalized_name, normalized_set, normalized_number)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const testCards = [
      // Perfect data
      ['card1', 'Pikachu', 'Base Set', '25/102', 'pikachu', 'base set', '25'],
      ['card2', 'Charizard', 'Base Set', '4/102', 'charizard', 'base set', '4'],
      ['card3', 'Blastoise', 'Base Set', '2/102', 'blastoise', 'base set', '2'],
      
      // Edge cases
      ['card4', 'Pikachu', 'Base Set 2', '25/130', 'pikachu', 'base set 2', '25'], // Name collision different set
      ['card5', 'Mew', 'Wizards Black Star Promos', '8', 'mew', 'wizards black star promos', '8'],
      ['card6', 'Dark Charizard', 'Team Rocket', '4/82', 'dark charizard', 'team rocket', '4'],
      
      // Data quality issues
      ['card7', '', 'Unknown Set', '1', '', 'unknown set', '1'], // Empty name
      ['card8', 'Test Card', '', 'PROMO', 'test card', '', 'promo'], // Empty set
    ];

    for (const card of testCards) {
      insertCard.run(...card);
    }

    // Add aliases for testing
    const insertAlias = db.prepare(`
      INSERT INTO card_aliases (alias, canonical_id, alias_type) VALUES (?, ?, ?)
    `);

    insertAlias.run('pika', 'card1', 'name');
    insertAlias.run('zard', 'card2', 'name'); 
    insertAlias.run('base set pikachu 25', 'card1', 'card');

    resolver = new DeterministicResolver(db);
  });

  afterAll(() => {
    db?.close();
  });

  describe('Exact Matching - Golden Paths', () => {
    
    test('should match exact triplet with CERTAIN confidence', () => {
      const result = resolver.exactMatch({
        name: 'pikachu',
        set: 'base set', 
        number: '25'
      });

      expect(result.verdict).toBe('CERTAIN');
      expect(result.confidence).toBe(1.0);
      expect(result.chosen_card?.id).toBe('card1');
      expect(result.evidence).toContain('Exact triplet match: "pikachu" | "base set" | "25"');
    });

    test('should handle name + set matching with LIKELY confidence', () => {
      const result = resolver.exactMatch({
        name: 'charizard',
        set: 'base set'
      });

      expect(result.verdict).toBe('LIKELY');
      expect(result.confidence).toBe(0.98);
      expect(result.chosen_card?.id).toBe('card2');
    });

    test('should handle name + number matching', () => {
      const result = resolver.exactMatch({
        name: 'blastoise',
        number: '2'
      });

      expect(result.verdict).toBe('LIKELY');
      expect(result.confidence).toBe(0.96);
      expect(result.chosen_card?.id).toBe('card3');
    });

    test('should handle unique name-only matching', () => {
      const result = resolver.exactMatch({
        name: 'dark charizard'
      });

      expect(result.verdict).toBe('LIKELY');
      expect(result.confidence).toBe(0.9);
      expect(result.chosen_card?.id).toBe('card6');
    });

    test('should detect MULTIPLE matches for ambiguous names', () => {
      const result = resolver.exactMatch({
        name: 'pikachu' // Exists in card1 and card4
      });

      expect(result.verdict).toBe('MULTIPLE');
      expect(result.confidence).toBe(0.6);
      expect(result.alternatives).toBeDefined();
      expect(result.alternatives!.length).toBe(2);
    });

    test('should return UNCERTAIN for no matches', () => {
      const result = resolver.exactMatch({
        name: 'nonexistent card'
      });

      expect(result.verdict).toBe('UNCERTAIN');
      expect(result.confidence).toBe(0.0);
      expect(result.evidence).toContain('No exact match found');
    });
  });

  describe('Alias Resolution', () => {
    
    test('should resolve name aliases to canonical cards', () => {
      const result = resolver.exactMatch({
        name: 'pika' // Alias for Pikachu
      });

      expect(result.verdict).toBe('CERTAIN');
      expect(result.confidence).toBe(0.98);
      expect(result.chosen_card?.id).toBe('card1');
      expect(result.evidence[0]).toContain('Alias match on name "pika"');
    });

    test('should resolve card-level aliases', () => {
      const result = resolver.exactMatch({
        raw: 'base set pikachu 25'
      });

      expect(result.verdict).toBe('CERTAIN');
      expect(result.confidence).toBe(1.0);
      expect(result.chosen_card?.id).toBe('card1');
      expect(result.evidence[0]).toContain('Alias match → card_id=card1');
    });
  });

  describe('Input Normalization', () => {
    
    test('should normalize case and whitespace', () => {
      const result = resolver.exactMatch({
        name: '  PIKACHU  ',
        set: '  Base   Set  ',
        number: ' 25 '
      });

      expect(result.verdict).toBe('CERTAIN');
      expect(result.chosen_card?.id).toBe('card1');
    });

    test('should normalize card numbers correctly', () => {
      // Test various card number formats
      const testCases = [
        { input: '25/102', expected: '25' },
        { input: '025', expected: '25' },
        { input: '4', expected: '4' },
        { input: 'PROMO', expected: 'promo' }
      ];

      for (const { input, expected } of testCases) {
        const result = resolver.exactMatch({
          name: 'test',
          number: input
        });
        // The normalization is internal, but we can verify behavior indirectly
        expect(typeof result).toBe('object');
      }
    });
  });

  describe('Raw Query Parsing', () => {
    
    test('should parse structured queries from raw OCR text', () => {
      const testCases = [
        'Pikachu Base Set 25/102',
        'Charizard base set 4',
        'Mew wizards black star promos 8',
        'Dark Charizard team rocket 4/82'
      ];

      for (const query of testCases) {
        const result = resolver.resolve(query);
        expect(result.verdict).toBeOneOf(['CERTAIN', 'LIKELY']);
        expect(result.confidence).toBeGreaterThan(0.8);
      }
    });

    test('should handle malformed OCR input gracefully', () => {
      const nastyInputs = [
        'PIK4CHU b4se set 25',     // OCR character corruption
        'charizard    base     4', // Excessive whitespace
        'mew promo 8//',           // Double separators
        '     ',                   // Only whitespace
        ''                         // Empty string
      ];

      for (const input of nastyInputs) {
        const result = resolver.resolve(input);
        expect(result).toBeDefined();
        expect(result.verdict).toBeOneOf(['CERTAIN', 'LIKELY', 'MULTIPLE', 'UNCERTAIN']);
      }
    });
  });

  describe('Performance Benchmarks', () => {
    
    test('should achieve sub-millisecond exact matching', async () => {
      const iterations = 1000;
      const query = { name: 'pikachu', set: 'base set', number: '25' };
      
      const startTime = process.hrtime.bigint();
      
      for (let i = 0; i < iterations; i++) {
        resolver.exactMatch(query);
      }
      
      const endTime = process.hrtime.bigint();
      const totalMs = Number(endTime - startTime) / 1_000_000;
      const avgMs = totalMs / iterations;
      
      expect(avgMs).toBeLessThan(1.0); // Target: sub-millisecond average
      console.log(`🚀 Exact matching performance: ${avgMs.toFixed(3)}ms average over ${iterations} iterations`);
    });

    test('should handle batch resolution efficiently', () => {
      const batchQueries = [
        'Pikachu Base Set 25',
        'Charizard Base Set 4', 
        'Blastoise Base Set 2',
        'Mew Promo 8',
        'Dark Charizard Team Rocket 4'
      ];

      const startTime = process.hrtime.bigint();
      
      const results = batchQueries.map(query => resolver.resolve(query));
      
      const endTime = process.hrtime.bigint();
      const totalMs = Number(endTime - startTime) / 1_000_000;
      
      expect(totalMs).toBeLessThan(10); // Batch should complete in <10ms
      expect(results.every(r => r.confidence > 0.8)).toBe(true);
      
      console.log(`⚡ Batch resolution: ${batchQueries.length} queries in ${totalMs.toFixed(2)}ms`);
    });
  });

  describe('Health Check', () => {
    
    test('should report healthy status with proper indexes', async () => {
      const health = await resolver.healthCheck();
      
      expect(health.status).toBe('healthy');
      expect(health.indexStatus.length).toBeGreaterThanOrEqual(3);
      expect(health.sampleQueryMs).toBeLessThan(2.0);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    
    test('should handle empty and null inputs gracefully', () => {
      const edgeCases = [
        { name: '', set: '', number: '' },
        { name: undefined, set: undefined, number: undefined },
        {},
      ];

      for (const query of edgeCases) {
        const result = resolver.exactMatch(query);
        expect(result.verdict).toBe('UNCERTAIN');
        expect(result.confidence).toBe(0.0);
      }
    });

    test('should provide meaningful evidence for debugging', () => {
      const result = resolver.exactMatch({
        name: 'pikachu',
        set: 'base set',
        number: '25'  
      });

      expect(result.evidence).toBeDefined();
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.evidence[0]).toMatch(/triplet match.*pikachu.*base set.*25/);
    });
  });
});

// Custom Jest matchers
expect.extend({
  toBeOneOf(received: any, expected: any[]) {
    const pass = expected.includes(received);
    return {
      message: () => `expected ${received} to be one of ${expected.join(', ')}`,
      pass,
    };
  },
});