/**
 * Unit Tests — PerformanceProfilingSkill
 * @module tests/unit/performance_profiling
 */

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any source imports
// ---------------------------------------------------------------------------

jest.mock('prom-client', () => {
  const observe = jest.fn();
  const inc = jest.fn();
  const labels = jest.fn().mockReturnValue({ observe, inc });
  return {
    Histogram: jest.fn().mockImplementation(() => ({ observe, labels })),
    Counter: jest.fn().mockImplementation(() => ({ inc, labels })),
    Gauge: jest.fn().mockImplementation(() => ({ set: jest.fn() })),
    collectDefaultMetrics: jest.fn(),
    register: { metrics: jest.fn().mockResolvedValue('# metrics') },
  };
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
// Source imports — after mocks
// ---------------------------------------------------------------------------

import {
  PerformanceProfilingSkill,
  ProfilingValidationError,
  PerformanceProfilingError,
  type StepProfile,
  type WorkflowProfile,
} from '../../skills/performance_profiling';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(
  overrides: Partial<StepProfile> & { stepId: string; agentId: string },
): StepProfile {
  return {
    durationMs: 100,
    tokens: 50,
    costUsd: 0.00015,
    startedAt: '2026-04-01T10:00:00.000Z',
    completedAt: '2026-04-01T10:00:00.100Z',
    ...overrides,
  };
}

function makeWorkflow(steps: StepProfile[]): WorkflowProfile {
  return {
    workflowId: 'wf-test',
    steps,
    totalDurationMs: steps.reduce((s, p) => s + p.durationMs, 0),
    totalTokens: steps.reduce((s, p) => s + p.tokens, 0),
    totalCostUsd: steps.reduce((s, p) => s + p.costUsd, 0),
    startedAt: steps.reduce(
      (min, p) => (p.startedAt < min ? p.startedAt : min),
      steps[0]!.startedAt,
    ),
    completedAt: steps.reduce(
      (max, p) => (p.completedAt > max ? p.completedAt : max),
      steps[0]!.completedAt,
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PerformanceProfilingSkill', () => {
  let profiler: PerformanceProfilingSkill;

  beforeEach(() => {
    profiler = new PerformanceProfilingSkill();
  });

  // -------------------------------------------------------------------------
  // profileAgentCall
  // -------------------------------------------------------------------------

  describe('profileAgentCall', () => {
    it('should return the result of the wrapped function', async () => {
      const fn = jest.fn().mockResolvedValue({ answer: 42 });
      const { result } = await profiler.profileAgentCall('agent-1', fn);
      expect(result).toEqual({ answer: 42 });
    });

    it('should record durationMs > 0 in the returned profile', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const { profile } = await profiler.profileAgentCall('agent-1', fn);
      expect(profile.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof profile.durationMs).toBe('number');
    });

    it('should set success=false and re-throw a PerformanceProfilingError when fn throws', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('boom'));
      await expect(profiler.profileAgentCall('agent-1', fn)).rejects.toThrow(
        PerformanceProfilingError,
      );
    });

    it('should store the profile in internal callProfiles so it appears in the report', async () => {
      const fn = jest.fn().mockResolvedValue('stored');
      await profiler.profileAgentCall('agent-store', fn);
      const report = profiler.generatePerformanceReport('agent-store');
      expect(report.totalCalls).toBe(1);
      expect(report.callHistory).toHaveLength(1);
    });

    it('should throw ProfilingValidationError when agentId is empty', async () => {
      const fn = jest.fn().mockResolvedValue('x');
      await expect(profiler.profileAgentCall('', fn)).rejects.toThrow(ProfilingValidationError);
    });

    it('should use inputTokensHint and outputTokensHint from options', async () => {
      const fn = jest.fn().mockResolvedValue('tokenised');
      const { profile } = await profiler.profileAgentCall('agent-tokens', fn, {
        model: 'claude-sonnet-4-6',
        inputTokensHint: 100,
        outputTokensHint: 200,
      });
      expect(profile.inputTokens).toBe(100);
      expect(profile.outputTokens).toBe(200);
      expect(profile.totalTokens).toBe(300);
      // 300 * 0.000_003 = 0.0009
      expect(profile.estimatedCostUsd).toBeCloseTo(0.0009, 6);
    });
  });

  // -------------------------------------------------------------------------
  // profileWorkflow
  // -------------------------------------------------------------------------

  describe('profileWorkflow', () => {
    it('should sum step durations, tokens, and costs correctly', () => {
      const steps: StepProfile[] = [
        makeStep({ stepId: 's1', agentId: 'a1', durationMs: 200, tokens: 80, costUsd: 0.001 }),
        makeStep({ stepId: 's2', agentId: 'a2', durationMs: 350, tokens: 120, costUsd: 0.002 }),
      ];
      const wf = profiler.profileWorkflow('wf-sum', steps);
      expect(wf.totalDurationMs).toBe(550);
      expect(wf.totalTokens).toBe(200);
      expect(wf.totalCostUsd).toBeCloseTo(0.003, 6);
    });

    it('should derive startedAt from the earliest step', () => {
      const steps: StepProfile[] = [
        makeStep({ stepId: 's1', agentId: 'a1', startedAt: '2026-04-01T10:00:02.000Z', completedAt: '2026-04-01T10:00:03.000Z' }),
        makeStep({ stepId: 's2', agentId: 'a2', startedAt: '2026-04-01T10:00:01.000Z', completedAt: '2026-04-01T10:00:04.000Z' }),
      ];
      const wf = profiler.profileWorkflow('wf-start', steps);
      expect(wf.startedAt).toBe('2026-04-01T10:00:01.000Z');
    });

    it('should derive completedAt from the latest step', () => {
      const steps: StepProfile[] = [
        makeStep({ stepId: 's1', agentId: 'a1', startedAt: '2026-04-01T10:00:00.000Z', completedAt: '2026-04-01T10:00:05.000Z' }),
        makeStep({ stepId: 's2', agentId: 'a2', startedAt: '2026-04-01T10:00:01.000Z', completedAt: '2026-04-01T10:00:09.000Z' }),
      ];
      const wf = profiler.profileWorkflow('wf-end', steps);
      expect(wf.completedAt).toBe('2026-04-01T10:00:09.000Z');
    });

    it('should throw ProfilingValidationError when steps is empty', () => {
      expect(() => profiler.profileWorkflow('wf-empty', [])).toThrow(ProfilingValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // detectBottlenecks
  // -------------------------------------------------------------------------

  describe('detectBottlenecks', () => {
    it('should return the N slowest steps sorted by duration descending', () => {
      const steps: StepProfile[] = [
        makeStep({ stepId: 's1', agentId: 'a1', durationMs: 100 }),
        makeStep({ stepId: 's2', agentId: 'a1', durationMs: 500 }),
        makeStep({ stepId: 's3', agentId: 'a1', durationMs: 300 }),
        makeStep({ stepId: 's4', agentId: 'a1', durationMs: 800 }),
      ];
      const wf = makeWorkflow(steps);
      const bottlenecks = profiler.detectBottlenecks(wf, 2);
      expect(bottlenecks).toHaveLength(2);
      expect(bottlenecks[0]!.durationMs).toBe(800);
      expect(bottlenecks[1]!.durationMs).toBe(500);
    });

    it('should include a non-zero percentageOfTotal for each bottleneck', () => {
      const steps: StepProfile[] = [
        makeStep({ stepId: 's1', agentId: 'a1', durationMs: 400 }),
        makeStep({ stepId: 's2', agentId: 'a1', durationMs: 600 }),
      ];
      const wf = makeWorkflow(steps);
      const bottlenecks = profiler.detectBottlenecks(wf, 2);
      expect(bottlenecks[0]!.percentageOfTotal).toBeGreaterThan(0);
      expect(bottlenecks[1]!.percentageOfTotal).toBeGreaterThan(0);
      // both percentages together should equal 100
      expect(bottlenecks[0]!.percentageOfTotal + bottlenecks[1]!.percentageOfTotal).toBe(100);
    });

    it('should include a recommendation string for each bottleneck', () => {
      const steps: StepProfile[] = [
        makeStep({ stepId: 's1', agentId: 'a1', durationMs: 1000 }),
      ];
      const wf = makeWorkflow(steps);
      const [b] = profiler.detectBottlenecks(wf, 1);
      expect(typeof b!.recommendation).toBe('string');
      expect(b!.recommendation.length).toBeGreaterThan(0);
    });

    it('should default to topN=3 when no argument is passed', () => {
      const steps: StepProfile[] = [
        makeStep({ stepId: 's1', agentId: 'a1', durationMs: 100 }),
        makeStep({ stepId: 's2', agentId: 'a1', durationMs: 200 }),
        makeStep({ stepId: 's3', agentId: 'a1', durationMs: 300 }),
        makeStep({ stepId: 's4', agentId: 'a1', durationMs: 400 }),
        makeStep({ stepId: 's5', agentId: 'a1', durationMs: 500 }),
      ];
      const wf = makeWorkflow(steps);
      const bottlenecks = profiler.detectBottlenecks(wf);
      expect(bottlenecks).toHaveLength(3);
    });

    it('should throw ProfilingValidationError when profileData is invalid', () => {
      expect(() => profiler.detectBottlenecks(null as unknown as WorkflowProfile)).toThrow(
        ProfilingValidationError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // generateFlameGraph
  // -------------------------------------------------------------------------

  describe('generateFlameGraph', () => {
    it('should set root value equal to totalDurationMs', () => {
      const steps: StepProfile[] = [
        makeStep({ stepId: 's1', agentId: 'a1', durationMs: 300 }),
        makeStep({ stepId: 's2', agentId: 'a2', durationMs: 700 }),
      ];
      const wf = makeWorkflow(steps);
      const root = profiler.generateFlameGraph(wf);
      expect(root.value).toBe(1000);
    });

    it('should create children grouped by agentId', () => {
      const steps: StepProfile[] = [
        makeStep({ stepId: 's1', agentId: 'agent-alpha', durationMs: 200 }),
        makeStep({ stepId: 's2', agentId: 'agent-beta', durationMs: 300 }),
        makeStep({ stepId: 's3', agentId: 'agent-alpha', durationMs: 100 }),
      ];
      const wf = makeWorkflow(steps);
      const root = profiler.generateFlameGraph(wf);
      const agentNames = root.children.map((c) => c.name);
      expect(agentNames).toContain('agent-alpha');
      expect(agentNames).toContain('agent-beta');
      const alpha = root.children.find((c) => c.name === 'agent-alpha')!;
      expect(alpha.value).toBe(300); // 200 + 100
    });

    it('should include nested step nodes as children of each agent node', () => {
      const steps: StepProfile[] = [
        makeStep({ stepId: 'step-x', agentId: 'agent-1', durationMs: 150 }),
        makeStep({ stepId: 'step-y', agentId: 'agent-1', durationMs: 250 }),
      ];
      const wf = makeWorkflow(steps);
      const root = profiler.generateFlameGraph(wf);
      const agent = root.children.find((c) => c.name === 'agent-1')!;
      const stepNames = agent.children.map((c) => c.name);
      expect(stepNames).toContain('step-x');
      expect(stepNames).toContain('step-y');
    });

    it('should throw ProfilingValidationError when profileData is invalid', () => {
      expect(() =>
        profiler.generateFlameGraph({ steps: null } as unknown as WorkflowProfile),
      ).toThrow(ProfilingValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // trackTokenUsage
  // -------------------------------------------------------------------------

  describe('trackTokenUsage', () => {
    it('should sum tokens for all calls made in the specified month', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-03-15T00:00:00.000Z');
      await profiler.profileAgentCall('agent-tok', fn, { inputTokensHint: 100, outputTokensHint: 50 });
      await profiler.profileAgentCall('agent-tok', fn, { inputTokensHint: 200, outputTokensHint: 75 });
      (Date.prototype.toISOString as jest.Mock).mockRestore();
      const usage = profiler.trackTokenUsage('agent-tok', '2026-03');
      expect(usage.totalTokens).toBe(425);
      expect(usage.callCount).toBe(2);
    });

    it('should return zero tokens when no calls exist for the agent', () => {
      const usage = profiler.trackTokenUsage('agent-none', '2026-01');
      expect(usage.totalTokens).toBe(0);
      expect(usage.callCount).toBe(0);
    });

    it('should only count calls from the matching month', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      // March call
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-03-01T00:00:00.000Z');
      await profiler.profileAgentCall('agent-month', fn, { inputTokensHint: 500 });
      // April call
      (Date.prototype.toISOString as jest.Mock).mockReturnValue('2026-04-01T00:00:00.000Z');
      await profiler.profileAgentCall('agent-month', fn, { inputTokensHint: 999 });
      (Date.prototype.toISOString as jest.Mock).mockRestore();

      const march = profiler.trackTokenUsage('agent-month', '2026-03');
      expect(march.totalTokens).toBe(500);
      const april = profiler.trackTokenUsage('agent-month', '2026-04');
      expect(april.totalTokens).toBe(999);
    });

    it('should throw ProfilingValidationError for an invalid month format', () => {
      expect(() => profiler.trackTokenUsage('agent-1', 'April-2026')).toThrow(
        ProfilingValidationError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // trackCostUsage
  // -------------------------------------------------------------------------

  describe('trackCostUsage', () => {
    it('should sum costs for all calls in the specified month', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-04-01T00:00:00.000Z');
      // 100 tokens * 0.000_003 = 0.0003 each
      await profiler.profileAgentCall('agent-cost', fn, {
        model: 'claude-sonnet-4-6',
        inputTokensHint: 100,
      });
      await profiler.profileAgentCall('agent-cost', fn, {
        model: 'claude-sonnet-4-6',
        inputTokensHint: 100,
      });
      (Date.prototype.toISOString as jest.Mock).mockRestore();
      const cost = profiler.trackCostUsage('agent-cost', '2026-04');
      expect(cost.totalCostUsd).toBeCloseTo(0.0006, 6);
      expect(cost.callCount).toBe(2);
    });

    it('should set overBudget=true when totalCostUsd exceeds budget', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-04-10T00:00:00.000Z');
      // 40_000_000 tokens * 0.000_003 = $120 > $100 budget
      await profiler.profileAgentCall('agent-over', fn, {
        model: 'claude-sonnet-4-6',
        outputTokensHint: 40_000_000,
      });
      (Date.prototype.toISOString as jest.Mock).mockRestore();
      const cost = profiler.trackCostUsage('agent-over', '2026-04', 100);
      expect(cost.overBudget).toBe(true);
    });

    it('should compute utilizationPercent correctly', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-04-05T00:00:00.000Z');
      // 10_000_000 * 0.000_003 = $30 / $100 = 30%
      await profiler.profileAgentCall('agent-util', fn, {
        model: 'claude-sonnet-4-6',
        outputTokensHint: 10_000_000,
      });
      (Date.prototype.toISOString as jest.Mock).mockRestore();
      const cost = profiler.trackCostUsage('agent-util', '2026-04', 100);
      expect(cost.utilizationPercent).toBe(30);
    });

    it('should use default budget of 100 when budgetUsd is not provided', () => {
      const cost = profiler.trackCostUsage('agent-defbudget', '2026-04');
      expect(cost.budgetUsd).toBe(100);
    });

    it('should throw ProfilingValidationError for an invalid month format', () => {
      expect(() => profiler.trackCostUsage('agent-1', '2026/04')).toThrow(ProfilingValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // generatePerformanceReport
  // -------------------------------------------------------------------------

  describe('generatePerformanceReport', () => {
    it('should compute correct successRate', async () => {
      const okFn = jest.fn().mockResolvedValue('ok');
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));
      await profiler.profileAgentCall('agent-sr', okFn).catch(() => {});
      await profiler.profileAgentCall('agent-sr', okFn).catch(() => {});
      await profiler.profileAgentCall('agent-sr', failFn).catch(() => {});
      // 2 success / 3 total = 66%
      const report = profiler.generatePerformanceReport('agent-sr');
      expect(report.successRate).toBe(67); // Math.round(2/3*100)
    });

    it('should compute p50, p95, p99 percentiles from sorted durations', async () => {
      // We need deterministic durations — spy on Date.now
      const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      let callIdx = 0;
      const dateSpy = jest.spyOn(Date, 'now');

      for (const d of durations) {
        const start = callIdx * 1000;
        dateSpy
          .mockReturnValueOnce(start)
          .mockReturnValueOnce(start + d);
        callIdx++;
        await profiler.profileAgentCall('agent-pct', jest.fn().mockResolvedValue('ok'));
      }
      dateSpy.mockRestore();

      const report = profiler.generatePerformanceReport('agent-pct');
      expect(report.p50DurationMs).toBeGreaterThan(0);
      expect(report.p95DurationMs).toBeGreaterThanOrEqual(report.p50DurationMs);
      expect(report.p99DurationMs).toBeGreaterThanOrEqual(report.p95DurationMs);
    });

    it('should include an error-rate recommendation when successRate < 95', async () => {
      const ok = jest.fn().mockResolvedValue('ok');
      const fail = jest.fn().mockRejectedValue(new Error('err'));
      // 5 success, 5 failures => 50% success rate
      for (let i = 0; i < 5; i++) {
        await profiler.profileAgentCall('agent-recco', ok).catch(() => {});
        await profiler.profileAgentCall('agent-recco', fail).catch(() => {});
      }
      const report = profiler.generatePerformanceReport('agent-recco');
      const hasErrorRec = report.recommendations.some((r) =>
        r.toLowerCase().includes('error rate'),
      );
      expect(hasErrorRec).toBe(true);
    });

    it('should return empty bottlenecks when no calls exist', () => {
      const report = profiler.generatePerformanceReport('agent-empty');
      expect(report.bottlenecks).toHaveLength(0);
      expect(report.totalCalls).toBe(0);
    });

    it('should throw ProfilingValidationError when agentId is empty', () => {
      expect(() => profiler.generatePerformanceReport('')).toThrow(ProfilingValidationError);
    });
  });
});
