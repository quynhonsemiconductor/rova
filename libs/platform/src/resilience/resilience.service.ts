import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  BulkheadRejectedError,
  CircuitState,
  ConsecutiveBreaker,
  ExponentialBackoff,
  IPolicy,
  TaskCancelledError,
  TimeoutStrategy,
  bulkhead,
  circuitBreaker,
  handleAll,
  retry,
  timeout,
  wrap,
} from 'cockatiel';
import { Counter, Histogram, metrics } from '@opentelemetry/api';

import { AppConfigService } from '../config/app-config.service';
import { RESILIENCE_DEFAULTS, RESILIENCE_PRESETS } from './resilience.presets';
import {
  PolicyEntry,
  ResilienceOptions,
  ResiliencePattern,
  ResiliencePreset,
  ResilienceStats,
} from './resilience.types';

/**
 * Platform-level resilience wrapper.
 *
 * Wraps any async operation in configurable retry + circuit breaker + timeout +
 * bulkhead policies using the `cockatiel` library. Policies are created lazily
 * per `name` and cached for the process lifetime so circuit state survives
 * across calls.
 *
 * Usage with a preset:
 * ```ts
 * const data = await this.resilience.execute(
 *   'entra.graph.createInvitation',
 *   () => this.postInvitation(request),
 *   ResiliencePreset.EXTERNAL_API,
 * );
 * ```
 *
 * Usage with custom options:
 * ```ts
 * await this.resilience.execute('s3.upload', fn, {
 *   patterns: [ResiliencePattern.TIMEOUT],
 *   timeout: { durationMs: 120_000 },
 * });
 * ```
 */
@Injectable()
export class ResilienceService implements OnModuleDestroy {
  private readonly logger = new Logger(ResilienceService.name);
  private readonly policies = new Map<string, PolicyEntry>();
  private readonly enabled: boolean;

  private readonly successCounter: Counter;
  private readonly failureCounter: Counter;
  private readonly retryCounter: Counter;
  private readonly durationHistogram: Histogram;

  constructor(private readonly config: AppConfigService) {
    this.enabled = config.get('RESILIENCE_ENABLED') === true;

    const meter = metrics.getMeter('rally-resilience', '1.0.0');
    this.successCounter = meter.createCounter('resilience.success', {
      description: 'Successful resilient operations',
    });
    this.failureCounter = meter.createCounter('resilience.failure', {
      description: 'Failed resilient operations after all retry attempts',
    });
    this.retryCounter = meter.createCounter('resilience.retry', {
      description: 'Retry attempts fired',
    });
    this.durationHistogram = meter.createHistogram('resilience.duration_ms', {
      description: 'Resilient operation duration',
      unit: 'ms',
    });
  }

  /**
   * Execute `operation` wrapped in the resolved resilience policy for `name`.
   *
   * @param name    Unique policy name (also used as OTel attribute). Should be a
   *                static string like `'entra.graph.createInvitation'` — NOT constructed
   *                from user input (cardinality).
   * @param operation   Async function to protect.
   * @param optionsOrPreset   `ResiliencePreset` enum value, `ResilienceOptions`
   *                object, or omitted (uses `RESILIENCE_DEFAULTS`).
   */
  async execute<T>(
    name: string,
    operation: () => Promise<T>,
    optionsOrPreset?: ResilienceOptions | ResiliencePreset,
  ): Promise<T> {
    if (!this.enabled) {
      return operation();
    }

    const options = this.resolveOptions(optionsOrPreset);
    const entry = this.getOrCreatePolicy(name, options);
    entry.lastAccessedAt = Date.now();

    const startMs = Date.now();
    try {
      const result = await (entry.policy.execute(operation) as Promise<T>);
      this.successCounter.add(1, { 'operation.name': name });
      this.durationHistogram.record(Date.now() - startMs, { 'operation.name': name });
      return result;
    } catch (error) {
      const err = error as Error;
      this.failureCounter.add(1, {
        'operation.name': name,
        'error.type': err.constructor.name,
      });
      this.durationHistogram.record(Date.now() - startMs, { 'operation.name': name });

      if (err instanceof TaskCancelledError) {
        this.logger.warn(`[${name}] Timeout exceeded`);
      } else if (err instanceof BulkheadRejectedError) {
        this.logger.warn(`[${name}] Bulkhead full — request rejected`);
      } else {
        this.logger.error(`[${name}] Operation failed: ${err.message}`);
      }
      throw error;
    }
  }

  /** Returns live stats for every named policy. Useful for /readyz checks. */
  getStats(): ResilienceStats[] {
    return Array.from(this.policies.entries()).map(([name, entry]) => ({
      name,
      circuitState: this.getCircuitState(entry),
      patterns: entry.options.patterns,
      lastAccessedAt: entry.lastAccessedAt,
    }));
  }

  /** Force-removes a named policy so it is rebuilt fresh on next call. */
  reset(name: string): void {
    this.policies.delete(name);
  }

  onModuleDestroy(): void {
    this.policies.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveOptions(
    optionsOrPreset?: ResilienceOptions | ResiliencePreset,
  ): ResilienceOptions {
    if (!optionsOrPreset) return RESILIENCE_DEFAULTS;
    if (typeof optionsOrPreset === 'string') {
      return RESILIENCE_PRESETS[optionsOrPreset] ?? RESILIENCE_DEFAULTS;
    }
    return optionsOrPreset;
  }

  private getOrCreatePolicy(name: string, options: ResilienceOptions): PolicyEntry {
    const existing = this.policies.get(name);
    if (existing) return existing;

    const policy = this.buildPolicy(name, options);
    const entry: PolicyEntry = { policy, options, lastAccessedAt: Date.now() };
    this.policies.set(name, entry);
    return entry;
  }

  private buildPolicy(name: string, options: ResilienceOptions): PolicyEntry['policy'] {
    const { patterns } = options;
    const policies: IPolicy[] = [];

    // Order matters: outermost → innermost:
    // bulkhead → circuit breaker → retry → timeout → operation

    if (patterns.includes(ResiliencePattern.BULKHEAD) && options.bulkhead) {
      const { maxConcurrent, maxQueue } = options.bulkhead;
      policies.push(bulkhead(maxConcurrent, maxQueue));
    }

    if (patterns.includes(ResiliencePattern.CIRCUIT_BREAKER) && options.circuitBreaker) {
      const { failureThreshold, halfOpenAfterMs } = options.circuitBreaker;
      const cb = circuitBreaker(handleAll, {
        halfOpenAfter: halfOpenAfterMs,
        breaker: new ConsecutiveBreaker(failureThreshold),
      });
      cb.onStateChange((state) => {
        this.logger.warn(`[${name}] Circuit breaker → ${CircuitState[state]}`);
      });
      policies.push(cb);
    }

    if (patterns.includes(ResiliencePattern.RETRY) && options.retry) {
      const { maxAttempts, useJitter } = options.retry;
      const retryPolicy = retry(handleAll, {
        maxAttempts,
        backoff: new ExponentialBackoff({ initialDelay: 100, exponent: 2 }),
      });
      if (useJitter !== false) {
        retryPolicy.onRetry(({ attempt }) => {
          this.retryCounter.add(1, { 'operation.name': name });
          this.logger.debug(`[${name}] Retry attempt ${attempt}`);
        });
      }
      policies.push(retryPolicy);
    }

    if (patterns.includes(ResiliencePattern.TIMEOUT) && options.timeout) {
      const { durationMs } = options.timeout;
      policies.push(timeout(durationMs, TimeoutStrategy.Aggressive));
    }

    if (policies.length === 0) {
      // No patterns configured — return a pass-through policy
      return { execute: (fn) => fn() };
    }

    if (policies.length === 1) {
      return policies[0];
    }

    // `wrap` composes policies: first in array is outermost
    return wrap(...(policies as [IPolicy, IPolicy, ...IPolicy[]]));
  }

  private getCircuitState(entry: PolicyEntry): ResilienceStats['circuitState'] {
    try {
      // cockatiel circuit breaker exposes `state` only at runtime.
      // We inspect the policy object defensively.
      const policy = entry.policy as unknown as {
        state?: number;
      };
      if (policy.state === undefined) return 'unknown';
      return (['closed', 'open', 'half-open'] as const)[policy.state] ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
