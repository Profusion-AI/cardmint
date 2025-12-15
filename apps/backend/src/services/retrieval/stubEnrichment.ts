import type { Logger } from "pino";
import type { Candidate, ExtractedFields } from "../../domain/job";

export interface EnrichmentAdapter {
  enrichCandidates(extracted: ExtractedFields, candidates: Candidate[]): Promise<Candidate[]>;
}

/**
 * Stub enrichment layer – remains offline until Operator approves paid API usage.
 * Maintains SLO/SLA expectations documented in oct3-plan by avoiding external calls.
 */
export class StubEnrichmentAdapter implements EnrichmentAdapter {
  private readonly logOnce: () => void;

  constructor(private readonly logger: Logger) {
    let alreadyLogged = false;
    this.logOnce = () => {
      if (alreadyLogged) return;
      alreadyLogged = true;
      this.logger.info(
        {
          source: "retrieval",
          mode: "stub-enrichment",
        },
        "PokePriceTracker enrichment is gated; returning passthrough candidates",
      );
    };
  }

  async enrichCandidates(extracted: ExtractedFields, candidates: Candidate[]): Promise<Candidate[]> {
    if (candidates.length === 0) {
      return candidates;
    }

    // Log once so operators know enrichment is intentionally disabled for SLA control.
    this.logOnce();
    return candidates;
  }
}
