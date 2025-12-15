import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { createHash } from "node:crypto";
import type { Candidate, ExtractedFields, ScanJob } from "../../domain/job";
import {
  BasicCandidateScorer,
  type CandidateScorer,
  type PriceChartingCandidate,
  type EvidenceSignal,
  type ScoreExplanation,
  SCORER_VERSION,
  SIGNAL_SCHEMA_VERSION,
} from "./candidateScorer";
import { PriceChartingRepository, productUrl, guessVariantSuffix, guessRarity } from "./pricechartingRepository";
import { StubEnrichmentAdapter, type EnrichmentAdapter } from "./stubEnrichment";
import type { Evidence } from "./evidenceTypes";
import { isNationalDexInProductName } from "./nationalDexLookup";
import { CanonicalRepository } from "./canonicalRepository";
import { runtimeConfig } from "../../config";

const FALLBACK_SOURCE = "vision-fallback";

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";

export class RetrievalService {
  private readonly repository: PriceChartingRepository;
  private readonly canonicalRepository: CanonicalRepository;
  private readonly scorer: CandidateScorer;
  private readonly enrichment: EnrichmentAdapter;
  private corpusReady: Promise<void> | null = null;
  private readonly telemetry = {
    canonical_hit: 0,
    pricecharting_fallback: 0,
    canonical_unavailable: 0,
  };

  constructor(
    private readonly db: Database.Database,
    csvPath: string,
    private readonly logger: Logger,
    scorer: CandidateScorer = new BasicCandidateScorer(),
  ) {
    this.repository = new PriceChartingRepository(db, csvPath, logger);
    this.canonicalRepository = new CanonicalRepository(db, logger);
    this.scorer = scorer;
    this.enrichment = new StubEnrichmentAdapter(logger);
  }

  async getCandidates(
    extracted: ExtractedFields,
    limit = 3,
    setHint?: { name: string; tcgPlayerId: string; confidence: number }
  ): Promise<Candidate[]> {
    // Phase 3 feature flag: canonical-first retrieval
    if (runtimeConfig.canonicalRetrievalEnabled) {
      const canonicalPool = this.canonicalRepository.search(extracted, limit * 2);

      if (canonicalPool.length > 0) {
        this.telemetry.canonical_hit++;

        const scoredCanonical = canonicalPool.map((candidate) => {
          let score = this.scorer.score(extracted, candidate);

          // Path C soft reranking: boost candidates matching setHint
          // This is NOT a hard filter - just a scoring adjustment
          // IMPORTANT: Use strict equality only to avoid historical confusions like:
          //   - "Base Set" vs "Base Set 2"
          //   - "Team Rocket" vs "Team Rocket Returns"
          //   - "Jungle" vs "Jungle (1st Edition)"
          // Note: consoleName contains the set name in PriceChartingCandidate
          if (setHint && setHint.confidence >= 0.70) {
            const candidateSetName = (candidate.consoleName || "").toLowerCase().trim();
            const hintSetName = setHint.name.toLowerCase().trim();

            // Strict equality only - no substring matching to prevent set confusion
            if (candidateSetName === hintSetName) {
              // Boost score by hint confidence (scaled to 0-0.15 range)
              const boost = setHint.confidence * 0.15;
              score = Math.min(1.0, score + boost);
              this.logger.debug(
                { candidate_set: candidate.consoleName, hint_set: setHint.name, boost, new_score: score },
                "Path C soft rerank: boosted candidate score"
              );
            }
          }

          return { candidate, score };
        });

        scoredCanonical.sort((a, b) => b.score - a.score);

        const limitedCanonical = scoredCanonical
          .slice(0, limit)
          .map((entry) => this.toCandidate(entry.candidate, entry.score, "canonical"));

        const enriched = await this.enrichment.enrichCandidates(extracted, limitedCanonical);
        if (enriched.length > 0) {
          return enriched;
        }
      } else {
        this.telemetry.canonical_unavailable++;
        this.logger.warn(
          { set_name: extracted.set_name, set_number: extracted.set_number, card_name: extracted.card_name },
          "canonical catalog unavailable or no matches; falling back to pricecharting"
        );
      }
    }

    await this.ensureCorpus();

    const pool = this.repository.search(extracted, limit * 2);
    const scored = pool.map((candidate) => ({
      candidate,
      score: this.scorer.score(extracted, candidate),
    }));

    scored.sort((a, b) => b.score - a.score);

    const limited = scored
      .slice(0, limit)
      .map((entry) => this.toCandidate(entry.candidate, entry.score, "pricecharting"));

    this.telemetry.pricecharting_fallback++;

    const fallbacks = limited.length > 0 ? limited : this.buildFallback(extracted);

    if (fallbacks.length === 0) {
      return [];
    }

    return this.enrichment.enrichCandidates(extracted, fallbacks);
  }

  /**
   * Check if all candidates fall below the confidence threshold for reasonable matching.
   * Used to determine if a job should be marked as UNMATCHED_NO_REASONABLE_CANDIDATE.
   *
   * @param candidates - Top candidates returned from getCandidates()
   * @param threshold - Minimum confidence for a reasonable match (default 0.70)
   * @returns true if all candidates are below threshold (indicating unmatched)
   */
  isUnmatchedThreshold(candidates: Candidate[], threshold = 0.70): boolean {
    if (candidates.length === 0) {
      return true;
    }
    return candidates.every(c => c.confidence < threshold);
  }

  private async ensureCorpus(): Promise<void> {
    if (!this.corpusReady) {
      this.corpusReady = this.repository.ensureIngested().catch((error) => {
        this.logger.error({ err: error, datasetKey: "pricecharting_pokemon" }, "Failed to ingest PriceCharting reference data");
        // Propagate error after logging so we do not wedge callers.
        throw error;
      });
    }

    try {
      await this.corpusReady;
    } catch (error) {
      // Already logged. Retrieval can still return fallback candidates.
      this.corpusReady = Promise.resolve();
    }
  }

  getTelemetrySnapshot() {
    return { ...this.telemetry };
  }

  private toCandidate(candidate: PriceChartingCandidate, score: number, source: "canonical" | "pricecharting" | "ppt"): Candidate {
    const confidence = Math.max(0.05, Math.min(1, score));
    return {
      id: `${source}::${candidate.id}`,
      title: candidate.productName,
      confidence,
      source,
    };
  }

  private buildFallback(extracted: ExtractedFields): Candidate[] {
    if (!extracted.card_name) {
      return [];
    }

    return [
      {
        id: `fallback::${slugify(extracted.card_name)}`,
        title: extracted.card_name,
        confidence: 0.1,
        source: FALLBACK_SOURCE,
      },
    ];
  }

  /**
   * Generate evidence bundle for operator UI
   * Rehydrates full PriceCharting metadata from stored candidate IDs
   */
  async explainCandidates(job: ScanJob): Promise<Evidence> {
    const { extracted, top3, timings, capture_uid, inference_path } = job;

    // Resolve product_uid from item_uid and fetch CDN publication state
    let product_uid: string | null = null;
    let cdn_image_url: string | null = null;
    let cdn_back_image_url: string | null = null;
    let cdn_published_at: number | null = null;
    let enrichment_signals: Record<string, unknown> | null = null;
    try {
      if ((job as any).item_uid) {
        const row = this.db
          .prepare(`SELECT product_uid FROM items WHERE item_uid = ? LIMIT 1`)
          .get((job as any).item_uid) as { product_uid: string } | undefined;
        product_uid = row?.product_uid ?? null;

        // Fetch CDN publication state if we have a product_uid
        if (product_uid) {
          const productRow = this.db
            .prepare(`SELECT cdn_image_url, cdn_back_image_url, cdn_published_at FROM products WHERE product_uid = ? LIMIT 1`)
            .get(product_uid) as { cdn_image_url: string | null; cdn_back_image_url: string | null; cdn_published_at: number | null } | undefined;
          cdn_image_url = productRow?.cdn_image_url ?? null;
          cdn_back_image_url = productRow?.cdn_back_image_url ?? null;
          cdn_published_at = productRow?.cdn_published_at ?? null;
        }
      }

      // Fetch enrichment_signals from PPT cache if listing_sku available
      if (job.listing_sku) {
        const condition = (job as any).condition ?? "NM"; // Default to Near Mint if not set
        const cacheKey = `${job.listing_sku}:${condition}`;
        const cacheRow = this.db
          .prepare(`SELECT enrichment_signals FROM ppt_price_cache WHERE cache_key = ? LIMIT 1`)
          .get(cacheKey) as { enrichment_signals: string } | undefined;

        if (cacheRow?.enrichment_signals) {
          try {
            enrichment_signals = JSON.parse(cacheRow.enrichment_signals);
          } catch (parseErr) {
            this.logger.warn({ listing_sku: job.listing_sku, err: parseErr }, "Failed to parse enrichment_signals JSON");
            enrichment_signals = null;
          }
        }
      }
    } catch {
      product_uid = null;
      cdn_image_url = null;
      cdn_back_image_url = null;
      cdn_published_at = null;
      enrichment_signals = null;
    }

    // Filter canonical and PriceCharting candidates
    const canonicalCandidates = top3.filter((c) => c.id.startsWith("canonical::"));
    const pcCandidates = top3.filter((c) => c.id.startsWith("pricecharting::"));

    if (canonicalCandidates.length === 0 && pcCandidates.length === 0) {
      // All fallback candidates - return minimal evidence
      return this.buildFallbackEvidence(job.id, extracted, timings, capture_uid, inference_path, {
        product_sku: job.product_sku,
        listing_sku: job.listing_sku,
        item_uid: job.item_uid,
        product_uid: product_uid ?? undefined,
        cm_card_id: job.cm_card_id,
        scan_fingerprint: job.scan_fingerprint,
        cdn_image_url: cdn_image_url ?? undefined,
        cdn_back_image_url: cdn_back_image_url ?? undefined,
        cdn_published_at: cdn_published_at ?? undefined,
        enrichment_signals: enrichment_signals ?? undefined,
      });
    }

    // Rehydrate candidates from appropriate source
    let rehydrated: PriceChartingCandidate[] = [];
    let expectedCount = 0;
    let source: "canonical" | "pricecharting" = "pricecharting";

    if (canonicalCandidates.length > 0) {
      const canonicalIds = canonicalCandidates.map((c) => c.id.replace(/^canonical::/, ""));
      expectedCount = canonicalIds.length;
      rehydrated = this.canonicalRepository.getManyByIdsOrdered(canonicalIds);
      source = "canonical";
    }

    if (rehydrated.length === 0 && pcCandidates.length > 0) {
      const pcIds = pcCandidates.map((c) => c.id.replace(/^pricecharting::/, ""));
      expectedCount = pcIds.length;
      rehydrated = await this.repository.getManyByIdsOrdered(pcIds);
      source = "pricecharting";
    }

    // Guard: if getManyByIdsOrdered returns fewer results than expected (missing corpus rows),
    // fall back to unavailable evidence
    if (rehydrated.length === 0) {
      return this.buildFallbackEvidence(job.id, extracted, timings, capture_uid, inference_path, {
        product_sku: job.product_sku,
        listing_sku: job.listing_sku,
        item_uid: job.item_uid,
        product_uid: product_uid ?? undefined,
        cm_card_id: job.cm_card_id,
        scan_fingerprint: job.scan_fingerprint,
        cdn_image_url: cdn_image_url ?? undefined,
        cdn_back_image_url: cdn_back_image_url ?? undefined,
        cdn_published_at: cdn_published_at ?? undefined,
        enrichment_signals: enrichment_signals ?? undefined,
      });
    }

    // Build explanations for each candidate
    const explanations = rehydrated.map((candidate) => ({
      candidate,
      score: this.scorer.score(extracted, candidate),
      explain: this.scorer.explain(extracted, candidate),
    }));

    // Primary candidate (top scored)
    const primary = explanations[0];

    // Build provenance
    const corpusHash = source === "canonical" ? "canonical" : this.repository.getCorpusHash() ?? "unknown";
    const provenance = {
      scorer_version: SCORER_VERSION,
      signal_schema: SIGNAL_SCHEMA_VERSION,
      corpus_hash: corpusHash,
    };

    // Compute ETag: jobId + candidateIds + scorer_version + corpus_hash + breadcrumb fields
    // Include inference_path, retried_once, and capture_uid so cache invalidates when these change
    const candidateIds = rehydrated.map((c) => c.id).join(",");
    const etagPayload = `${job.id}:${candidateIds}:${SCORER_VERSION}:${corpusHash}:${inference_path ?? 'none'}:${timings.retried_once ?? false}:${capture_uid ?? ''}`;
    const etag = createHash("sha256").update(etagPayload).digest("hex").substring(0, 16);

    return {
      status: rehydrated.length < expectedCount ? "PARTIAL" : "AVAILABLE",
      provenance,
      etag,
      modelVerdict: {
        productId: primary.candidate.id,
        productName: primary.candidate.productName,
        setNumber: primary.candidate.cardNumber ?? null,
        setName: primary.candidate.consoleName ?? null,
        confidence: primary.score,
        why: this.selectTopSignals(primary.explain.signals),
        priceChartingUrl: source === "pricecharting" ? productUrl(primary.candidate.id) : undefined,
        referenceArtThumb: null, // Reserved for RFC-001
      },
      checks: this.buildFieldChecks(extracted, primary.explain, primary.candidate),
      variants: explanations.map((e) => ({
        productId: e.candidate.id,
        productName: e.candidate.productName,
        variantSuffix: guessVariantSuffix(e.candidate.productName),
        setNumber: e.candidate.cardNumber ?? null,
        rarity: guessRarity(e.candidate.productName),
        releaseYear: e.candidate.releaseYear ?? null,
        score: e.score,
        deltas: {
          name: this.compareNames(primary.explain, e.explain),
          setNumber: primary.candidate.cardNumber === e.candidate.cardNumber ? "match" : "mismatch",
          total: primary.candidate.totalSetSize === e.candidate.totalSetSize ? "match" : "mismatch",
        },
      })),
      alerts: this.buildAlerts(primary.explain),
      breadcrumbs: {
        pathA_ms: inference_path === "openai" ? timings.infer_ms ?? null : null,
        retries: timings.retried_once ? 1 : 0,
        captureUid: capture_uid ?? "",
        inference_path,
        pathC: timings.pathC_ran !== undefined ? {
          ran: timings.pathC_ran,
          action: timings.pathC_action ?? "skipped",
          confidence: timings.pathC_confidence ?? null,
          setHint: timings.pathC_set_hint ?? null,
          latencyMs: timings.pathC_latency_ms ?? null,
          matchingSignals: timings.pathC_matching_signals ?? [],
        } : null,
      },
      inventory: {
        product_sku: job.product_sku ?? null,
        listing_sku: job.listing_sku ?? null,
        item_uid: job.item_uid ?? null,
        product_uid: product_uid ?? null,
        cm_card_id: job.cm_card_id ?? null,
        scan_fingerprint: job.scan_fingerprint ?? null,
        cdn_image_url: cdn_image_url ?? null,
        cdn_back_image_url: cdn_back_image_url ?? null,
        cdn_published_at: cdn_published_at ?? null,
        enrichment_signals: enrichment_signals ?? undefined,
      },
    };
  }

  /**
   * Select top 5 signals by strength (strong > medium > weak)
   */
  private selectTopSignals(signals: EvidenceSignal[]): EvidenceSignal[] {
    const byStrength = (s: EvidenceSignal) =>
      s.strength === "strong" ? 0 : s.strength === "medium" ? 1 : 2;
    return [...signals].sort((a, b) => byStrength(a) - byStrength(b)).slice(0, 5);
  }

  /**
   * Build field-level checks for operator review
   */
  private buildFieldChecks(
    extracted: ExtractedFields,
    explanation: ScoreExplanation,
    candidate: PriceChartingCandidate,
  ): Evidence["checks"] {
    const checks: Evidence["checks"] = [];

    // Name check
    const nameExact = explanation.signals.find((s) => s.key === "nameExact");
    checks.push({
      field: "name",
      extracted: extracted.card_name ?? null,
      canonical: explanation.derived.candidateNameNorm,
      pass: !!nameExact,
      note: explanation.signals.find((s) => s.key === "nameSubstring" || s.key === "nameTokenOverlap")
        ? "Partial name match"
        : undefined,
    });

    // Set number check
    const setMatch = explanation.signals.find((s) => s.key === "setCardMatch");
    const totalMatch = explanation.signals.find((s) => s.key === "setTotalMatch");
    checks.push({
      field: "set_number",
      extracted: extracted.set_number ?? null,
      canonical: [explanation.derived.candidateSetCard, explanation.derived.candidateSetTotal]
        .filter(Boolean)
        .join("/") || null,
      pass:
        setMatch?.strength === "strong" &&
        (!explanation.derived.extractedSetTotal || totalMatch?.strength !== "weak"),
      note:
        explanation.derived.extractedSetTotal &&
        explanation.derived.candidateSetTotal &&
        explanation.derived.extractedSetTotal !== explanation.derived.candidateSetTotal
          ? "Total differs – possible reprint or sibling set"
          : undefined,
    });

    // Set name check (informational only)
    checks.push({
      field: "set_name",
      extracted: (extracted as any).set_name ?? null,
      canonical: candidate.consoleName ?? null,
      pass: false, // Always informational until canonical mapping exists
      note: "Set name is informational only until normalized canonical mapping lands (RFC-001)",
    });

    return checks;
  }

  /**
   * Build operator alerts for edge cases
   */
  private buildAlerts(explanation: ScoreExplanation): string[] {
    const alerts: string[] = [];

    const suffixMismatch = explanation.signals.find((s) => s.key === "suffixMismatch");
    if (suffixMismatch && suffixMismatch.strength !== "weak") {
      alerts.push(
        `⚠️ Variant mismatch: Model extracted no suffix, candidate has '${explanation.derived.candidateSuffix ?? ""}' → Review before accepting`,
      );
    }

    const setMismatch = explanation.signals.find((s) => s.key === "setCardMatch" && s.strength === "weak");
    if (setMismatch) {
      // Don't alert if the mismatch is due to National Dex number (not a real set number)
      const isNationalDexNote = setMismatch.detail?.includes("National Dex");
      if (!isNationalDexNote) {
        alerts.push(`⚠️ Set number disagrees with candidate – Double-check the lower corner`);
      }
    }

    return alerts;
  }

  /**
   * Compare names for variant deltas
   */
  private compareNames(
    primary: ScoreExplanation,
    candidate: ScoreExplanation,
  ): "suffixMismatch" | "nameOverlap" | null {
    if (primary.derived.candidateNameNorm === candidate.derived.candidateNameNorm) {
      return null;
    }

    const hasSuffixMismatch = candidate.signals.some((s) => s.key === "suffixMismatch");
    return hasSuffixMismatch ? "suffixMismatch" : "nameOverlap";
  }

  /**
   * Build fallback evidence when no PriceCharting matches exist
   */
  private buildFallbackEvidence(
    jobId: string,
    extracted: ExtractedFields,
    timings: ScanJob["timings"],
    capture_uid: string | undefined,
    inference_path: "openai" | "lmstudio" | undefined,
    inventory?: {
      product_sku?: string;
      listing_sku?: string;
      item_uid?: string;
      product_uid?: string;
      cm_card_id?: string;
      scan_fingerprint?: string;
      cdn_image_url?: string;
      cdn_back_image_url?: string;
      cdn_published_at?: number;
      enrichment_signals?: Record<string, unknown>;
    },
  ): Evidence {
    const provenance = {
      scorer_version: SCORER_VERSION,
      signal_schema: SIGNAL_SCHEMA_VERSION,
      corpus_hash: "unavailable",
    };

    // Compute ETag for fallback evidence (include breadcrumbs for consistency)
    const etagPayload = `${jobId}:fallback:${SCORER_VERSION}:${inference_path ?? 'none'}:${timings.retried_once ?? false}:${capture_uid ?? ''}`;
    const etag = createHash("sha256").update(etagPayload).digest("hex").substring(0, 16);

    return {
      status: "UNAVAILABLE",
      provenance,
      etag,
      modelVerdict: {
        productId: "unknown",
        productName: extracted.card_name ?? "Unknown Card",
        setNumber: extracted.set_number ?? null,
        setName: (extracted as any).set_name ?? null,
        confidence: 0.1,
        why: [{ key: "nameTokenOverlap", strength: "weak", detail: "No database match" }],
        priceChartingUrl: undefined,
        referenceArtThumb: null,
      },
      checks: [
        {
          field: "name",
          extracted: extracted.card_name,
          canonical: null,
          pass: false,
          note: "No reference data available – Manual lookup required",
        },
        {
          field: "set_number",
          extracted: extracted.set_number,
          canonical: null,
          pass: false,
          note: "No reference data available",
        },
        {
          field: "set_name",
          extracted: (extracted as any).set_name,
          canonical: null,
          pass: false,
          note: "No reference data available",
        },
      ],
      variants: [],
      alerts: ["⚠️ No PriceCharting match found – Verify card manually before accepting"],
      breadcrumbs: {
        pathA_ms: inference_path === "openai" ? timings.infer_ms ?? null : null,
        retries: timings.retried_once ? 1 : 0,
        captureUid: capture_uid ?? "",
        inference_path,
        pathC: timings.pathC_ran !== undefined ? {
          ran: timings.pathC_ran,
          action: timings.pathC_action ?? "skipped",
          confidence: timings.pathC_confidence ?? null,
          setHint: timings.pathC_set_hint ?? null,
          latencyMs: timings.pathC_latency_ms ?? null,
          matchingSignals: timings.pathC_matching_signals ?? [],
        } : null,
      },
      inventory: {
        product_sku: inventory?.product_sku ?? null,
        listing_sku: inventory?.listing_sku ?? null,
        item_uid: inventory?.item_uid ?? null,
        product_uid: inventory?.product_uid ?? null,
        cm_card_id: inventory?.cm_card_id ?? null,
        scan_fingerprint: inventory?.scan_fingerprint ?? null,
        cdn_image_url: inventory?.cdn_image_url ?? null,
        cdn_back_image_url: inventory?.cdn_back_image_url ?? null,
        cdn_published_at: inventory?.cdn_published_at ?? null,
        enrichment_signals: inventory?.enrichment_signals ?? undefined,
      },
    };
  }

  /**
   * Get sibling variants for a reference candidate (HT-001).
   * Used by GET /api/jobs/:id/variants for variant drawer expansion.
   *
   * @param referenceCandidate - Candidate from job's top3 to use as family anchor
   * @param limit - Maximum siblings to return (default 20)
   * @returns Array of sibling candidates as Candidate objects with confidence scores
   */
  async getSiblingVariants(referenceCandidate: Candidate, limit = 20): Promise<Candidate[]> {
    await this.ensureCorpus();

    // Strip pricecharting:: prefix to get raw ID
    const rawId = referenceCandidate.id.replace(/^pricecharting::/, "");

    // Retrieve full PriceCharting candidate data for the reference
    const [fullCandidate] = await this.repository.getManyByIdsOrdered([rawId]);

    if (!fullCandidate) {
      this.logger.warn(
        { candidateId: referenceCandidate.id },
        "Reference candidate not found in corpus - cannot fetch siblings"
      );
      return [];
    }

    // Get sibling variants using family grouping
    const siblings = this.repository.getSiblingsByFamily(fullCandidate, limit);

    // Convert to Candidate format with scores
    // Note: Siblings are already sorted by sales_volume DESC in repository
    return siblings.map((sibling) => {
      // Use a baseline confidence score for siblings (not re-scored against extraction)
      // This allows operators to see the full family without scorer bias
      const baselineConfidence = 0.5;
      return this.toCandidate(sibling, baselineConfidence, "pricecharting");
    });
  }

  /**
   * Get corpus hash for provenance tracking (HT-001).
   * Returns SHA256 checksum of the PriceCharting CSV to identify which dataset version
   * was used when variants were retrieved.
   */
  getCorpusHash(): string | null {
    return this.repository.getCorpusHash();
  }
}
