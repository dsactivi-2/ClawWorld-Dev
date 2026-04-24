/**
 * OpenClaw Teams — Main Entry Point
 *
 * Boots the Express server with full middleware stack, registers all API routes,
 * initialises PostgreSQL + LangGraph, and handles graceful shutdown.
 */

// Sentry MUST be initialised before any other import
import './instrument';

import 'dotenv/config';
import * as Sentry from '@sentry/node';
import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { collectDefaultMetrics, register } from 'prom-client';
import Redis from 'ioredis';

import { createLogger } from './utils/logger';
import { getPool, healthCheck as dbHealthCheck, closePool } from './utils/database';
import { GraphMemoryManager } from './memory/graph-memory';
import { LangGraphOrchestrator } from './orchestrator/langgraph-orchestrator';
import { TeamSpawningSkill } from '../skills/team_spawning';
import { WorkflowOrchestrationSkill } from '../skills/workflow_orchestration';

import { createWorkflowRouter } from './gateway/routes/workflows';
import { createAgentsRouter } from './gateway/routes/agents';
import { createTeamsRouter } from './gateway/routes/teams';

import type { HealthStatus, ComponentHealth } from './types';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createLogger('Server');

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

collectDefaultMetrics({ prefix: 'openclaw_' });

// ---------------------------------------------------------------------------
// Application bootstrap
// ---------------------------------------------------------------------------

async function createApp(): Promise<{
  app: Application;
  orchestrator: LangGraphOrchestrator;
  memoryManager: GraphMemoryManager;
  teamSkill: TeamSpawningSkill;
  workflowSkill: WorkflowOrchestrationSkill;
  redisClient: Redis | null;
}> {
  const app = express();

  // -------------------------------------------------------------------------
  // Security middleware
  // -------------------------------------------------------------------------
  app.use(helmet());
  app.disable('x-powered-by');

  // -------------------------------------------------------------------------
  // CORS
  // -------------------------------------------------------------------------
  const allowedOrigins = (process.env['CORS_ORIGINS'] ?? '').split(',').filter(Boolean);
  app.use(
    cors({
      origin:
        allowedOrigins.length > 0
          ? (origin, cb) => {
              if (!origin || allowedOrigins.includes(origin)) {
                return cb(null, true);
              }
              cb(new Error(`CORS policy does not allow origin: ${origin}`));
            }
          : true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
      credentials: true,
    }),
  );

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------
  app.use(
    rateLimit({
      windowMs: 60_000, // 1 minute window
      max: parseInt(process.env['RATE_LIMIT_MAX'] ?? '100', 10),
      standardHeaders: true, // Return rate limit info in RateLimit-* headers
      legacyHeaders: false,
      message: { error: 'Too many requests — please slow down.' },
    }),
  );

  // -------------------------------------------------------------------------
  // Compression + body parsing
  // -------------------------------------------------------------------------
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // -------------------------------------------------------------------------
  // Request ID middleware
  // -------------------------------------------------------------------------
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.headers['x-request-id'] =
      (req.headers['x-request-id'] as string | undefined) ??
      `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    next();
  });

  // -------------------------------------------------------------------------
  // Database initialisation
  // -------------------------------------------------------------------------
  const pool = getPool();
  const memoryManager = new GraphMemoryManager(pool);
  await memoryManager.initialize();
  log.info('GraphMemoryManager initialised');

  // -------------------------------------------------------------------------
  // Redis (optional — degrade gracefully if unavailable)
  // -------------------------------------------------------------------------
  let redisClient: Redis | null = null;
  const redisUrl = process.env['REDIS_URL'];
  if (redisUrl) {
    try {
      redisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: true,
      });
      await redisClient.connect();
      log.info('Redis connected');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('Redis connection failed — operating without cache', { message: msg });
      redisClient = null;
    }
  }

  // -------------------------------------------------------------------------
  // Orchestrator + skills
  // -------------------------------------------------------------------------
  const orchestrator = new LangGraphOrchestrator();
  // constructor already calls buildGraph() — no need to call initializeGraph() here
  log.info('LangGraphOrchestrator initialised');

  const teamSkill = new TeamSpawningSkill();
  const workflowSkill = new WorkflowOrchestrationSkill();

  // -------------------------------------------------------------------------
  // Health endpoint
  // -------------------------------------------------------------------------
  const startTime = Date.now();

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.get('/health', async (_req: Request, res: Response) => {
    const dbHealth = await dbHealthCheck();
    const redisHealth: ComponentHealth = redisClient
      ? await (async () => {
          try {
            const t = Date.now();
            await redisClient.ping();
            return { status: 'healthy' as const, latencyMs: Date.now() - t };
          } catch (e) {
            return {
              status: 'unhealthy' as const,
              message: e instanceof Error ? e.message : String(e),
            };
          }
        })()
      : { status: 'degraded' as const, message: 'Redis not configured' };

    const allHealthy =
      dbHealth.status === 'healthy' &&
      (redisHealth.status === 'healthy' || redisHealth.status === 'degraded');

    const overallStatus: HealthStatus['status'] = allHealthy
      ? 'healthy'
      : dbHealth.status === 'unhealthy'
        ? 'unhealthy'
        : 'degraded';

    const health: HealthStatus = {
      status: overallStatus,
      checkedAt: new Date().toISOString(),
      components: {
        database: {
          status: dbHealth.status,
          message: dbHealth.message,
          latencyMs: dbHealth.latencyMs,
        },
        redis: redisHealth,
        orchestrator: { status: 'healthy', message: 'LangGraph operational' },
      },
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      version: process.env['npm_package_version'] ?? '1.0.0',
    };

    res.status(overallStatus === 'unhealthy' ? 503 : 200).json(health);
  });

  // -------------------------------------------------------------------------
  // Prometheus metrics endpoint
  // -------------------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.get('/metrics', async (_req: Request, res: Response) => {
    try {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // -------------------------------------------------------------------------
  // API routes
  // -------------------------------------------------------------------------
  app.use('/api/workflows', createWorkflowRouter({ orchestrator, memoryManager }));
  app.use('/api/agents', createAgentsRouter({ teamSkill }));
  app.use('/api/teams', createTeamsRouter({ teamSkill }));

  // -------------------------------------------------------------------------
  // Sentry error handler — must be AFTER all routes, BEFORE other error middleware
  // -------------------------------------------------------------------------
  if (process.env['SENTRY_DSN']) {
    Sentry.setupExpressErrorHandler(app);
  }

  // -------------------------------------------------------------------------
  // 404 handler
  // -------------------------------------------------------------------------
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Route not found' });
  });

  // -------------------------------------------------------------------------
  // Global error handler
  // -------------------------------------------------------------------------
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error('Unhandled error', { message: err.message, stack: err.stack });
    if (process.env['SENTRY_DSN']) {
      Sentry.captureException(err);
    }
    res.status(500).json({ error: 'Internal server error', message: err.message });
  });

  return { app, orchestrator, memoryManager, teamSkill, workflowSkill, redisClient };
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

  const { app, memoryManager, redisClient } = await createApp();

  const server = app.listen(PORT, () => {
    log.info(`OpenClaw Teams started on port ${PORT}`, {
      env: process.env['NODE_ENV'] ?? 'development',
      pid: process.pid,
    });
  });

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/require-await
  async function shutdown(signal: string): Promise<void> {
    log.info(`${signal} received — shutting down gracefully`);

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    server.close(async () => {
      log.info('HTTP server closed');

      try {
        await memoryManager.close();
        log.info('GraphMemoryManager closed');
      } catch (err) {
        log.error('Error closing GraphMemoryManager', {
          message: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        await closePool();
        log.info('Database pool closed');
      } catch (err) {
        log.error('Error closing database pool', {
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if (redisClient) {
        try {
          await redisClient.quit();
          log.info('Redis client disconnected');
        } catch (err) {
          log.error('Error closing Redis client', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      log.info('Shutdown complete');
      process.exit(0);
    });

    // Force exit after 30 seconds if graceful shutdown hangs
    setTimeout(() => {
      log.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 30_000).unref();
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { message: err.message, stack: err.stack });
    void shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    log.error('Unhandled promise rejection', { message });
  });
}

// ---------------------------------------------------------------------------
// Module entry
// ---------------------------------------------------------------------------

start().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Failed to start OpenClaw Teams:', message);
  process.exit(1);
});

export { createApp };
