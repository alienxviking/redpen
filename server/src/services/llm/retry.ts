/**
 * Retrying a transient upstream failure.
 *
 * Free model tiers return 503 "experiencing high demand" fairly often, and 429 when a
 * quota window is briefly exhausted. Both clear on their own within seconds, so the
 * right response is to wait and try again rather than to degrade the grade - degrading
 * is for failures that persist.
 *
 * Only the retryable statuses are retried. A 400, 401 or 404 is a real problem with the
 * request and repeating it would just waste the user's time.
 */

export const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface RetryOptions {
  attempts?: number;
  /** Base delay; each attempt waits baseDelayMs * 2^n plus a little jitter. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called before each wait, so callers can log or surface progress. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

export class RetryableHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Seconds the server asked us to wait, if it said. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "RetryableHttpError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read `Retry-After`, which may be seconds or an HTTP date. */
export function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds;
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, (when - Date.now()) / 1000);
  return undefined;
}

/**
 * Run `task`, retrying while it throws a RetryableHttpError. Anything else propagates
 * immediately, and the final attempt's error propagates too.
 */
export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const base = options.baseDelayMs ?? 2000;
  const max = options.maxDelayMs ?? 20_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof RetryableHttpError;
      if (!retryable || attempt === attempts) throw error;

      // Honour the server's own guidance when it gives any.
      const suggested = error.retryAfterSeconds;
      const backoff = Math.min(base * 2 ** (attempt - 1), max);
      const delayMs =
        suggested !== undefined
          ? Math.min(suggested * 1000, max)
          : backoff + Math.random() * 400;

      options.onRetry?.({
        attempt,
        delayMs: Math.round(delayMs),
        reason: `${error.status}: ${error.message}`,
      });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
