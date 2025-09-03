/**
 * Pokemon Canon Zod Schema
 * 
 * Validates config/naming/pokemon.json and provides literal-union types.
 * Integrates with existing canon system for enhanced type safety.
 */

/* eslint-disable no-useless-escape */
import { z } from "zod";

/** -----------------------------------------
 *  Literal-union "source of truth" enums
 *  (Update intentionally when canon changes)
 *  ----------------------------------------*/
export const LANGUAGE_CODES = ["EN", "JP"] as const;
export type LanguageCode = typeof LANGUAGE_CODES[number];

export const LAYOUT_VARIANTS = ["standard", "full_art", "landscape"] as const;
export type LayoutVariant = typeof LAYOUT_VARIANTS[number];

export const ROI_TIERS = ["CRITICAL", "STANDARD", "DETAILED", "OPTIONAL"] as const;
export type RoiTier = typeof ROI_TIERS[number];

export const ROI_ROLES = [
  "text",
  "symbol",
  "pattern",
  "rulebox",
  "edge_logo",
  "art_border",
  "set_symbol",
  "number_box",
  "name_band",
  "evolution_box",
] as const;
export type RoiRole = typeof ROI_ROLES[number];

export const LAYOUT_FAMILY_IDS = [
  "classic_wotc",
  "e_card",
  "ex_dp",
  "hgss",
  "bw_xy",
  "sun_moon",
  "sword_shield",
  "scarlet_violet",
  "legend_split",
  "vmax_vstar_landscape",
  "trainer_ownership",
] as const;
export type LayoutFamilyId = typeof LAYOUT_FAMILY_IDS[number];

export const ERA_IDS = [
  "classic_wotc",
  "e_card",
  "ex",
  "diamond_pearl",
  "hgss",
  "bw",
  "xy",
  "sun_moon",
  "sword_shield",
  "scarlet_violet",
] as const;
export type EraId = typeof ERA_IDS[number];

export const ACRONYM_CANONICAL = [
  "EX_2012",
  "ex_2003",
  "ex_2023",
  "VMAX",
  "VSTAR",
  "GX",
  "TAG_TEAM",
  "BREAK",
  "LEVEL_X",
  "PRIME",
  "LEGEND",
  "ACE_SPEC",
  "RADIANT",
  "DELTA_SPECIES",
  "TRAINER_OWNERSHIP",
] as const;
export type AcronymCanonical = typeof ACRONYM_CANONICAL[number];

export const RARITY_MARKER_IDS = [
  "DELTA_SPECIES",
  "LEVEL_X",
  "PRIME",
  "LEGEND",
  "ACE_SPEC",
  "RADIANT",
] as const;
export type RarityMarkerId = typeof RARITY_MARKER_IDS[number];

export const RULEBOX_IDS = [
  "ex_2003",
  "EX_2012",
  "ex_2023",
  "GX",
  "V/VSTAR/VMAX",
] as const;
export type RuleBoxId = typeof RULEBOX_IDS[number];

export const NUMBER_FORMAT_IDS = [
  "simple_fraction",
  "secret_fraction",
  "trainer_gallery",
  "japanese_sr",
] as const;
export type NumberFormatId = typeof NUMBER_FORMAT_IDS[number];

export const NAME_PATTERN_IDS = ["trainer_ownership", "radiant_prefix", "delta_marker"] as const;
export type NamePatternId = typeof NAME_PATTERN_IDS[number];

/** -----------------------------------------
 *  Reusable primitives
 *  ----------------------------------------*/
export const IsoDateLikeSchema = z.string().min(1);

export const RoiIdSchema = z
  .string()
  .regex(/^[a-z0-9_]+:[a-z0-9_-]+$/, "ROI id must be 'familyId:roi-name'");

export const RegexStringSchema = z
  .string()
  .refine((s) => {
    try {
      // eslint-disable-next-line no-new
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  }, "Invalid regex string");

/** -----------------------------------------
 *  Sub-schemas
 *  ----------------------------------------*/
export const ConventionsSchema = z.object({
  jsonKeyCase: z.literal("lowerCamelCase"),
  enumCase: z.literal("SCREAMING_SNAKE_CASE"),
  idFormat: z.literal("kebab-case"),
  roiIdFormat: z.literal("familyId:roiName"),
  languageCodes: z.array(z.enum(LANGUAGE_CODES)).nonempty(),
  layoutVariants: z.array(z.enum(LAYOUT_VARIANTS)).nonempty(),
  roiTiers: z.array(z.enum(ROI_TIERS)).nonempty(),
  roiRoles: z.array(z.enum(ROI_ROLES)).nonempty(),
});

export const AcronymEntrySchema = z.object({
  display: z.string(),
  canonical: z.enum(ACRONYM_CANONICAL),
  description: z.string(),
  ruleBox: z.boolean(),
  synonyms: z.array(z.string()).default([]),
});
export const AcronymCanonSchema = z.record(z.string(), AcronymEntrySchema);

export const EraSchema = z.object({
  id: z.enum(ERA_IDS),
  code: z.string(),
  displayName: z.string(),
  years: z.string(),
  familyDefault: z.enum(LAYOUT_FAMILY_IDS),
  synonyms: z.array(z.string()).default([]),
  commonMarkers: z.array(z.string()).default([]),
});

export const LayoutFamilySchema = z.object({
  id: z.enum(LAYOUT_FAMILY_IDS),
  displayName: z.string(),
  eraHints: z.array(z.enum(ERA_IDS)).nonempty(),
  defaultCoreRois: z.array(RoiIdSchema).default([]),
  conditionalRois: z.array(RoiIdSchema).default([]),
  typicalVariants: z.array(z.enum(LAYOUT_VARIANTS)).nonempty(),
});

export const RarityMarkerSchema = z.object({
  id: z.enum(RARITY_MARKER_IDS),
  displayName: z.string(),
  synonyms: z.array(z.string()).default([]),
  detectionCues: z.array(z.string()).nonempty(),
  impacts: z.object({
    layoutVariants: z.array(z.enum(LAYOUT_VARIANTS)).default([]),
    families: z.array(z.enum(LAYOUT_FAMILY_IDS)).default([]),
  }),
});

export const RuleBoxCanonEntrySchema = z.object({
  id: z.enum(RULEBOX_IDS),
  display: z.string(),
  ruleBox: z.boolean(),
  appliesToEras: z.array(z.enum(ERA_IDS)).nonempty(),
});

export const NumberFormatSchema = z.object({
  id: z.enum(NUMBER_FORMAT_IDS),
  pattern: RegexStringSchema,
  normalize: z.string().optional(),
  isSecretRule: z.string().optional(), // expression hint; evaluated in app layer
  examples: z.array(z.string()).default([]),
});

export const NamePatternSchema = z.object({
  id: z.enum(NAME_PATTERN_IDS),
  pattern: RegexStringSchema,
  normalize: z.string(),
  notes: z.string().optional(),
});

export const PriceChartingMapSchema = z.object({
  ungradedPriceField: z.string(),
  psa9PriceField: z.string(),
  psa10PriceField: z.string(),
  bgs10PriceField: z.string().optional(),
  volumeField: z.string().optional(),
  idFields: z.array(z.enum(["card_name", "set_name", "card_number", "language"])).nonempty(),
  normalizationRules: z.record(z.string(), z.array(z.string()).optional()).optional(),
});

export const OcrExtractSchemaDeclSchema = z.object({
  required: z.array(z.enum(["set_name", "card_number", "card_name", "language"])).nonempty(),
  optional: z.array(z.enum(["rarity_hint", "rulebox_present", "layout_variant"])).optional(),
  fieldRegex: z.object({
    language: RegexStringSchema.optional(),
    card_number: RegexStringSchema.optional(),
  }).optional(),
});

export const SynonymsSchema = z.object({
  set: z.record(z.string(), z.string()).default({}),
  rarity: z.record(z.string(), z.string()).default({}),
  language: z.record(z.string(), z.string()).default({}),
});

export const RoiIdNamingSchema = z.object({
  examples: z.array(RoiIdSchema).nonempty(),
  rules: z.array(z.string()).nonempty(),
});

export const FamilyDefaultsEntrySchema = z.object({
  critical: z.array(RoiIdSchema).default([]),
  standard: z.array(RoiIdSchema).default([]),
  detailed: z.array(RoiIdSchema).default([]),
  optional: z.array(RoiIdSchema).default([]),
});
export const FamilyDefaultsSchema = z.record(z.enum(LAYOUT_FAMILY_IDS), FamilyDefaultsEntrySchema);

export const AcceptancePoliciesSchema = z.object({
  newTemplate: z.object({
    requires: z.array(z.string()).nonempty(),
    maxRois: z.number().int().positive(),
  }),
  newROI: z.object({
    requires: z.array(z.string()).nonempty(),
    autoDowngrade: z.string(),
  }),
});

export const ExamplesSchema = z.object({
  ocrExtract: z.record(z.string(), z.any()).optional(),
  normalized: z.record(z.string(), z.any()).optional(),
});

/** -----------------------------------------
 *  Top-level schema
 *  ----------------------------------------*/
export const PokemonCanonSchema = z.object({
  version: IsoDateLikeSchema,
  namespace: z.literal("cardmint.pkm"),
  conventions: ConventionsSchema,
  acronymCanon: AcronymCanonSchema,
  eras: z.array(EraSchema).nonempty(),
  layoutFamilies: z.array(LayoutFamilySchema).nonempty(),
  rarityMarkers: z.array(RarityMarkerSchema).nonempty(),
  ruleBoxCanon: z.array(RuleBoxCanonEntrySchema).nonempty(),
  numberFormats: z.array(NumberFormatSchema).nonempty(),
  namePatterns: z.array(NamePatternSchema).nonempty(),
  priceChartingMap: PriceChartingMapSchema,
  ocrExtractSchema: OcrExtractSchemaDeclSchema,
  synonyms: SynonymsSchema,
  roiIdNaming: RoiIdNamingSchema,
  familyDefaults: FamilyDefaultsSchema,
  acceptancePolicies: AcceptancePoliciesSchema,
  examples: ExamplesSchema,
});

/** -----------------------------------------
 *  Types inferred from schema
 *  ----------------------------------------*/
export type PokemonCanon = z.infer<typeof PokemonCanonSchema>;
export type AcronymEntry = z.infer<typeof AcronymEntrySchema>;
export type Era = z.infer<typeof EraSchema>;
export type LayoutFamily = z.infer<typeof LayoutFamilySchema>;
export type RarityMarker = z.infer<typeof RarityMarkerSchema>;
export type RuleBoxCanonEntry = z.infer<typeof RuleBoxCanonEntrySchema>;
export type NumberFormat = z.infer<typeof NumberFormatSchema>;
export type NamePattern = z.infer<typeof NamePatternSchema>;
export type PriceChartingMap = z.infer<typeof PriceChartingMapSchema>;

/** -----------------------------------------
 *  Loader / validator helpers
 *  ----------------------------------------*/
export function validatePokemonCanon(json: unknown): PokemonCanon {
  const parsed = PokemonCanonSchema.parse(json);

  // Extra semantic checks that Zod alone can't express neatly:
  // 1) ROI id prefix must match an existing layout family
  const familySet = new Set<string>(LAYOUT_FAMILY_IDS);
  const checkRoiIds = (ids: string[], where: string) => {
    for (const id of ids) {
      const [family] = id.split(":");
      if (!familySet.has(family as LayoutFamilyId)) {
        throw new Error(`ROI id '${id}' in ${where} references unknown family '${family}'`);
      }
    }
  };
  
  for (const fam of parsed.layoutFamilies) {
    checkRoiIds(fam.defaultCoreRois, `layoutFamilies.${fam.id}.defaultCoreRois`);
    checkRoiIds(fam.conditionalRois, `layoutFamilies.${fam.id}.conditionalRois`);
  }
  
  for (const [famId, def] of Object.entries(parsed.familyDefaults)) {
    if (!familySet.has(famId as LayoutFamilyId)) {
      throw new Error(`familyDefaults has unknown key '${famId}'`);
    }
    checkRoiIds(def.critical, `familyDefaults.${famId}.critical`);
    checkRoiIds(def.standard, `familyDefaults.${famId}.standard`);
    checkRoiIds(def.detailed, `familyDefaults.${famId}.detailed`);
    checkRoiIds(def.optional, `familyDefaults.${famId}.optional`);
  }

  // 2) All eraHints used by families must be valid ERA_IDS
  for (const fam of parsed.layoutFamilies) {
    for (const e of fam.eraHints) {
      if (!ERA_IDS.includes(e)) {
        throw new Error(`Unknown eraHint '${e}' in layoutFamilies.${fam.id}`);
      }
    }
  }

  // 3) ruleBoxCanon.appliesToEras must be subset of ERA_IDS (already ensured by schema)

  return parsed;
}