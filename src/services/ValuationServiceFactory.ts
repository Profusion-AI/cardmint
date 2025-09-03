/**
 * ValuationServiceFactory: Initialize ValuationService with proper dependencies
 * 
 * Handles the setup of database connections and resolver dependencies
 * for clean integration with the CardMint application.
 */

import Database from 'better-sqlite3';
import { ValuationService } from './ValuationService';
import { DeterministicResolver } from '../resolution/DeterministicResolver';
import { ValuationTool } from '../tools/ValuationTool';
import { getDatabase } from '../storage/sqlite-database';
import { createLogger } from '../utils/logger';

const logger = createLogger('valuation-factory');

let valuationService: ValuationService | null = null;
let valuationTool: ValuationTool | null = null;

/**
 * Get or create singleton ValuationService instance
 */
export function getValuationService(): ValuationService {
  if (!valuationService) {
    initializeValuationService();
  }
  
  if (!valuationService) {
    throw new Error('Failed to initialize ValuationService');
  }
  
  return valuationService;
}

/**
 * Get or create singleton ValuationTool instance
 */
export function getValuationTool(): ValuationTool {
  if (!valuationTool) {
    const service = getValuationService();
    valuationTool = new ValuationTool(service);
    logger.info('ValuationTool initialized');
  }
  
  return valuationTool;
}

/**
 * Initialize ValuationService with dependencies
 */
function initializeValuationService(): void {
  try {
    // Get database connection
    const database = getDatabase();
    
    // Initialize DeterministicResolver
    const resolver = new DeterministicResolver(database);
    
    // Create ValuationService
    valuationService = new ValuationService(database, resolver);
    
    logger.info('ValuationService factory initialized successfully');
    
  } catch (error) {
    logger.error('Failed to initialize ValuationService', { 
      error: error instanceof Error ? error.message : String(error) 
    });
    throw error;
  }
}

/**
 * Check if valuation services are available
 */
export function isValuationEnabled(): boolean {
  return process.env.VALUATION_ENABLED === 'true';
}

/**
 * Get service health status
 */
export async function getHealthStatus(): Promise<{
  enabled: boolean;
  service: { available: boolean; message: string };
  tool: { available: boolean; message: string };
}> {
  const enabled = isValuationEnabled();
  
  if (!enabled) {
    return {
      enabled: false,
      service: { available: false, message: 'Disabled via VALUATION_ENABLED=false' },
      tool: { available: false, message: 'Disabled via VALUATION_ENABLED=false' }
    };
  }

  try {
    const service = getValuationService();
    const tool = getValuationTool();
    
    const serviceHealth = {
      available: true,
      message: `Service initialized (${service.getCacheStats().entries} cached entries)`
    };
    
    const toolHealth = await tool.healthCheck();
    
    return {
      enabled: true,
      service: serviceHealth,
      tool: toolHealth
    };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    return {
      enabled: true,
      service: { available: false, message: `Service error: ${errorMsg}` },
      tool: { available: false, message: `Tool error: ${errorMsg}` }
    };
  }
}

/**
 * Reset services (useful for testing)
 */
export function resetServices(): void {
  if (valuationService) {
    valuationService.clearCache();
  }
  
  valuationService = null;
  valuationTool = null;
  
  logger.info('Valuation services reset');
}