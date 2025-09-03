#!/usr/bin/env node

import { spawn, ChildProcess } from 'child_process';
import { createLogger } from './logger';
import net from 'net';

const logger = createLogger('process-manager');

export interface ServiceConfig {
  name: string;
  command: string;
  args: string[];
  preferredPort?: number;
  portRange?: [number, number];
  env?: Record<string, string>;
  restartDelay?: number;
}

export interface PortAllocation {
  [serviceName: string]: number;
}

export class ProcessManager {
  private processes: Map<string, ChildProcess> = new Map();
  private portAllocations: PortAllocation = {};
  private shuttingDown = false;

  constructor(private services: ServiceConfig[]) {
    this.setupSignalHandlers();
  }

  private setupSignalHandlers(): void {
    process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error);
      this.gracefulShutdown('uncaughtException');
    });
  }

  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      
      server.listen(port, () => {
        server.close(() => resolve(true));
      });
      
      server.on('error', () => resolve(false));
    });
  }

  private async allocatePort(service: ServiceConfig): Promise<number | null> {
    // Try preferred port first
    if (service.preferredPort && await this.isPortAvailable(service.preferredPort)) {
      logger.info(`Allocated preferred port ${service.preferredPort} for ${service.name}`);
      return service.preferredPort;
    }

    // Try port range
    if (service.portRange) {
      const [start, end] = service.portRange;
      for (let port = start; port <= end; port++) {
        if (await this.isPortAvailable(port)) {
          logger.info(`Allocated fallback port ${port} for ${service.name}`);
          return port;
        }
      }
    }

    logger.error(`No available port found for ${service.name}`);
    return null;
  }

  private async allocateAllPorts(): Promise<boolean> {
    logger.info('Allocating ports for all services...');
    
    for (const service of this.services) {
      if (service.preferredPort || service.portRange) {
        const port = await this.allocatePort(service);
        if (!port) {
          logger.error(`Failed to allocate port for ${service.name}`);
          return false;
        }
        this.portAllocations[service.name] = port;
      }
    }

    logger.info('Port allocations:', this.portAllocations);
    return true;
  }

  private startService(service: ServiceConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.info(`Starting service: ${service.name}`);

      const env = {
        ...process.env,
        ...service.env
      };

      // Use deterministic ports from environment (no dynamic allocation)
      if (service.name === 'api') {
        env.API_PORT = process.env.API_PORT || '3000';
        env.WS_PORT = process.env.WS_PORT || '3001';
        logger.info(`API service using deterministic ports: API=${env.API_PORT}, WS=${env.WS_PORT}`);
      }
      
      if (service.name === 'dashboard') {
        env.DASH_PORT = process.env.DASH_PORT || '5173';
        env.VITE_API_BASE = process.env.VITE_API_BASE || 'http://localhost:3000';
        logger.info(`Dashboard using deterministic config: PORT=${env.DASH_PORT}, API=${env.VITE_API_BASE}`);
      }

      const childProcess = spawn(service.command, service.args, {
        stdio: 'inherit',
        env
      });

      childProcess.on('spawn', () => {
        logger.info(`✅ ${service.name} started (PID: ${childProcess.pid})`);
        resolve();
      });

      childProcess.on('error', (error) => {
        logger.error(`❌ Failed to start ${service.name}:`, error);
        reject(error);
      });

      childProcess.on('exit', (code, signal) => {
        logger.warn(`${service.name} exited with code ${code}, signal ${signal}`);
        this.processes.delete(service.name);
        
        // Restart unless shutting down
        if (!this.shuttingDown && service.restartDelay !== undefined) {
          setTimeout(() => {
            if (!this.shuttingDown) {
              logger.info(`Restarting ${service.name} in ${service.restartDelay}ms`);
              this.startService(service);
            }
          }, service.restartDelay || 5000);
        }
      });

      this.processes.set(service.name, childProcess);
    });
  }

  public async start(): Promise<void> {
    logger.info('🚀 Starting CardMint Process Manager');

    // Allocate ports first
    const portsAllocated = await this.allocateAllPorts();
    if (!portsAllocated) {
      throw new Error('Failed to allocate required ports');
    }

    // Start all services
    const startPromises = this.services.map(service => this.startService(service));
    
    try {
      await Promise.all(startPromises);
      logger.info('✅ All services started successfully');
      
      // Display service status
      this.displayStatus();
      
    } catch (error) {
      logger.error('❌ Failed to start all services:', error);
      await this.gracefulShutdown('startup-error');
      throw error;
    }
  }

  private displayStatus(): void {
    logger.info('\n📊 CardMint Service Status:');
    logger.info('═'.repeat(50));
    
    this.services.forEach(service => {
      const process = this.processes.get(service.name);
      const port = this.portAllocations[service.name];
      const status = process ? '🟢 RUNNING' : '🔴 STOPPED';
      const pid = process?.pid || 'N/A';
      
      logger.info(`${service.name.padEnd(20)} ${status} PID:${pid}${port ? ` PORT:${port}` : ''}`);
    });
    
    logger.info('═'.repeat(50));
  }

  private async gracefulShutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    
    this.shuttingDown = true;
    logger.info(`🛑 Graceful shutdown initiated (${reason})`);

    // Stop all processes
    const shutdownPromises: Promise<void>[] = [];
    
    this.processes.forEach((childProcess, serviceName) => {
      shutdownPromises.push(
        new Promise<void>((resolve) => {
          logger.info(`Stopping ${serviceName}...`);
          
          // Set a timeout for forceful kill
          const timeout = setTimeout(() => {
            logger.warn(`Force killing ${serviceName} (PID: ${childProcess.pid})`);
            childProcess.kill('SIGKILL');
            resolve();
          }, 10000); // 10 second timeout

          childProcess.on('exit', () => {
            clearTimeout(timeout);
            logger.info(`✅ ${serviceName} stopped gracefully`);
            resolve();
          });

          // Send SIGTERM for graceful shutdown
          childProcess.kill('SIGTERM');
        })
      );
    });

    try {
      await Promise.all(shutdownPromises);
      logger.info('✅ All services stopped successfully');
    } catch (error) {
      logger.error('❌ Error during shutdown:', error);
    }

    process.exit(0);
  }

  public getPortAllocations(): PortAllocation {
    return { ...this.portAllocations };
  }

  public getServiceStatus(): Array<{name: string, running: boolean, pid?: number, port?: number}> {
    return this.services.map(service => ({
      name: service.name,
      running: this.processes.has(service.name),
      pid: this.processes.get(service.name)?.pid,
      port: this.portAllocations[service.name]
    }));
  }
}

// Default CardMint service configuration (deterministic - no port allocation)
export const defaultServices: ServiceConfig[] = [
  {
    name: 'api',
    command: 'node',
    args: ['dist/index.js'],
    restartDelay: 5000,
    env: {
      NODE_ENV: 'development'
    }
  },
  {
    name: 'dashboard',
    command: 'npm',
    args: ['run', 'preview'],
    env: {}
  }
];

// Helper to calculate WebSocket port from API port
export function calculateWSPort(apiPort: number): number {
  if (apiPort === 3000) return 3001;
  if (apiPort >= 3100 && apiPort <= 3199) return apiPort + 1;
  return 3001;
}

// CLI execution
if (require.main === module) {
  const manager = new ProcessManager(defaultServices);
  
  manager.start().catch((error) => {
    logger.error('Failed to start CardMint:', error);
    process.exit(1);
  });
}