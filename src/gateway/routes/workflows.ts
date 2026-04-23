/**
 * OpenClaw Teams — /api/workflows Router
 *
 * POST /              — start a new workflow
 * GET  /              — list workflows (paginated)
 * GET  /:id           — get workflow status
 * GET  /:id/graph     — get workflow Mermaid diagram
 * DELETE /:id         — cancel workflow
 */

import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { createLogger } from '../../utils/logger';
import type { LangGraphOrchestrator } from '../../orchestrator/langgraph-orchestrator';
import type { GraphMemoryManager } from '../../memory/graph-memory';

const log = createLogger('WorkflowsRouter');

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const startWorkflowSchema = Joi.object({
  userInput: Joi.string().min(1).max(32_000).required(),
  stateKey: Joi.string().min(1).max(256).optional(),
}).options({ allowUnknown: false });

const listQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
});

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

interface ApiError {
  error: string;
  details?: unknown;
  requestId?: string;
}

function errorBody(message: string, details?: unknown, requestId?: string): ApiError {
  return { error: message, ...(details ? { details } : {}), ...(requestId ? { requestId } : {}) };
}

function requestId(req: Request): string {
  return (req.headers['x-request-id'] as string | undefined) ?? '';
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface WorkflowRouterDeps {
  orchestrator: LangGraphOrchestrator;
  memoryManager: GraphMemoryManager;
}

export function createWorkflowRouter(deps: WorkflowRouterDeps): Router {
  const router = Router();
  const { orchestrator, memoryManager } = deps;

  // -------------------------------------------------------------------------
  // POST / — start workflow
  // -------------------------------------------------------------------------
  router.post('/', async (req: Request, res: Response) => {
    const reqId = requestId(req);

    const { error, value } = startWorkflowSchema.validate(req.body);
    if (error) {
      return res.status(400).json(errorBody('Validation failed', error.details, reqId));
    }

    const { userInput, stateKey } = value as { userInput: string; stateKey?: string };
    const runKey = stateKey ?? randomUUID();

    log.info('Starting workflow', { runKey, inputLength: userInput.length, reqId });

    // Return 202 Accepted immediately — LLM orchestration runs asynchronously
    res.status(202).json({
      id: runKey,
      status: 'accepted',
      message: 'Workflow accepted and queued for execution',
      statusUrl: `/api/workflows/${runKey}`,
      requestId: reqId,
    });

    // Fire-and-forget execution; errors are logged but do not affect the 202 response
    orchestrator
      .execute(userInput, runKey)
      .then((finalState) => memoryManager.saveStateWithHistory(runKey, finalState))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Async workflow execution failed', { runKey, message });
      });

    return;
  });

  // -------------------------------------------------------------------------
  // GET / — list workflows (paginated)
  // -------------------------------------------------------------------------
  router.get('/', async (req: Request, res: Response) => {
    const reqId = requestId(req);

    const { error, value } = listQuerySchema.validate(req.query);
    if (error) {
      return res.status(400).json(errorBody('Invalid query parameters', error.details, reqId));
    }

    const { page, pageSize } = value as { page: number; pageSize: number };

    try {
      const result = await memoryManager.listAllStates(page, pageSize);
      return res.status(200).json({
        items: result.items,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        requestId: reqId,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to list workflows', { message, reqId });
      return res.status(500).json(errorBody('Failed to list workflows', message, reqId));
    }
  });

  // -------------------------------------------------------------------------
  // GET /:id — get workflow status
  // -------------------------------------------------------------------------
  router.get('/:id', async (req: Request, res: Response) => {
    const reqId = requestId(req);
    const { id } = req.params as { id: string };

    // Guard against path traversal
    if (id.includes('..') || id.includes('/') || id.includes('\\')) {
      return res.status(400).json(errorBody('Invalid workflow id', undefined, reqId));
    }

    try {
      // Check in-memory orchestrator first
      const liveStatus = orchestrator.getStatus(id);
      if (liveStatus) {
        return res.status(200).json({ id, ...liveStatus, requestId: reqId });
      }

      // Fall back to persistent store
      const state = await memoryManager.loadState(id);
      if (!state) {
        return res.status(404).json(errorBody('Workflow not found', undefined, reqId));
      }

      return res.status(200).json({
        id,
        currentStep: state.currentStep,
        stepHistory: state.stepHistory,
        deploymentReady: state.deploymentReady,
        errorCount: state.errors.length,
        startTime: state.startTime,
        endTime: state.endTime,
        decisions: state.decisions,
        requestId: reqId,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to get workflow status', { id, message, reqId });
      return res.status(500).json(errorBody('Failed to retrieve workflow', message, reqId));
    }
  });

  // -------------------------------------------------------------------------
  // GET /:id/graph — mermaid diagram
  // -------------------------------------------------------------------------
  router.get('/:id/graph', async (req: Request, res: Response) => {
    const reqId = requestId(req);
    const { id } = req.params as { id: string };

    if (id.includes('..') || id.includes('/') || id.includes('\\')) {
      return res.status(400).json(errorBody('Invalid workflow id', undefined, reqId));
    }

    try {
      const state = await memoryManager.loadState(id);
      if (!state) {
        return res.status(404).json(errorBody('Workflow not found', undefined, reqId));
      }

      const diagram = await memoryManager.exportAsMermaidDiagram(id);
      return res.status(200).json({ id, diagram, requestId: reqId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to generate graph diagram', { id, message, reqId });
      return res.status(500).json(errorBody('Failed to generate diagram', message, reqId));
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /:id — cancel workflow
  // -------------------------------------------------------------------------
  router.delete('/:id', async (req: Request, res: Response) => {
    const reqId = requestId(req);
    const { id } = req.params as { id: string };

    if (id.includes('..') || id.includes('/') || id.includes('\\')) {
      return res.status(400).json(errorBody('Invalid workflow id', undefined, reqId));
    }

    try {
      const state = await memoryManager.loadState(id);
      if (!state) {
        // Also check live state store
        const live = orchestrator.getStatus(id);
        if (!live) {
          return res.status(404).json(errorBody('Workflow not found', undefined, reqId));
        }
      }

      // The orchestrator's internal store does not expose cancellation directly —
      // record the cancellation intent in a persisted state marker.
      const currentState = await memoryManager.loadState(id);
      if (currentState && !currentState.endTime) {
        const cancelledState = {
          ...currentState,
          endTime: new Date().toISOString(),
          errors: [
            ...currentState.errors,
            {
              step: 'cancelled',
              timestamp: new Date().toISOString(),
              message: 'Workflow cancelled by API request',
              retryable: false,
            },
          ],
        };
        await memoryManager.saveStateWithHistory(id, cancelledState);
      }

      log.info('Workflow cancelled', { id, reqId });
      return res.status(200).json({ id, status: 'cancelled', requestId: reqId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to cancel workflow', { id, message, reqId });
      return res.status(500).json(errorBody('Failed to cancel workflow', message, reqId));
    }
  });

  return router;
}
