import pino from 'pino';

const isDevelopment = process.env.NODE_ENV === 'development';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  base: {
    service: 'cardmint',
    env: process.env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    error: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

export function createLogger(module: string) {
  const moduleLogger = logger.child({ module });
  
  // Wrap methods to fix TypeScript issues
  return {
    info: (msg: string, ...args: any[]) => moduleLogger.info(msg, ...args),
    error: (msg: string, ...args: any[]) => moduleLogger.error(msg, ...args),
    warn: (msg: string, ...args: any[]) => moduleLogger.warn(msg, ...args),
    debug: (msg: string, ...args: any[]) => moduleLogger.debug(msg, ...args),
    fatal: (msg: string, ...args: any[]) => moduleLogger.fatal(msg, ...args),
  };
}