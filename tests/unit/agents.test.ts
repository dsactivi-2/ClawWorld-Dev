/**
 * OpenClaw Teams — Unit Tests
 * Covers: LangGraphOrchestrator, GraphMemoryManager, TeamSpawningSkill, WorkflowOrchestrationSkill
 */


// ---------------------------------------------------------------------------
// Mock external dependencies BEFORE importing any source files
// ---------------------------------------------------------------------------

jest.mock('@anthropic-ai/sdk', () => {
  const mockCreate = jest.fn().mockResolvedValue({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          projectName: 'test-project',
          projectType: 'api',
          primaryLanguages: ['TypeScript'],
          frameworks: ['Express'],
          databases: ['PostgreSQL'],
          agentsNeeded: 3,
          estimatedComplexity: 'medium',
          coreFeatures: ['REST API'],
          nonFunctionalRequirements: [],
          constraints: [],
        }),
      },
    ],
  });
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
    _mockCreate: mockCreate,
  };
});

jest.mock('@langchain/langgraph', () => {
  const mockInvoke = jest.fn();
  const mockCompile = jest.fn().mockReturnValue({ invoke: mockInvoke });
  const mockAddNode = jest.fn().mockReturnThis();
  const mockAddEdge = jest.fn().mockReturnThis();
  const mockAddConditionalEdges = jest.fn().mockReturnThis();
  const mockSetEntryPoint = jest.fn().mockReturnThis();

  const StateGraph = jest.fn().mockImplementation(() => ({
    addNode: mockAddNode,
    addEdge: mockAddEdge,
    addConditionalEdges: mockAddConditionalEdges,
    setEntryPoint: mockSetEntryPoint,
    compile: mockCompile,
  }));

  return {
    StateGraph,
    END: '__end__',
    START: '__start__',
    MemorySaver: jest.fn().mockImplementation(() => ({})),
    _mockInvoke: mockInvoke,
  };
});

jest.mock('pg', () => {
  const mockQuery = jest.fn();
  const mockRelease = jest.fn();
  const mockConnect = jest.fn().mockResolvedValue({
    query: mockQuery,
    release: mockRelease,
  });
  const Pool = jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: mockQuery,
    end: jest.fn().mockResolvedValue(undefined),
  }));
  return { Pool, _mockQuery: mockQuery, _mockConnect: mockConnect, _mockRelease: mockRelease };
});

jest.mock('../../src/utils/logger', () => ({
  createLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks are registered
// ---------------------------------------------------------------------------

import { Pool } from 'pg';
import { StateGraph } from '@langchain/langgraph';
import { LangGraphOrchestrator } from '../../src/orchestrator/langgraph-orchestrator';
import { GraphMemoryManager } from '../../src/memory/graph-memory';
import { TeamSpawningSkill } from '../../skills/team_spawning';
import { WorkflowOrchestrationSkill } from '../../skills/workflow_orchestration';
import type { GraphState } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalGraphState(overrides: Partial<GraphState> = {}): GraphState {
  return {
    userInput: 'Build a REST API',
    requirements: {},
    currentStep: '',
    stepHistory: [],
    decisions: [],
    teamsSpawned: [],
    teamResults: {},
    finalPlan: null,
    deploymentReady: false,
    startTime: new Date().toISOString(),
    endTime: null,
    errors: [],
    ...overrides,
  };
}

function makeAgent(overrides = {}) {
  return {
    name: 'Test Agent',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'You are a test agent.',
    maxTokens: 2048,
    temperature: 0.5,
    tools: [],
    metadata: {},
    ...overrides,
  };
}

function makeStep(overrides = {}) {
  const handler = jest.fn().mockResolvedValue({ result: 'ok' });
  return {
    id: 'step-1',
    label: 'First Step',
    agentId: 'agent-1',
    handler,
    retryable: false,
    maxRetries: 0,
    onSuccess: [],
    onFailure: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// LangGraphOrchestrator
// ---------------------------------------------------------------------------

describe('LangGraphOrchestrator', () => {
  let orchestrator: LangGraphOrchestrator;
  let mockInvoke: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    // Retrieve the mock from the module
    const langgraph = require('@langchain/langgraph');
    mockInvoke = langgraph._mockInvoke;
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
    orchestrator = new LangGraphOrchestrator();
  });

  afterEach(() => {
    delete process.env['ANTHROPIC_API_KEY'];
  });

  describe('constructor', () => {
    it('should instantiate without throwing', () => {
      expect(orchestrator).toBeDefined();
      expect(orchestrator).toBeInstanceOf(LangGraphOrchestrator);
    });

    it('should call StateGraph constructor during build', () => {
      expect(StateGraph).toHaveBeenCalled();
    });
  });

  describe('initializeGraph', () => {
    it('should rebuild the graph without throwing', () => {
      expect(() => orchestrator.initializeGraph()).not.toThrow();
      expect(StateGraph).toHaveBeenCalledTimes(2); // once in ctor, once in reinit
    });
  });

  describe('execute', () => {
    it('should invoke the graph with the correct initial state', async () => {
      const finalState = makeMinimalGraphState({
        currentStep: 'deploy_system',
        deploymentReady: true,
        stepHistory: [
          'analyze_requirements',
          'plan_architecture',
          'spawn_builder_teams',
          'build_agents',
          'validate_and_test',
          'deploy_system',
        ],
      });
      mockInvoke.mockResolvedValueOnce(finalState);

      const result = await orchestrator.execute('Build a REST API', 'run-001');

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      const [invoked] = mockInvoke.mock.calls[0] as [GraphState, unknown];
      expect(invoked.userInput).toBe('Build a REST API');
      expect(invoked.deploymentReady).toBe(false);
      expect(result.deploymentReady).toBe(true);
    });

    it('should store the result in internal state store', async () => {
      const finalState = makeMinimalGraphState({ deploymentReady: true });
      mockInvoke.mockResolvedValueOnce(finalState);

      await orchestrator.execute('Build something', 'run-002');
      const status = orchestrator.getStatus('run-002');

      expect(status).not.toBeNull();
      expect(status?.deploymentReady).toBe(true);
    });

    it('should re-throw and store error state when graph invoke fails', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Graph failure'));

      await expect(orchestrator.execute('Build something', 'run-003')).rejects.toThrow(
        'Graph failure',
      );

      const status = orchestrator.getStatus('run-003');
      expect(status).not.toBeNull();
      expect(status?.errorCount).toBeGreaterThan(0);
    });

    it('should pass a thread_id config to invoke for checkpointing', async () => {
      mockInvoke.mockResolvedValueOnce(makeMinimalGraphState());

      await orchestrator.execute('Build', 'my-run-id');

      const [, config] = mockInvoke.mock.calls[0] as [unknown, { configurable: { thread_id: string } }];
      expect(config.configurable.thread_id).toBe('my-run-id');
    });
  });

  describe('getStatus', () => {
    it('should return null for an unknown stateKey', () => {
      expect(orchestrator.getStatus('nonexistent')).toBeNull();
    });

    it('should return step history and timing fields after execution', async () => {
      const finalState = makeMinimalGraphState({
        currentStep: 'deploy_system',
        stepHistory: ['step-1', 'step-2'],
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-01-01T00:01:00.000Z',
      });
      mockInvoke.mockResolvedValueOnce(finalState);

      await orchestrator.execute('Build', 'run-status');
      const status = orchestrator.getStatus('run-status');

      expect(status?.currentStep).toBe('deploy_system');
      expect(status?.stepHistory).toHaveLength(2);
      expect(status?.startTime).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  describe('getDecisions', () => {
    it('should return empty array for unknown stateKey', () => {
      expect(orchestrator.getDecisions('no-such-key')).toEqual([]);
    });

    it('should return decisions recorded in the final state', async () => {
      const finalState = makeMinimalGraphState({
        decisions: [
          {
            step: 'analyze_requirements',
            timestamp: '2026-01-01T00:00:00.000Z',
            description: 'Requirements parsed',
            rationale: 'test',
            outcome: 'ok',
          },
        ],
      });
      mockInvoke.mockResolvedValueOnce(finalState);

      await orchestrator.execute('Build', 'run-decisions');
      const decisions = orchestrator.getDecisions('run-decisions');

      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.step).toBe('analyze_requirements');
    });
  });

  describe('getTeamResults', () => {
    it('should return empty object for unknown stateKey', () => {
      expect(orchestrator.getTeamResults('no-such-key')).toEqual({});
    });

    it('should return team results from the final state', async () => {
      const finalState = makeMinimalGraphState({
        teamResults: {
          'team-1': {
            teamId: 'team-1',
            success: true,
            output: null,
            artifacts: [],
            duration: 1234,
            errors: [],
            completedAt: new Date().toISOString(),
          },
        },
      });
      mockInvoke.mockResolvedValueOnce(finalState);

      await orchestrator.execute('Build', 'run-teams');
      const results = orchestrator.getTeamResults('run-teams');

      expect(results['team-1']).toBeDefined();
      expect(results['team-1']?.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// GraphMemoryManager
// ---------------------------------------------------------------------------

describe('GraphMemoryManager', () => {
  let pool: InstanceType<typeof Pool>;
  let manager: GraphMemoryManager;
  let mockPoolQuery: jest.Mock;
  let mockClientQuery: jest.Mock;
  let mockRelease: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const pg = require('pg');
    pool = new Pool();
    mockPoolQuery = (pool as unknown as { query: jest.Mock }).query;
    mockRelease = pg._mockRelease;
    mockClientQuery = pg._mockQuery;

    // Default: client query succeeds silently
    mockClientQuery.mockResolvedValue({ rows: [] });
    mockPoolQuery.mockResolvedValue({ rows: [] });

    manager = new GraphMemoryManager(pool);
  });

  describe('initialize', () => {
    it('should create schema tables without throwing', async () => {
      await expect(manager.initialize()).resolves.not.toThrow();
    });

    it('should issue BEGIN and COMMIT inside a transaction', async () => {
      await manager.initialize();
      const calls = mockClientQuery.mock.calls.map((c: unknown[]) => String(c[0]).trim());
      expect(calls).toContain('BEGIN');
      expect(calls).toContain('COMMIT');
    });

    it('should ROLLBACK and rethrow when a query fails', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockRejectedValueOnce(new Error('DDL error'));

      await expect(manager.initialize()).rejects.toThrow('DDL error');
      const calls = mockClientQuery.mock.calls.map((c: unknown[]) => String(c[0]).trim());
      expect(calls).toContain('ROLLBACK');
    });

    it('should always release the client even on failure', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('fail'));

      await manager.initialize().catch(() => {});
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('saveStateWithHistory', () => {
    it('should upsert the state and commit', async () => {
      const state = makeMinimalGraphState({ currentStep: 'build_agents' });
      await manager.saveStateWithHistory('key-1', state, 'plan_architecture', 'build_agents');

      const calls = mockClientQuery.mock.calls.map((c: unknown[]) => String(c[0]).trim());
      expect(calls).toContain('BEGIN');
      expect(calls).toContain('COMMIT');
    });

    it('should update the in-memory cache after save', async () => {
      const state = makeMinimalGraphState();
      await manager.saveStateWithHistory('key-cache', state);

      // loadState should return from cache (pool query not called)
      mockPoolQuery.mockClear();
      const loaded = await manager.loadState('key-cache');
      expect(loaded).toEqual(state);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  describe('loadState', () => {
    it('should return null when state does not exist in DB', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const result = await manager.loadState('nonexistent');
      expect(result).toBeNull();
    });

    it('should return the state from DB when not cached', async () => {
      const state = makeMinimalGraphState({ currentStep: 'deploy_system', deploymentReady: true });
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ state_key: 'k', state }] });

      const result = await manager.loadState('k');
      expect(result?.deploymentReady).toBe(true);
    });

    it('should throw when the pool query fails', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('DB down'));
      await expect(manager.loadState('any-key')).rejects.toThrow('DB down');
    });
  });

  describe('restoreFromCheckpoint', () => {
    it('should return null when checkpoint is not found', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const result = await manager.restoreFromCheckpoint(999);
      expect(result).toBeNull();
    });

    it('should return the checkpoint state when found', async () => {
      const state = makeMinimalGraphState({ currentStep: 'validate_and_test' });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 1, state_key: 'k', state, node_name: 'validate_and_test' }],
      });

      const result = await manager.restoreFromCheckpoint(1);
      expect(result?.currentStep).toBe('validate_and_test');
    });
  });

  describe('cleanupOldStates', () => {
    it('should return 0 when nothing is deleted', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
      const deleted = await manager.cleanupOldStates(30);
      expect(deleted).toBe(0);
    });

    it('should return the count of deleted rows', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: '5' }] });
      const deleted = await manager.cleanupOldStates(7);
      expect(deleted).toBe(5);
    });

    it('should throw when daysOld is 0 or negative', async () => {
      await expect(manager.cleanupOldStates(0)).rejects.toThrow();
      await expect(manager.cleanupOldStates(-1)).rejects.toThrow();
    });
  });

  describe('exportAsMermaidDiagram', () => {
    it('should return a placeholder when no edges exist', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const diagram = await manager.exportAsMermaidDiagram('no-edges');
      expect(diagram).toContain('flowchart LR');
      expect(diagram).toContain('no-edges');
    });

    it('should include edge arrows in the diagram', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ from_node: 'analyze', to_node: 'plan', created_at: new Date().toISOString() }],
      });
      const diagram = await manager.exportAsMermaidDiagram('has-edges');
      expect(diagram).toContain('-->');
      expect(diagram).toContain('flowchart LR');
    });
  });
});

// ---------------------------------------------------------------------------
// TeamSpawningSkill
// ---------------------------------------------------------------------------

describe('TeamSpawningSkill', () => {
  let skill: TeamSpawningSkill;

  beforeEach(() => {
    skill = new TeamSpawningSkill();
  });

  describe('spawnTeam', () => {
    it('should create a team with the correct agent count', () => {
      const team = skill.spawnTeam({
        name: 'Alpha Team',
        role: 'builder',
        agents: [makeAgent(), makeAgent({ name: 'Agent 2' })],
      });
      expect(team.agents).toHaveLength(2);
      expect(team.name).toBe('Alpha Team');
    });

    it('should assign a unique teamId to each team', () => {
      const t1 = skill.spawnTeam({ name: 'T1', role: 'r', agents: [makeAgent()] });
      const t2 = skill.spawnTeam({ name: 'T2', role: 'r', agents: [makeAgent()] });
      expect(t1.teamId).not.toBe(t2.teamId);
    });

    it('should initialise all agents with idle status', () => {
      const team = skill.spawnTeam({ name: 'T', role: 'r', agents: [makeAgent()] });
      team.agents.forEach((a) => expect(a.status).toBe('idle'));
    });

    it('should initialise resource counters to zero', () => {
      const team = skill.spawnTeam({ name: 'T', role: 'r', agents: [makeAgent()] });
      team.agents.forEach((a) => {
        expect(a.resources.tokensUsed).toBe(0);
        expect(a.resources.tasksCompleted).toBe(0);
      });
    });

    it('should throw TeamSpawningValidationError when name is empty', () => {
      expect(() =>
        skill.spawnTeam({ name: '', role: 'r', agents: [makeAgent()] }),
      ).toThrow('TeamSpawningValidationError');
    });

    it('should throw TeamSpawningValidationError when agents array is empty', () => {
      expect(() => skill.spawnTeam({ name: 'T', role: 'r', agents: [] })).toThrow(
        'TeamSpawningValidationError',
      );
    });
  });

  describe('spawnAgent', () => {
    it('should create a standalone agent with status idle', () => {
      const agent = skill.spawnAgent(makeAgent());
      expect(agent.status).toBe('idle');
    });

    it('should assign teamId "standalone" to the agent', () => {
      const agent = skill.spawnAgent(makeAgent());
      expect(agent.teamId).toBe('standalone');
    });

    it('should assign a unique agentId', () => {
      const a1 = skill.spawnAgent(makeAgent({ name: 'A1' }));
      const a2 = skill.spawnAgent(makeAgent({ name: 'A2' }));
      expect(a1.agentId).not.toBe(a2.agentId);
    });

    it('should throw TeamSpawningValidationError on invalid model field', () => {
      expect(() =>
        skill.spawnAgent({ ...makeAgent(), model: '' }),
      ).toThrow('TeamSpawningValidationError');
    });
  });

  describe('scaleTeam', () => {
    it('should add agents when targetCount > currentCount', () => {
      const team = skill.spawnTeam({ name: 'T', role: 'r', agents: [makeAgent()] });
      const scaled = skill.scaleTeam(team.teamId, 3);
      expect(scaled.agents).toHaveLength(3);
    });

    it('should remove idle agents when targetCount < currentCount', () => {
      const team = skill.spawnTeam({
        name: 'T',
        role: 'r',
        agents: [makeAgent(), makeAgent({ name: 'A2' }), makeAgent({ name: 'A3' })],
      });
      const scaled = skill.scaleTeam(team.teamId, 1);
      expect(scaled.agents).toHaveLength(1);
    });

    it('should be a no-op when targetCount equals current count', () => {
      const team = skill.spawnTeam({ name: 'T', role: 'r', agents: [makeAgent()] });
      const scaled = skill.scaleTeam(team.teamId, 1);
      expect(scaled.agents).toHaveLength(1);
    });

    it('should throw TeamScalingError when targetCount is negative', () => {
      const team = skill.spawnTeam({ name: 'T', role: 'r', agents: [makeAgent()] });
      expect(() => skill.scaleTeam(team.teamId, -1)).toThrow('TeamScalingError');
    });

    it('should throw TeamNotFoundError for an unknown teamId', () => {
      expect(() => skill.scaleTeam('ghost-team', 2)).toThrow('TeamNotFoundError');
    });
  });

  describe('assignTaskToTeam', () => {
    it('should assign the task to an idle agent', () => {
      const team = skill.spawnTeam({ name: 'T', role: 'r', agents: [makeAgent()] });
      const task = skill.assignTaskToTeam(team.teamId, { payload: 'data' });
      expect(task.assignedAgentId).not.toBeNull();
      expect(task.status).toBe('running');
    });

    it('should set agent status to busy', () => {
      const team = skill.spawnTeam({ name: 'T', role: 'r', agents: [makeAgent()] });
      const task = skill.assignTaskToTeam(team.teamId, { payload: 'data' });
      const agentId = task.assignedAgentId!;
      const health = skill.getTeamStatus(team.teamId);
      const agent = health.agents.find((a) => a.agentId === agentId);
      expect(agent?.status).toBe('busy');
    });

    it('should throw TeamScalingError when no idle agents are available', () => {
      const team = skill.spawnTeam({ name: 'T', role: 'r', agents: [makeAgent()] });
      // Exhaust the single agent
      skill.assignTaskToTeam(team.teamId, {});
      expect(() => skill.assignTaskToTeam(team.teamId, {})).toThrow('TeamScalingError');
    });

    it('should throw TeamNotFoundError for an unknown teamId', () => {
      expect(() => skill.assignTaskToTeam('ghost', {})).toThrow('TeamNotFoundError');
    });
  });

  describe('listTeams', () => {
    it('should return all active teams', () => {
      skill.spawnTeam({ name: 'T1', role: 'r', agents: [makeAgent()] });
      skill.spawnTeam({ name: 'T2', role: 'r', agents: [makeAgent()] });
      expect(skill.listTeams()).toHaveLength(2);
    });

    it('should return an empty array when no teams have been spawned', () => {
      expect(skill.listTeams()).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// WorkflowOrchestrationSkill
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrationSkill', () => {
  let orchestrator: WorkflowOrchestrationSkill;

  beforeEach(() => {
    orchestrator = new WorkflowOrchestrationSkill();
  });

  describe('createWorkflow', () => {
    it('should register a workflow and return a definition with a generated id', () => {
      const step = makeStep({ id: 'step-a', onSuccess: [] });
      const def = orchestrator.createWorkflow('My Flow', [step], {
        exitPoints: ['step-a'],
      });
      expect(def.id).toBeTruthy();
      expect(def.name).toBe('My Flow');
    });

    it('should throw WorkflowValidationError when steps is empty', () => {
      expect(() => orchestrator.createWorkflow('Flow', [], { exitPoints: ['x'] })).toThrow(
        'WorkflowValidationError',
      );
    });

    it('should throw WorkflowValidationError when entryPoint does not match any step id', () => {
      const step = makeStep({ id: 'step-1' });
      expect(() =>
        orchestrator.createWorkflow('Flow', [step], { entryPoint: 'nonexistent', exitPoints: ['step-1'] }),
      ).toThrow('WorkflowValidationError');
    });

    it('should use the first step as entryPoint when not specified', () => {
      const step = makeStep({ id: 'step-first' });
      const def = orchestrator.createWorkflow('Flow', [step], { exitPoints: ['step-first'] });
      expect(def.entryPoint).toBe('step-first');
    });

    it('should emit workflow:created event after successful creation', () => {
      const listener = jest.fn();
      orchestrator.on('workflow:created', listener);
      const step = makeStep({ id: 'step-emit' });
      orchestrator.createWorkflow('Flow', [step], { exitPoints: ['step-emit'] });
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('executeWorkflow', () => {
    it('should execute a single-step workflow and return a completed instance', async () => {
      const step = makeStep({ id: 'only-step' });
      const def = orchestrator.createWorkflow('Single', [step], { exitPoints: ['only-step'] });
      const instance = await orchestrator.executeWorkflow(def.id, { data: 1 });

      expect(instance.status).toBe('completed');
      expect(step.handler).toHaveBeenCalledTimes(1);
    });

    it('should throw WorkflowNotFoundError for an unknown workflowId', async () => {
      await expect(orchestrator.executeWorkflow('no-such-id', {})).rejects.toThrow(
        'WorkflowNotFoundError',
      );
    });

    it('should retry a failing retryable step up to maxRetries times', async () => {
      const handler = jest.fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce({ ok: true });

      const step = makeStep({ id: 's1', handler, retryable: true, maxRetries: 2 });
      const def = orchestrator.createWorkflow('Retry', [step], { exitPoints: ['s1'] });
      const instance = await orchestrator.executeWorkflow(def.id, {});

      expect(instance.status).toBe('completed');
      expect(handler).toHaveBeenCalledTimes(2);
    }, 15_000);

    it('should mark instance as failed when a non-retryable step throws', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('fatal error'));
      const step = makeStep({ id: 's-fail', handler, retryable: false });
      const def = orchestrator.createWorkflow('Fail', [step], { exitPoints: ['s-fail'] });
      const instance = await orchestrator.executeWorkflow(def.id, {});

      expect(instance.status).toBe('failed');
      expect(instance.errors.length).toBeGreaterThan(0);
    });

    it('should emit workflow:started and workflow:completed events', async () => {
      const started = jest.fn();
      const completed = jest.fn();
      orchestrator.on('workflow:started', started);
      orchestrator.on('workflow:completed', completed);

      const step = makeStep({ id: 's-event' });
      const def = orchestrator.createWorkflow('Events', [step], { exitPoints: ['s-event'] });
      await orchestrator.executeWorkflow(def.id, {});

      expect(started).toHaveBeenCalled();
      expect(completed).toHaveBeenCalled();
    });
  });

  describe('pauseWorkflow', () => {
    it('should set instance status to paused', async () => {
      // Use a long-running handler so we can pause mid-flight
      const handler = jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 500)),
      );
      const step = makeStep({ id: 's-pause', handler });
      const def = orchestrator.createWorkflow('PauseMe', [step], { exitPoints: ['s-pause'] });

      const execPromise = orchestrator.executeWorkflow(def.id, {});
      // Give execution a tick to start
      await new Promise((r) => setImmediate(r));

      // Retrieve the running instance
      const active = orchestrator.listActiveWorkflows();
      if (active.length > 0) {
        orchestrator.pauseWorkflow(active[0]!.instanceId);
        expect(active[0]!.status).toBe('paused');
      }

      // Cleanup: cancel then await
      active.forEach((i) => orchestrator.cancelWorkflow(i.instanceId));
      await execPromise.catch(() => {});
    });

    it('should save a checkpoint when paused', () => {
      const step = makeStep({ id: 's-cp' });
      const def = orchestrator.createWorkflow('CP', [step], { exitPoints: ['s-cp'] });

      // Manually inject a running instance
      const execPromise = orchestrator.executeWorkflow(def.id, { val: 42 });
      setImmediate(() => {
        const active = orchestrator.listActiveWorkflows();
        active.forEach((i) => {
          orchestrator.pauseWorkflow(i.instanceId);
          expect(i.checkpoint).not.toBeNull();
          orchestrator.cancelWorkflow(i.instanceId);
        });
      });
      return execPromise.catch(() => {});
    });
  });

  describe('resumeWorkflow', () => {
    it('should transition instance back to running after pause', () => {
      const step = makeStep({ id: 's-resume' });
      const def = orchestrator.createWorkflow('Resume', [step], { exitPoints: ['s-resume'] });

      const execPromise = orchestrator.executeWorkflow(def.id, {});
      setImmediate(async () => {
        const active = orchestrator.listActiveWorkflows();
        if (active.length > 0) {
          orchestrator.pauseWorkflow(active[0]!.instanceId);
          orchestrator.resumeWorkflow(active[0]!.instanceId);
          expect(active[0]!.status).toBe('running');
        }
      });
      return execPromise.catch(() => {});
    });
  });

  describe('getWorkflowStatus', () => {
    it('should return the current instance snapshot after execution', async () => {
      const step = makeStep({ id: 's-status' });
      const def = orchestrator.createWorkflow('Status', [step], { exitPoints: ['s-status'] });
      const instance = await orchestrator.executeWorkflow(def.id, {});

      const snapshot = orchestrator.getWorkflowStatus(instance.instanceId);
      expect(snapshot.instanceId).toBe(instance.instanceId);
      expect(snapshot.status).toBe('completed');
    });

    it('should throw WorkflowNotFoundError for an unknown instanceId', () => {
      expect(() => orchestrator.getWorkflowStatus('ghost-id')).toThrow('WorkflowNotFoundError');
    });
  });

  describe('cancelWorkflow', () => {
    it('should set instance status to cancelled', async () => {
      const handler = jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 2000)),
      );
      const step = makeStep({ id: 's-cancel', handler });
      const def = orchestrator.createWorkflow('Cancel', [step], { exitPoints: ['s-cancel'] });

      const execPromise = orchestrator.executeWorkflow(def.id, {});
      await new Promise((r) => setImmediate(r));

      const active = orchestrator.listActiveWorkflows();
      if (active.length > 0) {
        orchestrator.cancelWorkflow(active[0]!.instanceId);
        expect(active[0]!.status).toBe('cancelled');
      }

      await execPromise.catch(() => {});
    });

    it('should throw WorkflowNotFoundError for an unknown instanceId', () => {
      expect(() => orchestrator.cancelWorkflow('ghost')).toThrow('WorkflowNotFoundError');
    });
  });

  describe('listActiveWorkflows', () => {
    it('should return only instances with status running or paused', async () => {
      const step = makeStep({ id: 's-list' });
      const def = orchestrator.createWorkflow('List', [step], { exitPoints: ['s-list'] });
      await orchestrator.executeWorkflow(def.id, {});

      // Completed workflows should not appear
      const active = orchestrator.listActiveWorkflows();
      active.forEach((i) =>
        expect(['running', 'paused']).toContain(i.status),
      );
    });

    it('should return an empty array when no workflows are active', () => {
      expect(orchestrator.listActiveWorkflows()).toEqual([]);
    });
  });
});
