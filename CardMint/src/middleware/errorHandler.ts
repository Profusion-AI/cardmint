import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { v4 as uuidv4 } from 'uuid';

// Custom error types
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code?: string;
  public readonly details?: any;
  public readonly correlationId?: string;

  constructor(
    message: string,
    statusCode: number = 500,
    isOperational: boolean = true,
    code?: string,
    details?: any
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;
    this.details = details;
    this.correlationId = uuidv4();

    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: any) {
    super(message, 400, true, 'VALIDATION_ERROR', details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    const message = id 
      ? `${resource} with id ${id} not found`
      : `${resource} not found`;
    super(message, 404, true, 'NOT_FOUND');
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication failed') {
    super(message, 401, true, 'AUTHENTICATION_ERROR');
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string = 'Insufficient permissions') {
    super(message, 403, true, 'AUTHORIZATION_ERROR');
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfter?: number) {
    super('Too many requests', 429, true, 'RATE_LIMIT_ERROR', { retryAfter });
  }
}

export class ExternalServiceError extends AppError {
  constructor(service: string, originalError?: any) {
    super(
      `External service ${service} is unavailable`,
      503,
      true,
      'EXTERNAL_SERVICE_ERROR',
      { service, originalError: originalError?.message }
    );
  }
}

// Correlation ID middleware
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const correlationId = req.headers['x-correlation-id'] as string || uuidv4();
  (req as any).correlationId = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);
  
  // Add to logger context
  logger.child({ correlationId });
  
  next();
}

// Request context middleware
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const startTime = Date.now();
  
  // Log request
  logger.info('Incoming request', {
    method: req.method,
    path: req.path,
    query: req.query,
    correlationId: (req as any).correlationId,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  });

  // Track response
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    
    logger.info('Request completed', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      correlationId: (req as any).correlationId
    });

    // Record metrics
    metrics.observeHistogram('http_request_duration_ms', duration, {
      method: req.method,
      path: req.path,
      status: res.statusCode.toString()
    });

    metrics.increment('http_requests_total', {
      method: req.method,
      path: req.path,
      status: res.statusCode.toString()
    });
  });

  next();
}

// Main error handler middleware
export function errorHandler(
  error: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
) {
  const correlationId = (req as any).correlationId || uuidv4();

  // Determine if error is operational
  const isOperational = error instanceof AppError ? error.isOperational : false;
  
  // Get status code
  const statusCode = error instanceof AppError ? error.statusCode : 500;
  
  // Log error with appropriate level
  if (!isOperational || statusCode >= 500) {
    logger.error('Error occurred', {
      correlationId,
      error: {
        message: error.message,
        stack: error.stack,
        code: (error as AppError).code,
        details: (error as AppError).details
      },
      request: {
        method: req.method,
        path: req.path,
        query: req.query,
        body: req.body,
        headers: req.headers
      }
    });
  } else {
    logger.warn('Client error', {
      correlationId,
      error: {
        message: error.message,
        code: (error as AppError).code,
        details: (error as AppError).details
      },
      request: {
        method: req.method,
        path: req.path
      }
    });
  }

  // Record error metrics
  metrics.increment('errors_total', {
    type: (error as AppError).code || 'UNKNOWN',
    statusCode: statusCode.toString()
  });

  // Prepare error response
  const errorResponse: any = {
    error: {
      message: error.message,
      code: (error as AppError).code || 'INTERNAL_ERROR',
      correlationId
    }
  };

  // Add details in development mode
  if (process.env.NODE_ENV === 'development') {
    errorResponse.error.stack = error.stack;
    errorResponse.error.details = (error as AppError).details;
  }

  // Add retry-after header for rate limit errors
  if (error instanceof RateLimitError && error.details?.retryAfter) {
    res.setHeader('Retry-After', error.details.retryAfter);
  }

  // Send error response
  res.status(statusCode).json(errorResponse);

  // Handle non-operational errors (programmer errors)
  if (!isOperational) {
    // Log critical error
    logger.fatal('Non-operational error detected, consider restarting', {
      correlationId,
      error: error.message,
      stack: error.stack
    });

    // In production, you might want to restart the process
    if (process.env.NODE_ENV === 'production') {
      // Graceful shutdown
      process.emit('SIGTERM');
    }
  }
}

// Async error wrapper for route handlers
export function asyncHandler(fn: Function) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Validation error formatter
export function formatValidationErrors(errors: any[]): any {
  return errors.map(error => ({
    field: error.path,
    message: error.message,
    value: error.value
  }));
}

// Circuit breaker error handler
export function handleCircuitBreakerError(error: any): AppError {
  if (error.code === 'CIRCUIT_OPEN') {
    return new ExternalServiceError(error.circuit);
  }
  if (error.code === 'CIRCUIT_TIMEOUT') {
    return new AppError(
      'Request timeout',
      504,
      true,
      'GATEWAY_TIMEOUT',
      { circuit: error.circuit }
    );
  }
  return error;
}

// Database error handler
export function handleDatabaseError(error: any): AppError {
  // PostgreSQL error codes
  const pgErrorCodes: Record<string, { message: string; statusCode: number }> = {
    '23505': { message: 'Duplicate entry', statusCode: 409 },
    '23503': { message: 'Foreign key violation', statusCode: 400 },
    '23502': { message: 'Not null violation', statusCode: 400 },
    '22P02': { message: 'Invalid input syntax', statusCode: 400 },
    '42P01': { message: 'Table does not exist', statusCode: 500 },
    '42703': { message: 'Column does not exist', statusCode: 500 },
    '08003': { message: 'Connection does not exist', statusCode: 503 },
    '08006': { message: 'Connection failure', statusCode: 503 }
  };

  const errorInfo = pgErrorCodes[error.code];
  if (errorInfo) {
    return new AppError(
      errorInfo.message,
      errorInfo.statusCode,
      true,
      `DB_${error.code}`,
      { originalError: error.message }
    );
  }

  // Generic database error
  return new AppError(
    'Database operation failed',
    500,
    false,
    'DATABASE_ERROR',
    { originalError: error.message }
  );
}

// Not found handler (404)
export function notFoundHandler(req: Request, res: Response) {
  const error = new NotFoundError('Route', req.path);
  res.status(404).json({
    error: {
      message: error.message,
      code: error.code,
      correlationId: (req as any).correlationId
    }
  });
}

// Health check endpoint that bypasses error handling
export function healthCheckHandler(req: Request, res: Response) {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    correlationId: (req as any).correlationId
  });
}