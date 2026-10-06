/**
 * AIMD concurrency control for the shared Z.ai request budget. Pure: time is passed in (epoch ms).
 * - rate limited: cap = max(min, floor(cap * decreaseFactor)), at most once per cooldownMs (bursts of 429s from many
 *   workers count once); quietSince resets.
 * - tick: when no rate limit for increaseAfterMs since quietSince (or the last increase), cap = min(max, cap + 1).
 */
export interface LimiterConfig {
  readonly min: number;
  readonly max: number;
  readonly decreaseFactor: number;
  readonly cooldownMs: number;
  readonly increaseAfterMs: number;
}

export interface LimiterState {
  readonly cap: number;
  readonly lastDecreaseAt: number | null;
  readonly quietSince: number;
}

export const DEFAULT_LIMITER: LimiterConfig = {
  min: 1,
  max: 8,
  decreaseFactor: 0.5,
  cooldownMs: 60_000,
  increaseAfterMs: 120_000,
};

export function initialLimiter(config: LimiterConfig, now: number): LimiterState {
  return { cap: config.max, lastDecreaseAt: null, quietSince: now };
}

export function onRateLimited(state: LimiterState, config: LimiterConfig, now: number): LimiterState {
  if (state.lastDecreaseAt !== null && now - state.lastDecreaseAt < config.cooldownMs) {
    return { ...state, quietSince: now };
  }
  const cap = Math.max(config.min, Math.floor(state.cap * config.decreaseFactor));
  return { cap, lastDecreaseAt: now, quietSince: now };
}

export function tick(state: LimiterState, config: LimiterConfig, now: number): LimiterState {
  if (state.cap >= config.max || now - state.quietSince < config.increaseAfterMs) return state;
  // The increase restarts the quiet clock, so each further step needs its own full quiet period.
  return { ...state, cap: state.cap + 1, quietSince: now };
}
