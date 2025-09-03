import http from 'http';
import { URL } from 'url';
import { createLogger } from './logger';

const logger = createLogger('dev-proxy');

export interface ProxyConfig {
  target: string;
  changeOrigin?: boolean;
  pathRewrite?: Record<string, string>;
}

/**
 * Simple HTTP proxy for development mode
 * Proxies requests to Vite dev server for HMR support
 */
export function createProxyHandler(config: ProxyConfig) {
  const targetUrl = new URL(config.target);
  
  return (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    return new Promise((resolve) => {
      try {
        // Apply path rewrites if configured
        let pathname = req.url || '/';
        if (config.pathRewrite) {
          for (const [from, to] of Object.entries(config.pathRewrite)) {
            pathname = pathname.replace(new RegExp(from), to);
          }
        }

        const proxyOptions = {
          hostname: targetUrl.hostname,
          port: targetUrl.port,
          path: pathname,
          method: req.method,
          headers: {
            ...req.headers,
            host: config.changeOrigin ? targetUrl.host : req.headers.host,
          },
        };

        logger.debug(`Proxying ${req.method} ${req.url} to ${config.target}${pathname}`);

        const proxyReq = http.request(proxyOptions, (proxyRes) => {
          // Copy response headers
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
          
          // Pipe response
          proxyRes.pipe(res);
          resolve(true);
        });

        proxyReq.on('error', (error) => {
          logger.error('Proxy request failed:', error);
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Bad Gateway - Vite dev server unavailable');
          resolve(false);
        });

        // Pipe request body if present
        req.pipe(proxyReq);

      } catch (error) {
        logger.error('Proxy handler error:', error);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        resolve(false);
      }
    });
  };
}

/**
 * Check if Vite dev server is available
 */
export async function isViteServerAvailable(port: number = 5173): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      method: 'GET',
      path: '/',
      timeout: 1000,
    }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 404);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => resolve(false));
    req.end();
  });
}