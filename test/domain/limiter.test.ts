import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITER,
  initialLimiter,
  type LimiterConfig,
  type LimiterState,
  onRateLimited,
  tick,
} from "../../src/domain/limiter.ts";

const CONFIG: LimiterConfig = {
  min: 1,
  max: 8,
  decreaseFactor: 0.5,
  cooldownMs: 60_000,
  increaseAfterMs: 120_000,
};
const T0 = 1_700_000_000_000;

/** mulberry32: a tiny seeded PRNG so property runs are reproducible from the seed in the failure message. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function intBetween(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

function randomConfig(random: () => number): LimiterConfig {
  const min = intBetween(random, 1, 3);
  return {
    min,
    max: intBetween(random, min, min + 15),
    decreaseFactor: 0.1 + 0.85 * random(),
    // Longer than the one-second burst, as any sane cooldown is.
    cooldownMs: intBetween(random, 1_000, 300_000),
    increaseAfterMs: intBetween(random, 1_000, 600_000),
  };
}

const SEEDS = Array.from({ length: 300 }, (_, index) => 0x5eed + index);

describe("limiter (AIMD)", () => {
  it("initialLimiter starts at max with no decrease and quietSince = now", () => {
    expect(initialLimiter(CONFIG, T0)).toEqual({ cap: 8, lastDecreaseAt: null, quietSince: T0 });
  });
  it("onRateLimited halves the cap (floor) but never below min", () => {
    const at = (cap: number): LimiterState => ({ cap, lastDecreaseAt: null, quietSince: T0 });
    const now = T0 + 5_000;
    const floorTwo: LimiterConfig = { ...CONFIG, min: 2 };

    expect(onRateLimited(at(8), CONFIG, now)).toEqual({ cap: 4, lastDecreaseAt: now, quietSince: now });
    expect(onRateLimited(at(7), CONFIG, now).cap).toBe(3);
    expect(onRateLimited(at(1), CONFIG, now).cap).toBe(1);
    expect(onRateLimited(at(3), floorTwo, now).cap).toBe(2);
    expect(onRateLimited(at(8), { ...CONFIG, decreaseFactor: 0.75 }, now).cap).toBe(6);
  });
  it("the first rate limit always decreases, whatever the clock reads", () => {
    const fresh = initialLimiter(CONFIG, 0);

    expect(onRateLimited(fresh, CONFIG, 0)).toEqual({ cap: 4, lastDecreaseAt: 0, quietSince: 0 });
  });

  it("DEFAULT_LIMITER spans [1, 8], halves at most once a minute and grows after two quiet minutes", () => {
    expect(DEFAULT_LIMITER).toEqual({
      min: 1,
      max: 8,
      decreaseFactor: 0.5,
      cooldownMs: 60_000,
      increaseAfterMs: 120_000,
    });
  });

  it("onRateLimited within cooldownMs of the last decrease does not decrease again, but resets quietSince", () => {
    const decreased: LimiterState = { cap: 4, lastDecreaseAt: T0, quietSince: T0 };
    const justBefore = T0 + CONFIG.cooldownMs - 1;
    const atCooldown = T0 + CONFIG.cooldownMs;

    expect(onRateLimited(decreased, CONFIG, justBefore)).toEqual({ ...decreased, quietSince: justBefore });
    expect(onRateLimited(decreased, CONFIG, atCooldown)).toEqual({
      cap: 2,
      lastDecreaseAt: atCooldown,
      quietSince: atCooldown,
    });
  });
  it("tick increases by one after increaseAfterMs of quiet, then needs another full quiet period", () => {
    const lowered: LimiterState = { cap: 4, lastDecreaseAt: T0, quietSince: T0 };
    const firstAt = T0 + CONFIG.increaseAfterMs;

    const once = tick(lowered, CONFIG, firstAt);
    const tooSoon = tick(once, CONFIG, firstAt + CONFIG.increaseAfterMs - 1);
    const twice = tick(tooSoon, CONFIG, firstAt + CONFIG.increaseAfterMs);

    expect(once).toEqual({ cap: 5, lastDecreaseAt: T0, quietSince: firstAt });
    expect(tooSoon).toBe(once);
    expect(twice).toEqual({ cap: 6, lastDecreaseAt: T0, quietSince: firstAt + CONFIG.increaseAfterMs });
  });
  it("tick never exceeds max and never changes the cap before the quiet period", () => {
    const full = initialLimiter(CONFIG, T0);
    const lowered: LimiterState = { cap: 2, lastDecreaseAt: T0, quietSince: T0 };

    expect(tick(full, CONFIG, T0 + 10 * CONFIG.increaseAfterMs)).toBe(full);
    expect(tick(lowered, CONFIG, T0)).toBe(lowered);
    expect(tick(lowered, CONFIG, T0 + CONFIG.increaseAfterMs - 1)).toBe(lowered);
  });
  it("a burst of 20 rate limits in one second costs exactly one decrease (property over random bursts)", () => {
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const config = randomConfig(random);
      const start = T0 + intBetween(random, 0, 10_000_000);
      const before: LimiterState = {
        cap: intBetween(random, config.min, config.max),
        lastDecreaseAt: random() < 0.5 ? null : start - config.cooldownMs - intBetween(random, 0, 1_000_000),
        quietSince: start - intBetween(random, 0, 1_000_000),
      };
      const burst = Array.from({ length: 20 }, () => start + intBetween(random, 0, 999)).sort(
        (a, b) => a - b,
      );

      const after = burst.reduce((state, now) => onRateLimited(state, config, now), before);

      expect(after, `seed ${seed}`).toEqual({
        cap: Math.max(config.min, Math.floor(before.cap * config.decreaseFactor)),
        lastDecreaseAt: burst[0],
        quietSince: burst[burst.length - 1],
      });
    }
  });

  it("the cap stays within [min, max] under any random interleaving of rate limits and ticks", () => {
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const config = randomConfig(random);
      let now = T0;
      let state = initialLimiter(config, now);
      for (let step = 0; step < 200; step += 1) {
        now += intBetween(random, 0, 2 * config.increaseAfterMs);
        state = random() < 0.3 ? onRateLimited(state, config, now) : tick(state, config, now);
        expect(state.cap, `seed ${seed} step ${step}`).toBeGreaterThanOrEqual(config.min);
        expect(state.cap, `seed ${seed} step ${step}`).toBeLessThanOrEqual(config.max);
        expect(Number.isInteger(state.cap), `seed ${seed} step ${step}`).toBe(true);
      }
    }
  });
  it("recovers from min to max in (max - min) * increaseAfterMs of quiet", () => {
    const floored: LimiterState = { cap: CONFIG.min, lastDecreaseAt: T0, quietSince: T0 };
    const recoveryMs = (CONFIG.max - CONFIG.min) * CONFIG.increaseAfterMs;
    const everySecondUntil = (end: number): LimiterState => {
      let state = floored;
      for (let now = T0; now <= end; now += 1_000) state = tick(state, CONFIG, now);
      return state;
    };

    expect(everySecondUntil(T0 + recoveryMs - 1_000).cap).toBe(CONFIG.max - 1);
    expect(everySecondUntil(T0 + recoveryMs).cap).toBe(CONFIG.max);
  });
});
