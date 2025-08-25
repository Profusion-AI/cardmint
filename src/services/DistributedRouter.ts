import { InferenceResult } from '../core/infer/InferencePort';
import { VerificationResult } from '../adapters/lmstudio/QwenVerifierInference';
import { AutoApprovalService, AutoApprovalDecision, createAutoApprovalService } from './AutoApprovalService';
import { ConfidenceRouter, type RoutingContext, type RoutingResult } from '../core/verification/ConfidenceRouter';
import { CardVerificationService } from './CardVerificationService';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { Card, CardStatus } from '../types';
import { CardRepository } from '../storage/CardRepository';
import path from 'path';
import fs from 'fs/promises';

export interface WorkItem {
  id: string;
  path: string;
  priority: 'normal' | 'high' | 'critical';
  value_tier: 'common' | 'rare' | 'holo' | 'vintage' | 'high_value';
  hint?: {
    set?: string;
    num?: string;
  };
  created_at: Date;
  retries: number;
}

export interface MacPrimaryRequest {
  model: 'qwen2.5-vl-7b-instruct-mlx';
  temperature: 0.0;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | Array<{
      type: 'text' | 'image_url';
      text?: string;
      image_url?: { url: string };
    }>;
  }>;
  response_format: { type: 'json_object' };
}

export interface MacPrimaryResponse {
  card_name: string;
  set_code: string;
  number: string;
  rarity: string;
  confidence: number;
}

export interface MacVerifierRequest {
  model: 'qwen2.5-0.5b-instruct-mlx';
  temperature: 0.1;
  max_tokens: 64;
  grammar?: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
}

export interface ToolCallResponse {
  name: 'verify_pokemon_card';
  arguments: {
    card_name: string;
    set_code?: string;
    confidence?: number;
  };
}

export interface ConfidencePolicy {
  common: { accept_threshold: number; verify_threshold: number };
  rare: { accept_threshold: number; verify_threshold: number };
  holo: { always_verify: boolean; accept_threshold: number };
  vintage: { always_verify: boolean; accept_threshold: number };
  high_value: { always_verify: boolean; accept_threshold: number };
}

export interface DistributedRouterConfig {
  mac_endpoint: string;
  batch_size: number;
  max_concurrent: number;
  retry_policy: {
    primary_retries: number;
    verifier_retries: number;
    backoff_base_ms: number;
  };
  confidence_policy: ConfidencePolicy;
  grammar_constraint?: string;
}

export class DistributedRouter {
  private config: DistributedRouterConfig;
  private cardRepository: CardRepository;
  private autoApprovalService: AutoApprovalService;
  private processingQueue: WorkItem[] = [];
  private isProcessing = false;

  constructor(config: DistributedRouterConfig) {
    this.config = config;
    this.cardRepository = new CardRepository();
    this.autoApprovalService = createAutoApprovalService({
      enabled: true, // Enable auto-approval in production
      bypass_verification: true, // Skip verification for high-confidence cards
      log_all_decisions: true // Full audit trail
    });
    
    // Setup metrics
    metrics.registerGauge('processing_queue_depth', 'Items in processing queue', () => this.processingQueue.length);
    metrics.registerGauge('mac_health_status', 'Mac endpoint health status', () => this.checkMacHealth() ? 1 : 0);
    
    logger.info('DistributedRouter initialized', { 
      mac_endpoint: config.mac_endpoint,
      auto_approval_enabled: true 
    });
  }

  async start(): Promise<void> {
    logger.info('Starting distributed router...');
    
    // Start processing loop
    this.startProcessingLoop();
    
    // Warm up Mac models
    await this.warmupMacModels();
    
    logger.info('Distributed router started successfully');
  }

  async enqueue(workItem: WorkItem): Promise<void> {
    this.processingQueue.push(workItem);
    metrics.recordGauge('queue_enqueued_total', this.processingQueue.length);
    
    logger.debug(`Enqueued work item: ${workItem.id}`, { 
      priority: workItem.priority, 
      value_tier: workItem.value_tier 
    });
  }

  private async startProcessingLoop(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.isProcessing) {
      if (this.processingQueue.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      // Process batch
      const batch = this.processingQueue.splice(0, this.config.batch_size);
      await this.processBatch(batch);
    }
  }

  private async processBatch(workItems: WorkItem[]): Promise<void> {
    const batchStart = Date.now();
    logger.info(`Processing batch: ${workItems.length} items`);

    try {
      // Step 1: Primary VLM inference (Fedora → Mac)
      const primaryResults = await this.callMacPrimary(workItems);
      
      // Step 2: Confidence routing decision (Fedora)
      const routingDecisions = this.applyConfidenceRouting(workItems, primaryResults);
      
      // Step 3: Verification for routed items (Fedora → Mac → Fedora)
      const verificationResults = await this.processVerifications(routingDecisions);
      
      // Step 4: Consolidate and persist (Fedora)
      await this.consolidateAndPersist(workItems, primaryResults, verificationResults, routingDecisions);
      
      const batchTime = Date.now() - batchStart;
      metrics.recordHistogram('batch_processing_ms', batchTime);
      
      logger.info(`Batch completed: ${workItems.length} items in ${batchTime}ms`);
      
    } catch (error) {
      logger.error('Batch processing failed:', error);
      metrics.recordError('batch_processing_failed');
      
      // Requeue with retry logic
      await this.requeueWithBackoff(workItems);
    }
  }

  private async callMacPrimary(workItems: WorkItem[]): Promise<MacPrimaryResponse[]> {
    const primaryStart = Date.now();
    const results: MacPrimaryResponse[] = [];
    
    // Process in parallel chunks to avoid overwhelming Mac
    const chunks = this.chunkArray(workItems, this.config.max_concurrent);
    
    for (const chunk of chunks) {
      const chunkPromises = chunk.map(async (item) => {
        const request: MacPrimaryRequest = {
          model: 'qwen2.5-vl-7b-instruct-mlx',
          temperature: 0.0,
          messages: [
            {
              role: 'system',
              content: 'You are a vision model that outputs STRICT JSON with fields: card_name (string), set_code (string), number (string), rarity (string), confidence (number 0-100). No prose.'
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Identify this card.' },
                { type: 'image_url', image_url: { url: `file://${item.path}` } }
              ]
            }
          ],
          response_format: { type: 'json_object' }
        };

        return this.callMacWithRetry('primary', request, this.config.retry_policy.primary_retries);
      });

      const chunkResults = await Promise.all(chunkPromises);
      results.push(...chunkResults);
    }

    const primaryTime = Date.now() - primaryStart;
    metrics.recordHistogram('mac_primary_latency_ms', primaryTime);
    metrics.incrementCounter('mac_primary_calls_total');
    
    logger.debug(`Mac primary inference: ${results.length} items in ${primaryTime}ms`);
    
    return results;
  }

  private applyConfidenceRouting(
    workItems: WorkItem[], 
    primaryResults: MacPrimaryResponse[]
  ): Array<{ item: WorkItem; result: MacPrimaryResponse; decision: 'accept' | 'verify' | 'auto_approved' }> {
    return workItems.map((item, index) => {
      const result = primaryResults[index];
      const policy = this.config.confidence_policy[item.value_tier];
      
      // Convert to InferenceResult format for auto-approval
      const inferenceResult: InferenceResult = {
        card_title: result.card_name,
        set_name: result.set_code,
        identifier: { number: result.number },
        confidence: result.confidence / 100, // Convert to 0-1 scale
        inference_time_ms: 0, // Will be calculated later
        details: { rarity: result.rarity }
      };

      // 🎯 AUTO-APPROVAL CHECK - High confidence cards bypass verification
      if (this.autoApprovalService.shouldBypassVerification(inferenceResult, item.value_tier)) {
        metrics.incrementCounter('routing_decisions_total', { 
          decision: 'auto_approved', 
          tier: item.value_tier,
          confidence_bucket: this.getConfidenceBucket(result.confidence)
        });
        
        logger.debug(`Auto-approval bypass: ${result.card_name} (${result.confidence}% confidence)`, {
          tier: item.value_tier,
          threshold: policy.accept_threshold
        });

        return { item, result, decision: 'auto_approved' };
      }
      
      let decision: 'accept' | 'verify' = 'accept';
      
      // Always verify high-value tiers (if not auto-approved)
      if ('always_verify' in policy && policy.always_verify) {
        decision = 'verify';
      }
      // Check confidence thresholds
      else if (result.confidence < policy.accept_threshold) {
        decision = 'verify';
      }
      else if (result.confidence < policy.verify_threshold && Math.random() < 0.1) {
        // 10% sample verification for quality assurance
        decision = 'verify';
      }

      // Track routing metrics
      metrics.incrementCounter('routing_decisions_total', { 
        decision, 
        tier: item.value_tier,
        confidence_bucket: this.getConfidenceBucket(result.confidence)
      });

      return { item, result, decision };
    });
  }

  private async processVerifications(
    routingDecisions: Array<{ item: WorkItem; result: MacPrimaryResponse; decision: 'accept' | 'verify' | 'auto_approved' }>
  ): Promise<Map<string, VerificationResult>> {
    const verifyStart = Date.now();
    const verificationsNeeded = routingDecisions.filter(r => r.decision === 'verify');
    const autoApprovedCount = routingDecisions.filter(r => r.decision === 'auto_approved').length;
    const verificationResults = new Map<string, VerificationResult>();

    if (verificationsNeeded.length === 0) {
      logger.debug(`Verification batch: ${autoApprovedCount} auto-approved, ${verificationsNeeded.length} need verification`);
      return verificationResults;
    }

    logger.debug(`Processing ${verificationsNeeded.length} verifications`);

    // Process verifications in parallel
    const verifyPromises = verificationsNeeded.map(async ({ item, result }) => {
      try {
        // Step 1: Get tool call from 0.5B model (Fedora → Mac)
        const toolCall = await this.getMacVerifierToolCall(result);
        
        // Step 2: Execute verification locally (Fedora)
        const verificationResult = await this.executeLocalVerification(toolCall);
        
        verificationResults.set(item.id, verificationResult);
        
      } catch (error) {
        logger.error(`Verification failed for ${item.id}:`, error);
        
        // Create fallback verification result
        verificationResults.set(item.id, {
          agrees_with_primary: false,
          confidence_adjustment: -0.1,
          database_matches: [],
          semantic_flags: ['verification_failed'],
          verification_time_ms: 0,
          verifier_confidence: 0.0
        });
      }
    });

    await Promise.all(verifyPromises);

    const verifyTime = Date.now() - verifyStart;
    metrics.recordHistogram('verification_batch_latency_ms', verifyTime);
    metrics.recordGauge('verification_rate', verificationsNeeded.length / routingDecisions.length);

    logger.debug(`Verifications completed: ${verificationResults.size} results in ${verifyTime}ms`);

    return verificationResults;
  }

  private async getMacVerifierToolCall(primaryResult: MacPrimaryResponse): Promise<ToolCallResponse> {
    const request: MacVerifierRequest = {
      model: 'qwen2.5-0.5b-instruct-mlx',
      temperature: 0.1,
      max_tokens: 64,
      grammar: this.config.grammar_constraint,
      messages: [
        {
          role: 'system',
          content: 'You ONLY call the function verify_pokemon_card. Extract fields exactly. No natural language.'
        },
        {
          role: 'user',
          content: `Vision model says: ${primaryResult.card_name} (${primaryResult.set_code}) conf=${primaryResult.confidence}. Verify.`
        },
        {
          role: 'assistant',
          content: '{"name":"verify_pokemon_card","arguments":{"card_name":"'
        }
      ]
    };

    const response = await this.callMacWithRetry('verifier', request, this.config.retry_policy.verifier_retries);
    return this.parseToolCallWithRecovery(response);
  }

  private async executeLocalVerification(toolCall: ToolCallResponse): Promise<VerificationResult> {
    const verifyStart = Date.now();
    
    try {
      // This would integrate with your existing CardVerificationService
      // For now, mock the database lookup
      const dbMatch = await this.mockDatabaseLookup(toolCall.arguments);
      
      const verificationTime = Date.now() - verifyStart;
      
      return {
        agrees_with_primary: dbMatch.found,
        confidence_adjustment: dbMatch.found ? 0.05 : -0.15,
        database_matches: dbMatch.matches,
        semantic_flags: dbMatch.flags,
        verification_time_ms: verificationTime,
        verifier_confidence: dbMatch.score
      };
      
    } catch (error) {
      logger.error('Local verification failed:', error);
      throw error;
    }
  }

  private async consolidateAndPersist(
    workItems: WorkItem[],
    primaryResults: MacPrimaryResponse[],
    verificationResults: Map<string, VerificationResult>,
    routingDecisions: Array<{ item: WorkItem; result: MacPrimaryResponse; decision: 'accept' | 'verify' | 'auto_approved' }>
  ): Promise<void> {
    const persistStart = Date.now();
    
    const persistPromises = workItems.map(async (item, index) => {
      const primaryResult = primaryResults[index];
      const verificationResult = verificationResults.get(item.id);
      const routingDecision = routingDecisions.find(rd => rd.item.id === item.id)?.decision || 'accept';
      
      // 🎯 AUTO-APPROVAL PROCESSING
      if (routingDecision === 'auto_approved') {
        // Convert to InferenceResult for auto-approval evaluation
        const inferenceResult: InferenceResult = {
          card_title: primaryResult.card_name,
          set_name: primaryResult.set_code,
          identifier: { number: primaryResult.number },
          confidence: primaryResult.confidence / 100,
          inference_time_ms: 0,
          details: { rarity: primaryResult.rarity }
        };

        // Let AutoApprovalService handle the complete approval process
        const approvalDecision = await this.autoApprovalService.evaluateForApproval(
          inferenceResult,
          verificationResult, // Usually undefined for auto-approved (bypassed verification)
          item.value_tier,
          item.path
        );

        logger.info(`Auto-approval decision: ${approvalDecision.decision}`, {
          card_name: primaryResult.card_name,
          confidence: primaryResult.confidence,
          tier: item.value_tier,
          approval_id: approvalDecision.approval_id,
          reason: approvalDecision.reason
        });

        // Auto-approval service handles storage for approved cards
        if (approvalDecision.decision === 'auto_approved') {
          metrics.incrementCounter('cards_auto_approved_stored');
          return; // Skip manual storage - already handled by AutoApprovalService
        }
      }

      // Standard processing for non-auto-approved cards
      let finalConfidence = primaryResult.confidence / 100; // Convert to 0-1 scale
      if (verificationResult) {
        finalConfidence += verificationResult.confidence_adjustment;
        finalConfidence = Math.max(0, Math.min(1, finalConfidence));
      }

      // Create card record
      const cardData: Partial<Card> = {
        imageUrl: item.path,
        status: CardStatus.PROCESSED,
        metadata: {
          cardName: primaryResult.card_name,
          cardSet: primaryResult.set_code,
          cardNumber: primaryResult.number,
          runId: `distributed_${Date.now()}`,
          customFields: {
            primary_confidence: primaryResult.confidence,
            verification_path: routingDecision === 'auto_approved' ? 'auto_approved' : 
                              verificationResult ? 'verified' : 'accepted',
            verifier_agrees: verificationResult?.agrees_with_primary,
            confidence_adjustment: verificationResult?.confidence_adjustment,
            semantic_flags: verificationResult?.semantic_flags,
            value_tier: item.value_tier,
            processing_mode: 'distributed'
          }
        },
        confidenceScore: finalConfidence
      };

      return this.cardRepository.createCard(cardData);
    });

    await Promise.all(persistPromises);

    const persistTime = Date.now() - persistStart;
    metrics.recordHistogram('persistence_latency_ms', persistTime);
    
    logger.debug(`Persisted ${workItems.length} cards in ${persistTime}ms`);
  }

  // Utility methods
  private async callMacWithRetry(
    endpoint: 'primary' | 'verifier',
    request: MacPrimaryRequest | MacVerifierRequest,
    maxRetries: number
  ): Promise<any> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.config.mac_endpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(30000) // 30s timeout
        });

        if (!response.ok) {
          throw new Error(`Mac ${endpoint} call failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        // Parse response based on endpoint
        if (endpoint === 'primary') {
          return JSON.parse(data.choices[0].message.content);
        } else {
          return data.choices[0].message.content;
        }
        
      } catch (error) {
        lastError = error as Error;
        metrics.recordError(`mac_${endpoint}_failed`);
        
        if (attempt < maxRetries) {
          const backoffMs = this.config.retry_policy.backoff_base_ms * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw lastError || new Error(`Mac ${endpoint} call failed after ${maxRetries} retries`);
  }

  private parseToolCallWithRecovery(modelOutput: string): ToolCallResponse {
    try {
      // Direct parsing
      return JSON.parse(modelOutput);
    } catch {
      try {
        // Fix common JSON errors
        const fixed = this.fixCommonJsonErrors(modelOutput);
        return JSON.parse(fixed);
      } catch {
        // Regex extraction fallback
        const cardNameMatch = modelOutput.match(/"card_name":\s*"([^"]+)"/);
        const setCodeMatch = modelOutput.match(/"set_code":\s*"([^"]+)"/);
        
        return {
          name: 'verify_pokemon_card',
          arguments: {
            card_name: cardNameMatch?.[1] || 'Unknown',
            set_code: setCodeMatch?.[1]
          }
        };
      }
    }
  }

  private fixCommonJsonErrors(text: string): string {
    // Add missing closing braces
    const openBraces = (text.match(/\{/g) || []).length;
    const closeBraces = (text.match(/\}/g) || []).length;
    text += '}}'.repeat(Math.max(0, openBraces - closeBraces));
    
    // Extract JSON portion
    const match = text.match(/(\{.*\})/);
    return match ? match[1] : text;
  }

  private async mockDatabaseLookup(args: { card_name: string; set_code?: string }): Promise<{
    found: boolean;
    matches: any[];
    flags: string[];
    score: number;
  }> {
    // Mock database lookup - replace with actual CardVerificationService integration
    await new Promise(resolve => setTimeout(resolve, 5)); // Simulate DB latency
    
    return {
      found: Math.random() > 0.2, // 80% match rate
      matches: [{ card_id: 'mock-123', similarity: 0.95 }],
      flags: [],
      score: 0.85
    };
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private getConfidenceBucket(confidence: number): string {
    if (confidence >= 90) return 'high';
    if (confidence >= 70) return 'medium';
    return 'low';
  }

  private async requeueWithBackoff(workItems: WorkItem[]): Promise<void> {
    for (const item of workItems) {
      item.retries++;
      if (item.retries < 3) {
        // Exponential backoff before requeuing
        setTimeout(() => {
          this.processingQueue.push(item);
        }, 1000 * Math.pow(2, item.retries));
      } else {
        logger.error(`Max retries exceeded for work item: ${item.id}`);
        metrics.recordError('work_item_max_retries_exceeded');
      }
    }
  }

  private async warmupMacModels(): Promise<void> {
    try {
      logger.info('Warming up Mac models...');
      
      // Warm up primary model with dummy request
      const dummyPrimary: MacPrimaryRequest = {
        model: 'qwen2.5-vl-7b-instruct-mlx',
        temperature: 0.0,
        messages: [
          { role: 'system', content: 'Warmup request' },
          { role: 'user', content: 'Test' }
        ],
        response_format: { type: 'json_object' }
      };
      
      await this.callMacWithRetry('primary', dummyPrimary, 1);
      
      // Warm up verifier model
      const dummyVerifier: MacVerifierRequest = {
        model: 'qwen2.5-0.5b-instruct-mlx',
        temperature: 0.1,
        max_tokens: 10,
        messages: [
          { role: 'system', content: 'Warmup' },
          { role: 'user', content: 'Test' }
        ]
      };
      
      await this.callMacWithRetry('verifier', dummyVerifier, 1);
      
      logger.info('Mac models warmed up successfully');
      
    } catch (error) {
      logger.warn('Mac model warmup failed (continuing anyway):', error);
    }
  }

  async checkMacHealth(): Promise<boolean> {
    try {
      // Test LM Studio API with a minimal request instead of non-existent /health endpoint
      const healthRequest = {
        model: "qwen2.5-0.5b-instruct-mlx", // Use smaller model for health checks
        temperature: 0.0,
        max_tokens: 1,
        messages: [{ role: "user", content: "test" }]
      };

      const response = await fetch(`${this.config.mac_endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(healthRequest),
        signal: AbortSignal.timeout(5000)
      });
      
      // LM Studio is healthy if it responds (even with an error about model loading)
      return response.ok || response.status === 200;
    } catch (error) {
      logger.debug('Mac health check failed:', error);
      return false;
    }
  }

  getStatistics() {
    const verificationRate = this.totalProcessed > 0 
      ? (this.verifyOptionalCount + this.verifyRequiredCount) / this.totalProcessed
      : 0;

    // Get auto-approval statistics
    const autoApprovalStats = this.autoApprovalService.getStatistics();

    return {
      total_processed: this.totalProcessed,
      verification_rate: verificationRate,
      routing_distribution: {
        skip_verify: this.skipVerifyCount,
        verify_optional: this.verifyOptionalCount,
        verify_required: this.verifyRequiredCount
      },
      average_latency_ms: this.averageLatency,
      
      // 🎯 AUTO-APPROVAL METRICS
      auto_approval: {
        enabled: true,
        approval_rate: autoApprovalStats.approval_rate,
        total_auto_approved: autoApprovalStats.auto_approved_count,
        avg_confidence_approved: autoApprovalStats.avg_confidence_approved,
        approvals_per_hour: autoApprovalStats.approvals_per_hour,
        review_required: autoApprovalStats.review_required_count
      }
    };
  }

  async stop(): Promise<void> {
    this.isProcessing = false;
    logger.info('Distributed router stopped');
  }
}