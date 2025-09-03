/**
 * ValuationTool: GPT-OSS tool interface for card valuation
 * 
 * Provides a simple, token-efficient interface for GPT to compare
 * raw vs graded resale values with minimal computational overhead.
 */

import { ValuationService, ValuationResult } from '../services/ValuationService';
import { createLogger } from '../utils/logger';

const logger = createLogger('valuation-tool');

export interface ValuationToolInput {
  query?: string;
  cardId?: string;
  variant?: {
    finish?: 'normal' | 'holo' | 'reverse' | 'full' | 'gold';
    edition?: '1st' | 'unlimited' | 'shadowless' | 'promo';
  };
  marketplaces?: string[];  // Future: ['ebay', 'fanatics', 'tcgplayer']
  grading?: {
    provider?: 'PSA' | 'BGS' | 'CGC' | 'SGC';
    enabled?: boolean;
  };
}

export interface ValuationToolOutput {
  recommendation: 'raw' | 'graded' | 'insufficient_data';
  summary: string;
  details: {
    rawNetCents: number;
    gradedNetCents: number;
    advantageCents: number;
    chosenBasis: string;
    confidence: number;
  };
  assumptions: {
    fees: string;
    costs: string;
    priors: string;
  };
  evidence: string[];
  metadata: {
    processingTimeMs: number;
    cacheHit?: boolean;
  };
}

export class ValuationTool {
  private valuationService: ValuationService;

  constructor(valuationService: ValuationService) {
    this.valuationService = valuationService;
  }

  /**
   * Main tool interface for GPT-OSS integration
   * Returns structured JSON that GPT can summarize in 1-2 sentences
   */
  async compareResale(input: ValuationToolInput): Promise<ValuationToolOutput> {
    const startTime = Date.now();
    
    try {
      logger.debug('Processing valuation tool request', { 
        query: input.query, 
        cardId: input.cardId 
      });

      // Call ValuationService
      const result: ValuationResult = await this.valuationService.compareResale({
        query: input.query,
        cardId: input.cardId,
        variant: input.variant
      });

      // Transform to tool output format
      const output = this.transformToToolOutput(result, startTime);
      
      logger.info('Valuation tool completed', {
        recommendation: output.recommendation,
        processingTimeMs: output.metadata.processingTimeMs,
        confidence: output.details.confidence
      });

      return output;

    } catch (error) {
      logger.error('Valuation tool failed', { 
        input, 
        error: error instanceof Error ? error.message : String(error) 
      });

      // Return safe error response
      return this.createErrorResponse(startTime, error);
    }
  }

  /**
   * Transform ValuationResult to GPT-friendly tool output
   */
  private transformToToolOutput(result: ValuationResult, startTime: number): ValuationToolOutput {
    const processingTimeMs = Date.now() - startTime;
    const advantageCents = result.gradedNetCents - result.rawNetCents;

    // Generate concise summary for GPT
    const summary = this.generateSummary(result, advantageCents);

    return {
      recommendation: result.recommendation,
      summary,
      details: {
        rawNetCents: result.rawNetCents,
        gradedNetCents: result.gradedNetCents,
        advantageCents,
        chosenBasis: result.chosenBasis,
        confidence: Math.round(result.confidence * 100) / 100
      },
      assumptions: {
        fees: `eBay ${(result.assumptions.fees.raw * 100).toFixed(1)}%, Fanatics ${(result.assumptions.fees.graded * 100).toFixed(1)}%`,
        costs: `Grading $${(result.assumptions.costs.grading / 100).toFixed(0)}, Shipping $${(result.assumptions.costs.shipping / 100).toFixed(0)}`,
        priors: `PSA 9: ${(result.assumptions.priors.psa9 * 100).toFixed(0)}%, PSA 10: ${(result.assumptions.priors.psa10 * 100).toFixed(0)}%`
      },
      evidence: result.evidence,
      metadata: {
        processingTimeMs
      }
    };
  }

  /**
   * Generate human-readable summary for GPT to use
   */
  private generateSummary(result: ValuationResult, advantageCents: number): string {
    if (result.recommendation === 'insufficient_data') {
      return 'Unable to provide valuation due to insufficient price data';
    }

    const advantageDollars = Math.abs(advantageCents) / 100;
    
    if (result.recommendation === 'graded') {
      return `Grading recommended: Expected net gain of $${advantageDollars.toFixed(2)} after grading costs and fees`;
    } else {
      return `Sell raw recommended: Saves $${advantageDollars.toFixed(2)} compared to grading costs and risks`;
    }
  }

  /**
   * Create error response that's safe for GPT consumption
   */
  private createErrorResponse(startTime: number, error: any): ValuationToolOutput {
    const processingTimeMs = Date.now() - startTime;
    
    return {
      recommendation: 'insufficient_data',
      summary: 'Valuation service temporarily unavailable',
      details: {
        rawNetCents: 0,
        gradedNetCents: 0,
        advantageCents: 0,
        chosenBasis: 'none',
        confidence: 0
      },
      assumptions: {
        fees: 'N/A',
        costs: 'N/A',
        priors: 'N/A'
      },
      evidence: ['Service error occurred during valuation'],
      metadata: {
        processingTimeMs
      }
    };
  }

  /**
   * Tool metadata for GPT-OSS registration
   */
  static getToolMetadata() {
    return {
      name: 'valuation.compareResale',
      description: 'Compare raw vs graded resale value for Pokemon cards',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Free-form card description (e.g., "Charizard Base Set unlimited")'
          },
          cardId: {
            type: 'string',
            description: 'Specific card ID if known'
          },
          variant: {
            type: 'object',
            properties: {
              finish: {
                type: 'string',
                enum: ['normal', 'holo', 'reverse', 'full', 'gold'],
                description: 'Card finish type'
              },
              edition: {
                type: 'string',
                enum: ['1st', 'unlimited', 'shadowless', 'promo'],
                description: 'Card edition'
              }
            }
          }
        },
        required: []
      }
    };
  }

  /**
   * Health check for tool availability
   */
  async healthCheck(): Promise<{ available: boolean; message: string }> {
    try {
      const stats = this.valuationService.getCacheStats();
      return {
        available: true,
        message: `ValuationTool healthy (${stats.entries} cached entries)`
      };
    } catch (error) {
      return {
        available: false,
        message: `ValuationTool unavailable: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
}