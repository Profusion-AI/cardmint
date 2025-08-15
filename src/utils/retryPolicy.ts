import { logger } from './logger';
import { metrics } from './metrics';

export interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  factor?: number;
  jitter?: boolean;
  retryCondition?: (error: any, attempt: number) => boolean;
  onRetry?: (error: any, attempt: number, delay: number) => void;
}

export class RetryPolicy {
  private readonly maxAttempts: number;
  private readonly initialDelay: number;
  private readonly maxDelay: number;
  private readonly factor: number;
  private readonly jitter: boolean;
  private readonly retryCondition: (error: any, attempt: number) => boolean;
  private readonly onRetry?: (error: any, attempt: number, delay: number) => void;

  constructor(options: RetryOptions = {}) {
    this.maxAttempts = options.maxAttempts || 3;
    this.initialDelay = options.initialDelay || 1000; // 1 second
    this.maxDelay = options.maxDelay || 30000; // 30 seconds
    this.factor = options.factor || 2;
    this.jitter = options.jitter !== false; // Default true
    this.retryCondition = options.retryCondition || this.defaultRetryCondition;
    this.onRetry = options.onRetry;
  }

  private defaultRetryCondition(error: any, attempt: number): boolean {
    // Don't retry if we've exceeded max attempts
    if (attempt >= this.maxAttempts) {
      return false;
    }

    // Don't retry on client errors (4xx) except 429 (rate limit)
    if (error.response) {
      const status = error.response.status;
      if (status >= 400 && status < 500 && status !== 429) {
        return false;
      }
    }

    // Don't retry on specific error codes
    const nonRetryableCodes = ['ENOTFOUND', 'EACCES', 'EPERM', 'INVALID_INPUT'];
    if (error.code && nonRetryableCodes.includes(error.code)) {
      return false;
    }

    // Retry on network errors, timeouts, and server errors
    return true;
  }

  private calculateDelay(attempt: number): number {
    // Exponential backoff
    let delay = this.initialDelay * Math.pow(this.factor, attempt - 1);

    // Cap at max delay
    delay = Math.min(delay, this.maxDelay);

    // Add jitter to prevent thundering herd
    if (this.jitter) {
      const jitterAmount = delay * 0.2; // 20% jitter
      delay = delay + (Math.random() * jitterAmount * 2 - jitterAmount);
    }

    return Math.round(delay);
  }

  async execute<T>(
    fn: () => Promise<T>,
    context?: string
  ): Promise<T> {
    let lastError: any;
    
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const result = await fn();
        
        // Success - record metrics
        if (attempt > 1) {
          metrics.increment('retry_success', { context, attempt });
          logger.info('Retry succeeded', { context, attempt });
        }
        
        return result;
      } catch (error) {
        lastError = error;

        // Check if we should retry
        if (!this.retryCondition(error, attempt)) {
          logger.warn('Retry condition not met, failing immediately', {
            context,
            attempt,
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }

        if (attempt < this.maxAttempts) {
          const delay = this.calculateDelay(attempt);
          
          logger.warn('Operation failed, retrying', {
            context,
            attempt,
            nextAttempt: attempt + 1,
            delay,
            error: error instanceof Error ? error.message : String(error)
          });

          // Call retry callback if provided
          if (this.onRetry) {
            this.onRetry(error, attempt, delay);
          }

          // Record retry metric
          metrics.increment('retry_attempt', { context, attempt });

          // Wait before retrying
          await this.sleep(delay);
        }
      }
    }

    // All attempts exhausted
    metrics.increment('retry_exhausted', { context });
    logger.error('All retry attempts exhausted', {
      context,
      maxAttempts: this.maxAttempts,
      error: lastError instanceof Error ? lastError.message : String(lastError)
    });

    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Pre-configured retry policies for different scenarios
export const retryPolicies = {
  // Fast retry for transient errors
  fast: new RetryPolicy({
    maxAttempts: 3,
    initialDelay: 100,
    maxDelay: 1000,
    factor: 2,
    jitter: true
  }),

  // Standard retry for API calls
  standard: new RetryPolicy({
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    factor: 2,
    jitter: true
  }),

  // Aggressive retry for critical operations
  aggressive: new RetryPolicy({
    maxAttempts: 5,
    initialDelay: 500,
    maxDelay: 30000,
    factor: 2,
    jitter: true
  }),

  // Rate limit aware retry
  rateLimited: new RetryPolicy({
    maxAttempts: 5,
    initialDelay: 2000,
    maxDelay: 60000,
    factor: 2,
    jitter: true,
    retryCondition: (error, attempt) => {
      // Always retry on rate limit errors
      if (error.response && error.response.status === 429) {
        // Check for Retry-After header
        const retryAfter = error.response.headers['retry-after'];
        if (retryAfter) {
          const delay = parseInt(retryAfter) * 1000;
          logger.info(`Rate limited, waiting ${delay}ms as per Retry-After header`);
        }
        return true;
      }
      // Use default condition for other errors
      return attempt < 5;
    }
  }),

  // No retry policy
  none: new RetryPolicy({
    maxAttempts: 1
  })
};

// Utility function to wrap any async function with retry
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions | RetryPolicy,
  context?: string
): Promise<T> {
  const policy = options instanceof RetryPolicy 
    ? options 
    : new RetryPolicy(options);
  
  return policy.execute(fn, context);
}

// Decorator for class methods
export function Retry(options?: RetryOptions) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    const policy = new RetryPolicy(options);

    descriptor.value = async function (...args: any[]) {
      const context = `${target.constructor.name}.${propertyKey}`;
      return policy.execute(
        () => originalMethod.apply(this, args),
        context
      );
    };

    return descriptor;
  };
}

// Helper function for retrying with exponential backoff and circuit breaker
export async function resilientExecute<T>(
  fn: () => Promise<T>,
  options: {
    retryPolicy?: RetryPolicy;
    circuitBreaker?: any; // Import CircuitBreaker type if needed
    context?: string;
  } = {}
): Promise<T> {
  const { retryPolicy = retryPolicies.standard, circuitBreaker, context } = options;

  const executeFn = async () => {
    if (circuitBreaker) {
      return circuitBreaker.execute(fn);
    }
    return fn();
  };

  return retryPolicy.execute(executeFn, context);
}