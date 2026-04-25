/**
 * Unit Tests — WorkflowOrchestrationSkill
 */

jest.mock('../../src/utils/logger', () => ({
  createLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import {
  WorkflowOrchestrationSkill,
  WorkflowNotFoundError,
  WorkflowValidationError,
  type OrchestratorStep,
  type WorkflowInstance,
} from '../../skills/workflow_orchestration';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let stepIdCounter = 0;

function makeStep(overrides: Partial<OrchestratorStep> = {}): OrchestratorStep {
  const id = overrides.id ?? `step-${++stepIdCounter}`;
  return {
    id,
    label: `Label for ${id}`,
    agentId: 'agent-1',
    handler: async (input) => input,
    retryable: false,
    maxRetries: 0,
    onSuccess: [],
    onFailure: [],
    ...overrides,
  };
}

/** Build a minimal one-step workflow and return both definition and orchestrator */
function setupSingleStep(
  orchestrator: WorkflowOrchestrationSkill,
  handlerOverride?: OrchestratorStep['handler'],
) {
  const step = makeStep({
    id: 'only-step',
    handler: handlerOverride ?? (async (input) => ({ processed: input })),
  });
  const def = orchestrator.createWorkflow('SingleStepFlow', [step], {
    exitPoints: ['only-step'],
  });
  return { step, def };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrationSkill', () => {
  let orchestrator: WorkflowOrchestrationSkill;

  beforeEach(() => {
    orchestrator = new WorkflowOrchestrationSkill();
    stepIdCounter = 0;
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  describe('createWorkflow', () => {
    it('should register a workflow definition and return it with a generated id', () => {
      const step = makeStep({ id: 's1' });
      const def = orchestrator.createWorkflow('MyFlow', [step]);
      expect(def.id).toBeTruthy();
      expect(def.name).toBe('MyFlow');
      expect(def.steps).toHaveLength(1);
    });

    it('should throw WorkflowValidationError when steps array is empty', () => {
      expect(() => orchestrator.createWorkflow('EmptyFlow', [])).toThrow(WorkflowValidationError);
    });

    it('should throw WorkflowValidationError when entryPoint does not match any step id', () => {
      const step = makeStep({ id: 'real-step' });
      expect(() =>
        orchestrator.createWorkflow('BadEntry', [step], { entryPoint: 'no-such-step' }),
      ).toThrow(WorkflowValidationError);
    });

    it('should use the first step id as entryPoint when not specified', () => {
      const step = makeStep({ id: 'first-step' });
      const def = orchestrator.createWorkflow('AutoEntry', [step]);
      expect(def.entryPoint).toBe('first-step');
    });

    it('should emit workflow:created event after successful creation', () => {
      const handler = jest.fn();
      orchestrator.on('workflow:created', handler);
      const step = makeStep({ id: 'ev-step' });
      const def = orchestrator.createWorkflow('EventFlow', [step]);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(def);
    });
  });

  // -------------------------------------------------------------------------
  describe('executeWorkflow', () => {
    it('should execute the step and return a completed instance', async () => {
      const { def } = setupSingleStep(orchestrator);
      const instance = await orchestrator.executeWorkflow(def.id, { x: 1 });
      expect(instance.status).toBe('completed');
      expect(instance.stepHistory).toHaveLength(1);
      expect(instance.stepHistory[0]!.status).toBe('completed');
    });

    it('should throw WorkflowNotFoundError for an unknown workflowId', async () => {
      await expect(orchestrator.executeWorkflow('no-such-id', {})).rejects.toThrow(
        WorkflowNotFoundError,
      );
    });

    it('should retry a failing retryable step up to maxRetries times', async () => {
      let callCount = 0;
      const step = makeStep({
        id: 'retry-step',
        retryable: true,
        maxRetries: 2,
        handler: async () => {
          callCount++;
          if (callCount <= 2) throw new Error('transient');
          return 'ok';
        },
      });
      const def = orchestrator.createWorkflow('RetryFlow', [step], {
        exitPoints: ['retry-step'],
        // Disable backoff sleep delay in tests by using a very tiny timeoutMs > 0
        timeoutMs: 60_000,
      });

      // Patch backoff to 0 for tests — we mock sleep indirectly by using real timers
      // and relying on the fact that backoffMs(1) = 1000ms which will resolve fast enough
      // for this unit test since the step succeeds on attempt 3.
      const instance = await orchestrator.executeWorkflow(def.id, null);
      expect(instance.status).toBe('completed');
      expect(callCount).toBe(3);
    }, 15_000);

    it('should not retry a failing non-retryable step', async () => {
      let callCount = 0;
      const step = makeStep({
        id: 'no-retry-step',
        retryable: false,
        handler: async () => {
          callCount++;
          throw new Error('hard failure');
        },
      });
      const def = orchestrator.createWorkflow('NoRetryFlow', [step], {
        exitPoints: ['no-retry-step'],
      });
      const instance = await orchestrator.executeWorkflow(def.id, null);
      expect(callCount).toBe(1);
      expect(instance.status).toBe('failed');
    });

    it('should mark instance as failed when a retryable step exhausts all retries', async () => {
      const step = makeStep({
        id: 'exhaust-step',
        retryable: true,
        maxRetries: 1,
        handler: async () => {
          throw new Error('always fails');
        },
      });
      const def = orchestrator.createWorkflow('ExhaustFlow', [step], {
        exitPoints: ['exhaust-step'],
        timeoutMs: 60_000,
      });
      const instance = await orchestrator.executeWorkflow(def.id, null);
      expect(instance.status).toBe('failed');
      expect(instance.errors.length).toBeGreaterThan(0);
    }, 15_000);

    it('should timeout a step when step.timeoutMs is exceeded', async () => {
      jest.useFakeTimers();

      const neverResolves = makeStep({
        id: 'slow-step',
        timeoutMs: 100,
        handler: async () => new Promise<never>(() => { /* never resolves */ }),
      });
      const def = orchestrator.createWorkflow('TimeoutFlow', [neverResolves], {
        exitPoints: ['slow-step'],
        timeoutMs: 10_000,
      });

      const executePromise = orchestrator.executeWorkflow(def.id, null);
      // Advance past the step timeout
      await jest.advanceTimersByTimeAsync(200);
      const instance = await executePromise;
      expect(instance.status).toBe('failed');
      expect(
        instance.errors.some((e) => e.message.includes('slow-step') || e.message.includes('timed out')),
      ).toBe(true);
    });

    it('should emit workflow:started and workflow:completed events', async () => {
      const startedHandler = jest.fn();
      const completedHandler = jest.fn();
      orchestrator.on('workflow:started', startedHandler);
      orchestrator.on('workflow:completed', completedHandler);

      const { def } = setupSingleStep(orchestrator);
      await orchestrator.executeWorkflow(def.id, null);

      expect(startedHandler).toHaveBeenCalledTimes(1);
      expect(completedHandler).toHaveBeenCalledTimes(1);
    });

    it('should emit workflow:step:started and workflow:step:completed for each step', async () => {
      const stepStarted = jest.fn();
      const stepCompleted = jest.fn();
      orchestrator.on('workflow:step:started', stepStarted);
      orchestrator.on('workflow:step:completed', stepCompleted);

      const { def } = setupSingleStep(orchestrator);
      await orchestrator.executeWorkflow(def.id, null);

      expect(stepStarted).toHaveBeenCalledTimes(1);
      expect(stepCompleted).toHaveBeenCalledTimes(1);
    });

    it('should cancel in-flight execution when cancelWorkflow is called', async () => {
      jest.useFakeTimers();

      let instanceRef: WorkflowInstance | null = null;

      // A step that runs for a long time
      const longStep = makeStep({
        id: 'long-step',
        handler: async () => new Promise<void>((resolve) => setTimeout(resolve, 50_000)),
      });
      const def = orchestrator.createWorkflow('CancelFlow', [longStep], {
        exitPoints: ['long-step'],
        timeoutMs: 120_000,
      });

      const execPromise = orchestrator.executeWorkflow(def.id, null).then((inst) => {
        instanceRef = inst;
        return inst;
      });

      // Give the event loop a tick so the workflow registers its instance
      await jest.advanceTimersByTimeAsync(10);

      // Find the live instance and cancel it
      const active = orchestrator.listActiveWorkflows();
      expect(active.length).toBeGreaterThan(0);
      const liveInstance = active[0]!;
      orchestrator.cancelWorkflow(liveInstance.instanceId);

      // Advance time so the workflow loop exits
      await jest.advanceTimersByTimeAsync(60_000);
      await execPromise;

      expect(instanceRef).not.toBeNull();
      expect((instanceRef as unknown as WorkflowInstance).status).toBe('cancelled');
    });
  });

  // -------------------------------------------------------------------------
  describe('pauseWorkflow', () => {
    it('should set instance status to paused and save a checkpoint', async () => {
      jest.useFakeTimers();

      const hangingStep = makeStep({
        id: 'hanging-step',
        handler: async () => new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
      });
      const def = orchestrator.createWorkflow('PauseFlow', [hangingStep], {
        exitPoints: ['hanging-step'],
        timeoutMs: 60_000,
      });

      orchestrator.executeWorkflow(def.id, { input: 'data' }).catch(() => {/* swallow */});
      await jest.advanceTimersByTimeAsync(10);

      const active = orchestrator.listActiveWorkflows();
      const inst = active[0]!;
      orchestrator.pauseWorkflow(inst.instanceId);

      const status = orchestrator.getWorkflowStatus(inst.instanceId);
      expect(status.status).toBe('paused');
      expect(status.checkpoint).not.toBeNull();
      expect(status.checkpoint!.stepId).toBe('hanging-step');

      // cleanup
      orchestrator.cancelWorkflow(inst.instanceId);
      await jest.advanceTimersByTimeAsync(60_000);
    });

    it('should be a no-op when called on a non-running (already completed) workflow', async () => {
      const { def } = setupSingleStep(orchestrator);
      const instance = await orchestrator.executeWorkflow(def.id, null);
      // Calling pause on a completed workflow should not throw
      expect(() => orchestrator.pauseWorkflow(instance.instanceId)).not.toThrow();
      expect(orchestrator.getWorkflowStatus(instance.instanceId).status).toBe('completed');
    });

    it('should throw WorkflowNotFoundError for an unknown instanceId', () => {
      expect(() => orchestrator.pauseWorkflow('unknown-instance')).toThrow(WorkflowNotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  describe('resumeWorkflow', () => {
    it('should set a paused workflow back to running status', async () => {
      jest.useFakeTimers();

      let resolveHandler!: () => void;
      const controlledStep = makeStep({
        id: 'ctrl-step',
        handler: async () => new Promise<void>((resolve) => { resolveHandler = resolve; }),
      });
      const def = orchestrator.createWorkflow('ResumeFlow', [controlledStep], {
        exitPoints: ['ctrl-step'],
        timeoutMs: 60_000,
      });

      orchestrator.executeWorkflow(def.id, null).catch(() => {/* swallow */});
      await jest.advanceTimersByTimeAsync(10);

      const inst = orchestrator.listActiveWorkflows()[0]!;
      orchestrator.pauseWorkflow(inst.instanceId);
      expect(orchestrator.getWorkflowStatus(inst.instanceId).status).toBe('paused');

      orchestrator.resumeWorkflow(inst.instanceId);
      expect(orchestrator.getWorkflowStatus(inst.instanceId).status).toBe('running');

      // Resolve handler to avoid open handles
      resolveHandler?.();
      orchestrator.cancelWorkflow(inst.instanceId);
      await jest.advanceTimersByTimeAsync(60_000);
    });

    it('should be a no-op when called on a non-paused workflow', async () => {
      const { def } = setupSingleStep(orchestrator);
      const instance = await orchestrator.executeWorkflow(def.id, null);
      expect(() => orchestrator.resumeWorkflow(instance.instanceId)).not.toThrow();
      expect(orchestrator.getWorkflowStatus(instance.instanceId).status).toBe('completed');
    });

    it('should throw WorkflowNotFoundError for an unknown instanceId', () => {
      expect(() => orchestrator.resumeWorkflow('unknown-instance')).toThrow(WorkflowNotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  describe('getWorkflowStatus', () => {
    it('should return the current status of a known workflow instance', async () => {
      const { def } = setupSingleStep(orchestrator);
      const instance = await orchestrator.executeWorkflow(def.id, { foo: 'bar' });
      const status = orchestrator.getWorkflowStatus(instance.instanceId);
      expect(status.instanceId).toBe(instance.instanceId);
      expect(status.status).toBe('completed');
    });

    it('should throw WorkflowNotFoundError for an unknown instanceId', () => {
      expect(() => orchestrator.getWorkflowStatus('bad-instance-id')).toThrow(
        WorkflowNotFoundError,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('cancelWorkflow', () => {
    it('should immediately set the instance status to "cancelled"', async () => {
      jest.useFakeTimers();

      const neverStep = makeStep({
        id: 'never-step',
        handler: async () => new Promise<never>(() => {/* never resolves */}),
      });
      const def = orchestrator.createWorkflow('CancelInstant', [neverStep], {
        exitPoints: ['never-step'],
        timeoutMs: 120_000,
      });

      orchestrator.executeWorkflow(def.id, null).catch(() => {/* swallow */});
      await jest.advanceTimersByTimeAsync(10);

      const inst = orchestrator.listActiveWorkflows()[0]!;
      orchestrator.cancelWorkflow(inst.instanceId);

      expect(orchestrator.getWorkflowStatus(inst.instanceId).status).toBe('cancelled');
      await jest.advanceTimersByTimeAsync(120_000);
    });

    it('should throw WorkflowNotFoundError for an unknown instanceId', () => {
      expect(() => orchestrator.cancelWorkflow('no-such-instance')).toThrow(WorkflowNotFoundError);
    });

    it('should remove the instance from listActiveWorkflows after cancellation', async () => {
      jest.useFakeTimers();

      const slowStep = makeStep({
        id: 'slow-cancel-step',
        handler: async () => new Promise<never>(() => {/* never */}),
      });
      const def = orchestrator.createWorkflow('CancelListFlow', [slowStep], {
        exitPoints: ['slow-cancel-step'],
        timeoutMs: 120_000,
      });

      orchestrator.executeWorkflow(def.id, null).catch(() => {/* swallow */});
      await jest.advanceTimersByTimeAsync(10);

      const inst = orchestrator.listActiveWorkflows()[0]!;
      orchestrator.cancelWorkflow(inst.instanceId);

      // After cancellation the instance status is 'cancelled' — listActiveWorkflows only returns running/paused
      const active = orchestrator.listActiveWorkflows().filter((i) => i.instanceId === inst.instanceId);
      expect(active).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(120_000);
    });
  });

  // -------------------------------------------------------------------------
  describe('listActiveWorkflows', () => {
    it('should return an empty array when no workflows are running', () => {
      expect(orchestrator.listActiveWorkflows()).toEqual([]);
    });

    it('should include running and paused instances but not completed ones', async () => {
      jest.useFakeTimers();

      // Completed workflow
      const { def: completedDef } = setupSingleStep(orchestrator);
      await orchestrator.executeWorkflow(completedDef.id, null);

      // Long-running workflow (never completes in test)
      const hangStep = makeStep({
        id: 'hang-list-step',
        handler: async () => new Promise<never>(() => {/* hang */}),
      });
      const runningDef = orchestrator.createWorkflow('RunningFlow', [hangStep], {
        exitPoints: ['hang-list-step'],
        timeoutMs: 120_000,
      });
      orchestrator.executeWorkflow(runningDef.id, null).catch(() => {/* swallow */});
      await jest.advanceTimersByTimeAsync(10);

      const active = orchestrator.listActiveWorkflows();
      expect(active.length).toBe(1);
      expect(active[0]!.status).toBe('running');

      // cleanup
      orchestrator.cancelWorkflow(active[0]!.instanceId);
      await jest.advanceTimersByTimeAsync(120_000);
    });
  });
});
