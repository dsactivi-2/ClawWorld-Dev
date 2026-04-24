/**
 * Unit Tests — TeamSpawningSkill
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
  TeamSpawningSkill,
  TeamSpawningValidationError,
  TeamNotFoundError,
  AgentNotFoundError,
  TeamScalingError,
} from '../../skills/team_spawning';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-agent',
    model: 'claude-sonnet',
    systemPrompt: 'You are a test agent.',
    ...overrides,
  };
}

function makeTeamConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: 'TestTeam',
    role: 'test-role',
    agents: [makeAgentConfig()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamSpawningSkill', () => {
  let skill: TeamSpawningSkill;

  beforeEach(() => {
    skill = new TeamSpawningSkill();
  });

  // -------------------------------------------------------------------------
  describe('spawnTeam', () => {
    it('should create a team with the specified number of agent instances', () => {
      const team = skill.spawnTeam(
        makeTeamConfig({
          agents: [makeAgentConfig({ name: 'a1' }), makeAgentConfig({ name: 'a2' })],
        }),
      );
      expect(team.agents).toHaveLength(2);
    });

    it('should assign unique IDs to each spawned agent', () => {
      const team = skill.spawnTeam(
        makeTeamConfig({
          agents: [makeAgentConfig({ name: 'a1' }), makeAgentConfig({ name: 'a2' })],
        }),
      );
      const ids = team.agents.map((a) => a.agentId);
      expect(new Set(ids).size).toBe(2);
    });

    it('should throw TeamSpawningValidationError when name is empty', () => {
      expect(() => skill.spawnTeam(makeTeamConfig({ name: '' }))).toThrow(
        TeamSpawningValidationError,
      );
    });

    it('should throw TeamSpawningValidationError when role is empty', () => {
      expect(() => skill.spawnTeam(makeTeamConfig({ role: '' }))).toThrow(
        TeamSpawningValidationError,
      );
    });

    it('should throw TeamSpawningValidationError when agents array is empty', () => {
      expect(() => skill.spawnTeam(makeTeamConfig({ agents: [] }))).toThrow(
        TeamSpawningValidationError,
      );
    });

    it('should initialise all agents with idle status and zero resource counters', () => {
      const team = skill.spawnTeam(makeTeamConfig());
      const agent = team.agents[0]!;
      expect(agent.status).toBe('idle');
      expect(agent.resources.tokensUsed).toBe(0);
      expect(agent.resources.estimatedCostUsd).toBe(0);
      expect(agent.resources.tasksCompleted).toBe(0);
      expect(agent.resources.tasksInProgress).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('spawnAgent', () => {
    it('should create a standalone agent with status idle', () => {
      const agent = skill.spawnAgent(makeAgentConfig());
      expect(agent.status).toBe('idle');
    });

    it('should assign teamId "standalone" to the agent', () => {
      const agent = skill.spawnAgent(makeAgentConfig());
      expect(agent.teamId).toBe('standalone');
    });

    it('should throw TeamSpawningValidationError when name is missing', () => {
      expect(() =>
        skill.spawnAgent({ model: 'claude-sonnet', systemPrompt: 'hi' } as never),
      ).toThrow(TeamSpawningValidationError);
    });

    it('should assign a generated agentId and expose resource counters', () => {
      const agent = skill.spawnAgent(makeAgentConfig());
      expect(typeof agent.agentId).toBe('string');
      expect(agent.agentId.length).toBeGreaterThan(0);
      expect(agent.resources).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('despawnAgent', () => {
    it('should remove the agent from its team', () => {
      const team = skill.spawnTeam(makeTeamConfig());
      const agentId = team.agents[0]!.agentId;
      skill.despawnAgent(agentId);
      const updated = skill.getTeamStatus(team.teamId);
      expect(updated.agents.find((a) => a.agentId === agentId)).toBeUndefined();
    });

    it('should delete the agent from the internal registry so a second despawn throws', () => {
      const team = skill.spawnTeam(makeTeamConfig());
      const agentId = team.agents[0]!.agentId;
      skill.despawnAgent(agentId);
      expect(() => skill.despawnAgent(agentId)).toThrow(AgentNotFoundError);
    });

    it('should throw AgentNotFoundError for an unknown agentId', () => {
      expect(() => skill.despawnAgent('non-existent-id')).toThrow(AgentNotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  describe('scaleTeam', () => {
    it('should add agents when targetCount > currentCount', () => {
      const team = skill.spawnTeam(makeTeamConfig());
      const result = skill.scaleTeam(team.teamId, 3);
      expect(result.agents).toHaveLength(3);
    });

    it('should remove idle agents when targetCount < currentCount', () => {
      const team = skill.spawnTeam(
        makeTeamConfig({
          agents: [
            makeAgentConfig({ name: 'a1' }),
            makeAgentConfig({ name: 'a2' }),
            makeAgentConfig({ name: 'a3' }),
          ],
        }),
      );
      const result = skill.scaleTeam(team.teamId, 1);
      expect(result.agents).toHaveLength(1);
    });

    it('should be a no-op when targetCount equals current count', () => {
      const team = skill.spawnTeam(makeTeamConfig());
      const result = skill.scaleTeam(team.teamId, 1);
      expect(result.agents).toHaveLength(1);
    });

    it('should throw TeamScalingError when targetCount is negative', () => {
      const team = skill.spawnTeam(makeTeamConfig());
      expect(() => skill.scaleTeam(team.teamId, -1)).toThrow(TeamScalingError);
    });

    it('should throw TeamNotFoundError for an unknown teamId', () => {
      expect(() => skill.scaleTeam('unknown-team-id', 2)).toThrow(TeamNotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  describe('getTeamStatus', () => {
    it('should return aggregated token totals after recordTokenUsage', () => {
      const team = skill.spawnTeam(makeTeamConfig());
      const agentId = team.agents[0]!.agentId;
      skill.recordTokenUsage(agentId, 500);
      const status = skill.getTeamStatus(team.teamId);
      expect(status.totalTokensUsed).toBe(500);
    });

    it('should throw TeamNotFoundError for an unknown teamId', () => {
      expect(() => skill.getTeamStatus('does-not-exist')).toThrow(TeamNotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  describe('listTeams', () => {
    it('should return an empty array when no teams exist', () => {
      expect(skill.listTeams()).toEqual([]);
    });

    it('should return all active teams', () => {
      skill.spawnTeam(makeTeamConfig({ name: 'Team1' }));
      skill.spawnTeam(makeTeamConfig({ name: 'Team2' }));
      expect(skill.listTeams()).toHaveLength(2);
    });

    it('should not include teams that have been dissolved', () => {
      const team = skill.spawnTeam(makeTeamConfig());
      // Manually set status to dissolved (internal state mutation for test purposes)
      const raw = skill.listTeams().find((t) => t.teamId === team.teamId)!;
      raw.status = 'dissolved';
      expect(skill.listTeams().some((t) => t.teamId === team.teamId)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('assignTaskToTeam', () => {
    it('should create a task with status "running" and assign it to an idle agent', () => {
      const team = skill.spawnTeam(makeTeamConfig());
      const task = skill.assignTaskToTeam(team.teamId, { action: 'build' });
      expect(task.status).toBe('running');
      expect(task.assignedAgentId).not.toBeNull();
    });

    it('should store the arbitrary payload as-is', () => {
      const team = skill.spawnTeam(makeTeamConfig());
      const payload = { foo: 'bar', nested: { x: 1 } };
      const task = skill.assignTaskToTeam(team.teamId, payload);
      expect(task.payload).toEqual(payload);
    });

    it('should throw TeamNotFoundError for an unknown teamId', () => {
      expect(() => skill.assignTaskToTeam('bad-id', {})).toThrow(TeamNotFoundError);
    });

    it('should throw TeamScalingError when no idle agents are available', () => {
      const team = skill.spawnTeam(makeTeamConfig());
      // First task marks the only agent as busy
      skill.assignTaskToTeam(team.teamId, {});
      expect(() => skill.assignTaskToTeam(team.teamId, {})).toThrow(TeamScalingError);
    });
  });

  // -------------------------------------------------------------------------
  describe('completeTask', () => {
    it('should mark the task as "completed" and record the result', () => {
      const team = skill.spawnTeam(makeTeamConfig());
      const task = skill.assignTaskToTeam(team.teamId, {});
      const completed = skill.completeTask(task.taskId, { success: true });
      expect(completed.status).toBe('completed');
      expect(completed.result).toEqual({ success: true });
    });

    it('should set completedAt timestamp', () => {
      const team = skill.spawnTeam(makeTeamConfig());
      const task = skill.assignTaskToTeam(team.teamId, {});
      const completed = skill.completeTask(task.taskId, null);
      expect(completed.completedAt).not.toBeNull();
    });

    it('should restore the agent to idle after the last task finishes', () => {
      const team = skill.spawnTeam(makeTeamConfig());
      const agentId = team.agents[0]!.agentId;
      const task = skill.assignTaskToTeam(team.teamId, {});
      skill.completeTask(task.taskId, 'done');
      const status = skill.getTeamStatus(team.teamId);
      const agent = status.agents.find((a) => a.agentId === agentId)!;
      expect(agent.status).toBe('idle');
    });

    it('should throw a generic Error (not TeamSpawningValidationError) for an unknown taskId', () => {
      expect(() => skill.completeTask('unknown-task-id', null)).toThrow(Error);
      expect(() => skill.completeTask('unknown-task-id', null)).not.toThrow(
        TeamSpawningValidationError,
      );
    });
  });
});
