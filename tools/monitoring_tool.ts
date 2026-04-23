import * as promClient from 'prom-client';
import type { Application, Request, Response } from 'express';

export type MetricSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface MetricLabels {
  [key: string]: string;
}

export interface HealthCheckResult {
  url: string;
  healthy: boolean;
  statusCode?: number;
  responseTimeMs?: number;
  error?: string;
}

export interface PagerDutyAlertResult {
  status: string;
  deduplicationKey: string;
  ok: boolean;
}

export class MonitoringTool {
  // -------------------------------------------------------------------------
  // Built-in metrics
  // -------------------------------------------------------------------------
  private readonly agentCallsTotal: promClient.Counter<string>;
  private readonly agentCallDurationSeconds: promClient.Histogram<string>;
  private readonly agentErrorsTotal: promClient.Counter<string>;
  private readonly tokenUsageTotal: promClient.Counter<string>;
  private readonly costUsageUsd: promClient.Gauge<string>;

  // User-defined gauges and counters registered on first use
  private readonly counters = new Map<string, promClient.Counter<string>>();
  private readonly gauges = new Map<string, promClient.Gauge<string>>();
  private readonly histograms = new Map<string, promClient.Histogram<string>>();

  private readonly registry: promClient.Registry;

  constructor() {
    this.registry = new promClient.Registry();
    promClient.collectDefaultMetrics({ register: this.registry });

    this.agentCallsTotal = new promClient.Counter({
      name: 'agent_calls_total',
      help: 'Total number of agent invocations',
      labelNames: ['agent', 'status'],
      registers: [this.registry],
    });

    this.agentCallDurationSeconds = new promClient.Histogram({
      name: 'agent_call_duration_seconds',
      help: 'Duration of agent calls in seconds',
      labelNames: ['agent'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.registry],
    });

    this.agentErrorsTotal = new promClient.Counter({
      name: 'agent_errors_total',
      help: 'Total number of agent errors',
      labelNames: ['agent', 'error_type'],
      registers: [this.registry],
    });

    this.tokenUsageTotal = new promClient.Counter({
      name: 'token_usage_total',
      help: 'Total number of tokens consumed',
      labelNames: ['model', 'direction'],
      registers: [this.registry],
    });

    this.costUsageUsd = new promClient.Gauge({
      name: 'cost_usage_usd',
      help: 'Cumulative estimated cost in USD',
      labelNames: ['model'],
      registers: [this.registry],
    });
  }

  // -------------------------------------------------------------------------
  // Public API — metrics
  // -------------------------------------------------------------------------

  /**
   * Record a named counter or gauge metric with optional labels.
   * If the metric name matches a built-in metric it is forwarded to the
   * appropriate built-in instrument; otherwise an ad-hoc instrument is
   * created (or reused) on first call.
   */
  recordMetric(name: string, value: number, labels: MetricLabels = {}): void {
    switch (name) {
      case 'agent_calls_total':
        this.agentCallsTotal.inc(labels, value);
        return;
      case 'agent_errors_total':
        this.agentErrorsTotal.inc(labels, value);
        return;
      case 'token_usage_total':
        this.tokenUsageTotal.inc(labels, value);
        return;
      case 'cost_usage_usd':
        this.costUsageUsd.set(labels, value);
        return;
      default:
        break;
    }

    if (value < 0) {
      // Negative increments are semantically a gauge set
      const gauge = this.getOrCreateGauge(name, labels);
      gauge.set(labels, value);
    } else {
      const counter = this.getOrCreateCounter(name, labels);
      counter.inc(labels, value);
    }
  }

  /**
   * Record a duration / distribution sample in a named Histogram.
   */
  recordHistogram(name: string, value: number, labels: MetricLabels = {}): void {
    if (name === 'agent_call_duration_seconds') {
      this.agentCallDurationSeconds.observe(labels, value);
      return;
    }

    const hist = this.getOrCreateHistogram(name, labels);
    hist.observe(labels, value);
  }

  // -------------------------------------------------------------------------
  // Express route helpers
  // -------------------------------------------------------------------------

  /**
   * Register /health and /metrics routes on an Express application.
   */
  createHealthEndpoint(app: Application): void {
    app.get('/health', (_req: Request, res: Response) => {
      res.status(200).json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: process.env['npm_package_version'] ?? 'unknown',
      });
    });

    app.get('/metrics', async (_req: Request, res: Response) => {
      try {
        const metrics = await this.registry.metrics();
        res.set('Content-Type', this.registry.contentType);
        res.status(200).end(metrics);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: `Failed to collect metrics: ${msg}` });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Service health check
  // -------------------------------------------------------------------------

  /**
   * Perform an HTTP GET health check against a service URL.
   */
  async checkServiceHealth(serviceUrl: string): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(serviceUrl, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const responseTimeMs = Date.now() - start;
      const healthy = response.status >= 200 && response.status < 300;

      return {
        url: serviceUrl,
        healthy,
        statusCode: response.status,
        responseTimeMs,
      };
    } catch (error) {
      return {
        url: serviceUrl,
        healthy: false,
        responseTimeMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // -------------------------------------------------------------------------
  // PagerDuty integration
  // -------------------------------------------------------------------------

  /**
   * Send an alert event to PagerDuty via the Events API v2.
   * Requires PAGERDUTY_ROUTING_KEY environment variable.
   */
  async sendPagerDutyAlert(
    severity: MetricSeverity,
    summary: string,
    details: Record<string, unknown> = {}
  ): Promise<PagerDutyAlertResult> {
    const routingKey = process.env['PAGERDUTY_ROUTING_KEY'];
    if (!routingKey) {
      throw new Error('PAGERDUTY_ROUTING_KEY environment variable is required');
    }

    const payload = {
      routing_key: routingKey,
      event_action: 'trigger',
      dedup_key: `openclaw-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      payload: {
        summary,
        severity,
        source: process.env['SERVICE_NAME'] ?? 'openclaw-teams',
        timestamp: new Date().toISOString(),
        custom_details: details,
      },
    };

    const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PagerDuty Events API returned ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      status: string;
      dedup_key: string;
    };

    return {
      status: data.status,
      deduplicationKey: data.dedup_key,
      ok: true,
    };
  }

  // -------------------------------------------------------------------------
  // Convenience: expose the built-in instruments for direct use
  // -------------------------------------------------------------------------

  get instruments() {
    return {
      agentCallsTotal: this.agentCallsTotal,
      agentCallDurationSeconds: this.agentCallDurationSeconds,
      agentErrorsTotal: this.agentErrorsTotal,
      tokenUsageTotal: this.tokenUsageTotal,
      costUsageUsd: this.costUsageUsd,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getOrCreateCounter(
    name: string,
    labels: MetricLabels
  ): promClient.Counter<string> {
    if (!this.counters.has(name)) {
      const counter = new promClient.Counter({
        name,
        help: `Counter for ${name}`,
        labelNames: Object.keys(labels),
        registers: [this.registry],
      });
      this.counters.set(name, counter);
    }
    return this.counters.get(name)!;
  }

  private getOrCreateGauge(
    name: string,
    labels: MetricLabels
  ): promClient.Gauge<string> {
    if (!this.gauges.has(name)) {
      const gauge = new promClient.Gauge({
        name,
        help: `Gauge for ${name}`,
        labelNames: Object.keys(labels),
        registers: [this.registry],
      });
      this.gauges.set(name, gauge);
    }
    return this.gauges.get(name)!;
  }

  private getOrCreateHistogram(
    name: string,
    labels: MetricLabels
  ): promClient.Histogram<string> {
    if (!this.histograms.has(name)) {
      const hist = new promClient.Histogram({
        name,
        help: `Histogram for ${name}`,
        labelNames: Object.keys(labels),
        buckets: promClient.exponentialBuckets(0.05, 2, 10),
        registers: [this.registry],
      });
      this.histograms.set(name, hist);
    }
    return this.histograms.get(name)!;
  }
}
