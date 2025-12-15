/**
 * Unit tests for PPT Title Builder
 *
 * Tests the buildParseTitleFromExtraction function to ensure:
 * 1. Canonical data is preferred over extraction data
 * 2. Collector number denominators are preserved
 * 3. Holo hints are correctly applied based on extraction
 * 4. Fallbacks work when canonical data is missing
 *
 * Run with: npx tsx apps/backend/src/services/pptTitleBuilder.test.ts
 */

import { buildParseTitleFromExtraction, TitleBuilderContext } from "./pptTitleBuilder";

// ANSI color codes for test output
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

interface TestCase {
  name: string;
  extracted: any;
  context: TitleBuilderContext;
  expected: string;
  description: string;
}

const testCases: TestCase[] = [
  // ==================================================================================
  // Test Group 1: Canonical Data Precedence (PRODUCTION BLOCKER CASES)
  // ==================================================================================
  {
    name: "Pikachu Base #25 - Canonical overrides wrong extraction",
    extracted: {
      card_name: "Pikachu",
      set_number: "005/025", // Wrong: Celebrations reprint
      set_name: "Celebrations", // Wrong: should be Base Set
      holo_type: "holo", // Wrong: Base Pikachu is non-holo
    },
    context: {
      fallbackName: "Pikachu",
      canonicalSetName: "Base Set", // Correct
      canonicalCollectorNo: "25", // Correct
      canonicalRarity: "Common", // Correct
    },
    expected: "Pikachu 25 Base Set",
    description: "Should use canonical '25' and 'Base Set', ignore extraction '005/025' and 'Celebrations'",
  },
  {
    name: "Vulpix Aquapolis #116 - Canonical adds missing denominator",
    extracted: {
      card_name: "Vulpix",
      set_number: "116", // Missing denominator
      set_name: "Pokemon Aquapolis",
    },
    context: {
      fallbackName: "Vulpix",
      canonicalSetName: "Pokemon Aquapolis",
      canonicalCollectorNo: "116/147", // Canonical has full collector number
      canonicalRarity: null,
    },
    expected: "Vulpix 116/147 Pokemon Aquapolis",
    description: "Should use canonical '116/147', not extraction '116'",
  },
  {
    name: "Pikachu EVO #35 - Canonical corrects wrong denominator",
    extracted: {
      card_name: "Pikachu",
      set_number: "35/181", // Wrong denominator (181 instead of 108)
      set_name: "Pokemon Evolutions",
      holo_type: "reverse_holo",
    },
    context: {
      fallbackName: "Pikachu",
      canonicalSetName: "Pokemon Evolutions",
      canonicalCollectorNo: "35/108", // Correct denominator
      canonicalRarity: null,
    },
    expected: "Pikachu 35/108 Pokemon Evolutions Reverse Holo",
    description: "Should use canonical '35/108', not extraction '35/181'",
  },

  // ==================================================================================
  // Test Group 2: Fallback Behavior (When Canonical is Missing)
  // ==================================================================================
  {
    name: "Fallback to extraction when canonical is null",
    extracted: {
      card_name: "Charizard",
      set_number: "4/102",
      set_name: "Base Set",
      holo_type: "holo",
    },
    context: {
      fallbackName: "Charizard",
      canonicalSetName: null, // No canonical data
      canonicalCollectorNo: null,
      canonicalRarity: null,
    },
    expected: "Charizard 4/102 Base Set Holo",
    description: "Should use extraction when canonical is not available",
  },
  {
    name: "Fallback to context.fallbackName when extraction is null",
    extracted: null,
    context: {
      fallbackName: "Mew",
      canonicalSetName: "Wizards Black Star Promos",
      canonicalCollectorNo: "8",
      canonicalRarity: "Promo",
    },
    expected: "Mew 8 Wizards Black Star Promos",
    description: "Should use fallbackName when extraction is completely missing",
  },

  // ==================================================================================
  // Test Group 3: Collector Number Formatting
  // ==================================================================================
  {
    name: "Preserve full collector number with denominator",
    extracted: null,
    context: {
      fallbackName: "Alakazam",
      canonicalSetName: "Base Set",
      canonicalCollectorNo: "1/102",
      canonicalRarity: "Holo Rare",
    },
    expected: "Alakazam 1/102 Base Set Holo",
    description: "Should preserve full '1/102' format, and add Holo from rarity",
  },
  {
    name: "Remove leading zeros from collector number",
    extracted: {
      set_number: "001/102", // Leading zeros should be stripped
    },
    context: {
      fallbackName: "Alakazam",
      canonicalSetName: "Base Set",
      canonicalCollectorNo: "1/102",
      canonicalRarity: null,
    },
    expected: "Alakazam 1/102 Base Set",
    description: "Should normalize '001/102' to '1/102'",
  },
  {
    name: "Handle collector number without denominator",
    extracted: null,
    context: {
      fallbackName: "Energy",
      canonicalSetName: "Basic Energy",
      canonicalCollectorNo: "E", // Some promos use letters
      canonicalRarity: null,
    },
    expected: "Energy E Basic Energy",
    description: "Should handle non-numeric collector numbers",
  },

  // ==================================================================================
  // Test Group 4: Variant Hints (Holo, Reverse Holo, First Edition, Shadowless)
  // ==================================================================================
  {
    name: "Add Holo hint from extraction holo_type",
    extracted: {
      card_name: "Charizard",
      holo_type: "holo",
    },
    context: {
      fallbackName: "Charizard",
      canonicalSetName: "Base Set",
      canonicalCollectorNo: "4/102",
      canonicalRarity: "Rare", // Not "Holo Rare"
    },
    expected: "Charizard 4/102 Base Set Holo",
    description: "Should add 'Holo' from extraction holo_type, not from rarity",
  },
  {
    name: "Add Reverse Holo hint from extraction",
    extracted: {
      card_name: "Pikachu",
      holo_type: "reverse_holo",
    },
    context: {
      fallbackName: "Pikachu",
      canonicalSetName: "Evolutions",
      canonicalCollectorNo: "35/108",
      canonicalRarity: null,
    },
    expected: "Pikachu 35/108 Evolutions Reverse Holo",
    description: "Should add 'Reverse Holo' from extraction",
  },
  {
    name: "Add First Edition hint from extraction",
    extracted: {
      card_name: "Machamp",
      first_edition_stamp: true,
    },
    context: {
      fallbackName: "Machamp",
      canonicalSetName: "Base Set",
      canonicalCollectorNo: "8/102",
      canonicalRarity: "Rare",
    },
    expected: "Machamp 8/102 Base Set First Edition",
    description: "Should add 'First Edition' when first_edition_stamp is true",
  },
  {
    name: "Add Shadowless hint from extraction",
    extracted: {
      card_name: "Charizard",
      shadowless: true,
    },
    context: {
      fallbackName: "Charizard",
      canonicalSetName: "Base Set",
      canonicalCollectorNo: "4/102",
      canonicalRarity: "Holo Rare",
    },
    expected: "Charizard 4/102 Base Set Holo Shadowless",
    description: "Should add 'Shadowless' when shadowless is true, plus 'Holo' from rarity",
  },
  {
    name: "Combine multiple variant hints",
    extracted: {
      card_name: "Machamp",
      holo_type: "holo",
      first_edition_stamp: true,
      shadowless: false, // false should not add hint
    },
    context: {
      fallbackName: "Machamp",
      canonicalSetName: "Base Set",
      canonicalCollectorNo: "8/102",
      canonicalRarity: null,
    },
    expected: "Machamp 8/102 Base Set Holo First Edition",
    description: "Should combine Holo and First Edition hints, ignore false shadowless",
  },
  {
    name: "Fallback to rarity for holo hint when extraction has no holo_type",
    extracted: {
      card_name: "Charizard",
      // No holo_type provided
    },
    context: {
      fallbackName: "Charizard",
      canonicalSetName: "Base Set",
      canonicalCollectorNo: "4/102",
      canonicalRarity: "Holo Rare", // Should trigger Holo hint
    },
    expected: "Charizard 4/102 Base Set Holo",
    description: "Should infer 'Holo' from canonicalRarity when extraction doesn't have holo_type",
  },
  {
    name: "Do NOT add Holo hint when rarity is Common",
    extracted: {
      card_name: "Energy Retrieval",
      // No holo_type
    },
    context: {
      fallbackName: "Energy Retrieval",
      canonicalSetName: "Base Set",
      canonicalCollectorNo: "81/102",
      canonicalRarity: "Common", // Should NOT add Holo
    },
    expected: "Energy Retrieval 81/102 Base Set",
    description: "Should NOT add 'Holo' when rarity is 'Common'",
  },

  // ==================================================================================
  // Test Group 5: Edge Cases
  // ==================================================================================
  {
    name: "Handle missing everything (minimal fallback)",
    extracted: null,
    context: {
      fallbackName: "Unknown Card",
      canonicalSetName: null,
      canonicalCollectorNo: null,
      canonicalRarity: null,
    },
    expected: "Unknown Card",
    description: "Should return just the card name when no other data is available",
  },
  {
    name: "Normalize whitespace in card name",
    extracted: {
      card_name: "Charizard  ex", // Multiple spaces
    },
    context: {
      fallbackName: "Charizard ex",
      canonicalSetName: "FireRed & LeafGreen",
      canonicalCollectorNo: "105/112",
      canonicalRarity: "Ultra Rare",
    },
    expected: "Charizard ex 105/112 FireRed & LeafGreen",
    description: "Should normalize multiple spaces in card name",
  },
  {
    name: "Handle holo_type unknown (should not add hint)",
    extracted: {
      card_name: "Pikachu",
      holo_type: "unknown",
    },
    context: {
      fallbackName: "Pikachu",
      canonicalSetName: "Base Set",
      canonicalCollectorNo: "58/102",
      canonicalRarity: "Common",
    },
    expected: "Pikachu 58/102 Base Set",
    description: "Should NOT add variant hint when holo_type is 'unknown'",
  },
];

// ==================================================================================
// Test Runner
// ==================================================================================

function runTests() {
  console.log("\n" + "=".repeat(80));
  console.log("PPT Title Builder Unit Tests");
  console.log("=".repeat(80) + "\n");

  let passed = 0;
  let failed = 0;

  for (const testCase of testCases) {
    const result = buildParseTitleFromExtraction(testCase.extracted, testCase.context);
    const success = result === testCase.expected;

    if (success) {
      passed++;
      console.log(`${GREEN}✓ PASS${RESET} ${testCase.name}`);
    } else {
      failed++;
      console.log(`${RED}✗ FAIL${RESET} ${testCase.name}`);
      console.log(`  ${YELLOW}Description:${RESET} ${testCase.description}`);
      console.log(`  ${YELLOW}Expected:${RESET} "${testCase.expected}"`);
      console.log(`  ${RED}Actual:${RESET}   "${result}"`);
      console.log();
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log(`${GREEN}Passed: ${passed}${RESET} | ${RED}Failed: ${failed}${RESET} | Total: ${testCases.length}`);
  console.log("=".repeat(80) + "\n");

  if (failed > 0) {
    console.log(`${RED}TESTS FAILED${RESET}\n`);
    process.exit(1);
  } else {
    console.log(`${GREEN}ALL TESTS PASSED${RESET}\n`);
    process.exit(0);
  }
}

// Run tests immediately
runTests();
