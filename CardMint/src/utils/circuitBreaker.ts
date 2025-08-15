import { logger } from './logger';
import { metrics } from './metrics';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number;
  successThreshold?: number;
  timeout?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
  errorFilter?: (error: any) => boolean;
  onStateChange?: (state: CircuitState) => void;
}

export class CircuitBreaker<T = any> {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime?: number;
  private nextAttempt?: number;
  private requestCount = 0;
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly timeout: number;
  private readonly resetTimeout: number;
  private readonly volumeThreshold: number;
  private readonly errorFilter: (error: any) => boolean;
  private readonly onStateChange?: (state: CircuitState) => void;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 2;
    this.timeout = options.timeout || 60000; // 1 minute
    this.resetTimeout = options.resetTimeout || 30000; // 30 seconds
    this.volumeThreshold = options.volumeThreshold || 10;
    this.errorFilter = options.errorFilter || (() => true);
    this.onStateChange = options.onStateChange;

    // Initialize metrics
    this.initializeMetrics();
  }

  private initializeMetrics(): void {
    // Register circuit breaker metrics
    metrics.registerGauge(
      `circuit_breaker_state_${this.name}`,
      `Circuit breaker state for ${this.name} (0=closed, 1=open, 2=half-open)`,
      () => {
        switch (this.state) {
          case CircuitState.CLOSED: return 0;
          case CircuitState.OPEN: return 1;
          case CircuitState.HALF_OPEN: return 2;
        }
      }
    );

    metrics.registerGauge(
      `circuit_breaker_failure_count_${this.name}`,
      `Failure count for ${this.name} circuit breaker`,
      () => this.failureCount
    );
  }

  async execute<R>(fn: () => Promise<R>): Promise<R> {
    // Check if circuit should be reset
    this.checkAndResetCircuit();

    if (this.state === CircuitState.OPEN) {
      const error = new Error(`Circuit breaker is OPEN for ${this.name}`);
      (error as any).code = 'CIRCUIT_OPEN';
      (error as any).circuit = this.name;
      throw error;
    }

    try {
      // Execute the function with timeout
      const result = await this.executeWithTimeout(fn);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private async executeWithTimeout<R>(fn: () => Promise<R>): Promise<R> {
    return new Promise<R>(async (resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Circuit breaker timeout for ${this.name}`);
        (error as any).code = 'CIRCUIT_TIMEOUT';
        reject(error);
      }, this.timeout);

      try {
        const result = await fn();
        clearTimeout(timer);
        resolve(result);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private onSuccess(): void {
    this.requestCount++;
    this.failureCount = 0;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      
      if (this.successCount >= this.successThreshold) {
        this.changeState(CircuitState.CLOSED);
        logger.info(`Circuit breaker ${this.name} closed after successful recovery`);
      }
    }

    // Record success metric
    metrics.increment(`circuit_breaker_success_${this.name}`);
  }

  private onFailure(error: any): void {
    this.requestCount++;

    // Check if error should trigger circuit breaker
    if (!this.errorFilter(error)) {
      logger.debug(`Circuit breaker ${this.name} ignoring filtered error`, { error });
      return;
    }

    this.failureCount++;
    this.lastFailureTime = Date.now();

    // Record failure metric
    metrics.increment(`circuit_breaker_failure_${this.name}`);

    if (this.state === CircuitState.HALF_OPEN) {
      this.changeState(CircuitState.OPEN);
      logger.warn(`Circuit breaker ${this.name} reopened due to failure in half-open state`);
      return;
    }

    if (this.state === CircuitState.CLOSED) {
      // Check if we've exceeded the failure threshold
      if (this.requestCount >= this.volumeThreshold && 
          this.failureCount >= this.failureThreshold) {
        this.changeState(CircuitState.OPEN);
        this.nextAttempt = Date.now() + this.resetTimeout;
        logger.error(`Circuit breaker ${this.name} opened due to excessive failures`, {
          failureCount: this.failureCount,
          threshold: this.failureThreshold
        });
      }
    }
  }

  private checkAndResetCircuit(): void {
    if (this.state === CircuitState.OPEN && this.nextAttempt && Date.now() >= this.nextAttempt) {
      this.changeState(CircuitState.HALF_OPEN);
      this.successCount = 0;
      logger.info(`Circuit breaker ${this.name} entering half-open state for testing`);
    }
  }

  private changeState(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    if (oldState !== newState) {
      logger.info(`Circuit breaker ${this.name} state changed`, {
        from: oldState,
        to: newState
      });

      if (this.onStateChange) {
        this.onStateChange(newState);
      }

      // Reset counters when closing
      if (newState === CircuitState.CLOSED) {
        this.failureCount = 0;
        this.successCount = 0;
        this.requestCount = 0;
      }
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getStats() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      requestCount: this.requestCount,
      lastFailureTime: this.lastFailureTime,
      nextAttempt: this.nextAttempt
    };
  }

  reset(): void {
    this.changeState(CircuitState.CLOSED);
    this.failureCount = 0;
    this.successCount = 0;
    this.requestCount = 0;
    this.lastFailureTime = undefined;
    this.nextAttempt = undefined;
    logger.info(`Circuit breaker ${this.name} manually reset`);
  }
}

// Factory function for creating circuit breakers with common configurations
export function createAPICircuitBreaker(serviceName: string): CircuitBreaker {
  return new CircuitBreaker({
    name: serviceName,
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 5000, // 5 seconds
    resetTimeout: 30000, // 30 seconds
    volumeThreshold: 10,
    errorFilter: (error) => {
      // Don't trip circuit for client errors (4xx)
      if (error.response && error.response.status >= 400 && error.response.status < 500) {
        return false;
      }
      return true;
    },
    onStateChange: (state) => {
      // Could send alerts here
      if (state === CircuitState.OPEN) {
        logger.error(`ALERT: ${serviceName} circuit breaker is OPEN - service degraded`);
      }
    }
  });
}

// Circuit breaker registry for managing multiple breakers
class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  register(name: string, breaker: CircuitBreaker): void {
    this.breakers.set(name, breaker);
  }

  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  getAll(): Map<string, CircuitBreaker> {
    return this.breakers;
  }

  getStats() {
    const stats: Record<string, any> = {};
    this.breakers.forEach((breaker, name) => {
      stats[name] = breaker.getStats();
    });
    return stats;
  }

  resetAll(): void {
    this.breakers.forEach(breaker => breaker.reset());
  }
}

export const circuitBreakerRegistry = new CircuitBreakerRegistry();

// Pre-configured circuit breakers for common services
export const pokemonTCGCircuitBreaker = createAPICircuitBreaker('pokemon-tcg-api');
export const priceChartingCircuitBreaker = createAPICircuitBreaker('pricecharting-api');
export const imageServiceCircuitBreaker = createAPICircuitBreaker('image-service');

// Register pre-configured breakers
circuitBreakerRegistry.register('pokemon-tcg-api', pokemonTCGCircuitBreaker);
circuitBreakerRegistry.register('pricecharting-api', priceChartingCircuitBreaker);
circuitBreakerRegistry.register('image-service', imageServiceCircuitBreaker);