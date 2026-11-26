/**
 * SloshTracker.ts
 * Computes liquid "slosh" (spill) levels for liquid-carrying dishes.
 *
 * RULES FOR THIS FILE
 * - Pure domain logic. No DOM, no window, no Matter.js, no Canvas.
 * - Imports come from src/types/game.types.ts only.
 *
 * MODEL
 * Each fixed step, PhysicsWorld feeds one SloshSample per liquid dish.
 * From consecutive samples the tracker derives:
 *   acceleration = Δvelocity / Δt            (units / s²)
 *   jerk         = Δacceleration / Δt        (units / s³)
 * Slosh rises with:
 *   - linear jerk above JERK_DEADZONE
 *   - angular velocity above ANGULAR_DEADZONE
 *   - collision impact speed above IMPACT_DEADZONE
 * and drains at settleRatePerSec on steps where none of those contribute.
 * Reaching SLOSH_MAX latches the dish as spilled.
 *
 * UNIT CONTRACT (matches Matter.js native units)
 * - sample.velocity:        world units per fixed step
 * - sample.angularVelocity: radians per fixed step
 * - sample.impactSpeed:     world units per fixed step
 * - sample.dtMs:            milliseconds covered by the sample
 */

import { FIXED_DT_MS, SLOSH_MAX } from '../types/game.types';
import type { EntityId, SloshSample, SloshTunables, Vec2 } from '../types/game.types';

/* ------------------------------------------------------------------ */
/* Tunables & thresholds                                               */
/* ------------------------------------------------------------------ */

/**
 * Default weights.
 * - jerkWeight:      percent gained per (unit/s³) of jerk above the deadzone.
 * - angularWeight:   percent per second gained per (rad/s) above the deadzone.
 * - impactWeight:    percent gained per (unit/step) of impact above the deadzone.
 * - settleRatePerSec: percent drained per second while calm.
 *
 * Rough calibration (before sensitivity multiplier):
 * - A 10 unit/step wall hit contributes ≈ 40% from impact plus ≈ 20% from jerk.
 * - Gentle sliding on bare cloth contributes 0%.
 */
export const DEFAULT_SLOSH_TUNABLES: SloshTunables = {
  jerkWeight: 6e-6,
  angularWeight: 3,
  impactWeight: 5,
  settleRatePerSec: 12,
};

/** Jerk (units/s³) below this is treated as numerical noise. */
export const JERK_DEADZONE = 150_000;

/** Angular speed (rad/s) below this does not slosh liquid. */
export const ANGULAR_DEADZONE = 1.5;

/** Impact speed (units/step) below this is a gentle bump. */
export const IMPACT_DEADZONE = 2;

/** Converts a per-step quantity to a per-second quantity. */
const STEPS_PER_SECOND = 1000 / FIXED_DT_MS;

/* ------------------------------------------------------------------ */
/* Internal per-dish state                                             */
/* ------------------------------------------------------------------ */

interface DishSloshState {
  /** Multiplier from the dish definition (higher spills more easily). */
  readonly sensitivity: number;
  /** Current slosh percent, 0..SLOSH_MAX. */
  level: number;
  /** True once the level has reached SLOSH_MAX. */
  spilled: boolean;
  /** Previous velocity in units/s, or null when history was cleared. */
  prevVelocity: Vec2 | null;
  /** Previous acceleration in units/s², or null until two samples exist. */
  prevAcceleration: Vec2 | null;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFiniteVec(vec: Vec2): boolean {
  return Number.isFinite(vec.x) && Number.isFinite(vec.y);
}

function magnitude(vec: Vec2): number {
  return Math.hypot(vec.x, vec.y);
}

/* ------------------------------------------------------------------ */
/* SloshTracker                                                        */
/* ------------------------------------------------------------------ */

export class SloshTracker {
  private readonly tunables: SloshTunables;
  private readonly states = new Map<EntityId, DishSloshState>();

  /**
   * @param overrides Optional partial overrides of the default tunables.
   */
  constructor(overrides: Partial<SloshTunables> = {}) {
    this.tunables = { ...DEFAULT_SLOSH_TUNABLES, ...overrides };
  }

  /* ---------------------------- Registration ---------------------------- */

  /**
   * Starts tracking a liquid dish. Re-registering an id resets its state.
   * @param dishId      Id of the dish (matches DishDefinition.id).
   * @param sensitivity DishDefinition.sloshSensitivity (must be > 0).
   */
  registerDish(dishId: EntityId, sensitivity: number): void {
    const safeSensitivity = Number.isFinite(sensitivity) && sensitivity > 0 ? sensitivity : 1;
    this.states.set(dishId, {
      sensitivity: safeSensitivity,
      level: 0,
      spilled: false,
      prevVelocity: null,
      prevAcceleration: null,
    });
  }

  /** Stops tracking a dish (for example after it is delivered). */
  unregisterDish(dishId: EntityId): void {
    this.states.delete(dishId);
  }

  /** Returns true when the dish is currently being tracked. */
  isTracking(dishId: EntityId): boolean {
    return this.states.has(dishId);
  }

  /* ------------------------------- Update ------------------------------- */

  /**
   * Feeds one fixed-step sample and returns the dish's updated slosh percent.
   * Samples for unregistered dishes are ignored and return 0.
   * Invalid samples (non-finite values or dtMs <= 0) leave the level unchanged.
   */
  update(sample: SloshSample): number {
    const state = this.states.get(sample.dishId);
    if (state === undefined) {
      return 0;
    }
    if (state.spilled) {
      return SLOSH_MAX;
    }

    const valid =
      sample.dtMs > 0 &&
      Number.isFinite(sample.dtMs) &&
      isFiniteVec(sample.velocity) &&
      Number.isFinite(sample.angularVelocity) &&
      Number.isFinite(sample.impactSpeed);
    if (!valid) {
      return state.level;
    }

    const dtSec = sample.dtMs / 1000;

    // Convert from per-step to per-second units.
    const velocity: Vec2 = {
      x: sample.velocity.x * STEPS_PER_SECOND,
      y: sample.velocity.y * STEPS_PER_SECOND,
    };
    const angularSpeed = Math.abs(sample.angularVelocity) * STEPS_PER_SECOND;

    // Acceleration (needs 2 samples) and jerk (needs 3 samples).
    let acceleration: Vec2 | null = null;
    let jerkMagnitude = 0;

    if (state.prevVelocity !== null) {
      acceleration = {
        x: (velocity.x - state.prevVelocity.x) / dtSec,
        y: (velocity.y - state.prevVelocity.y) / dtSec,
      };
      if (state.prevAcceleration !== null) {
        jerkMagnitude = magnitude({
          x: (acceleration.x - state.prevAcceleration.x) / dtSec,
          y: (acceleration.y - state.prevAcceleration.y) / dtSec,
        });
      }
    }

    state.prevVelocity = velocity;
    state.prevAcceleration = acceleration;

    // Contributions above their deadzones.
    const jerkExcess = Math.max(0, jerkMagnitude - JERK_DEADZONE);
    const angularExcess = Math.max(0, angularSpeed - ANGULAR_DEADZONE);
    const impactExcess = Math.max(0, sample.impactSpeed - IMPACT_DEADZONE);

    const rawGain =
      this.tunables.jerkWeight * jerkExcess +
      this.tunables.angularWeight * angularExcess * dtSec +
      this.tunables.impactWeight * impactExcess;

    if (rawGain > 0) {
      state.level += rawGain * state.sensitivity;
    } else {
      state.level -= this.tunables.settleRatePerSec * dtSec;
    }

    state.level = clamp(state.level, 0, SLOSH_MAX);
    if (state.level >= SLOSH_MAX) {
      state.spilled = true;
    }
    return state.level;
  }

  /* ------------------------------- Queries ------------------------------ */

  /** Current slosh percent for a dish (0 when untracked). */
  getLevel(dishId: EntityId): number {
    return this.states.get(dishId)?.level ?? 0;
  }

  /** True once the dish has reached SLOSH_MAX (latched). */
  hasSpilled(dishId: EntityId): boolean {
    return this.states.get(dishId)?.spilled ?? false;
  }

  /** Ids of all tracked dishes that have spilled. */
  getSpilledDishIds(): readonly EntityId[] {
    const ids: EntityId[] = [];
    for (const [id, state] of this.states) {
      if (state.spilled) {
        ids.push(id);
      }
    }
    return ids;
  }

  /**
   * Snapshot of all tracked levels, shaped for GameState.slosh.
   * A fresh object is returned each call, so it is safe to store.
   */
  getAllLevels(): Readonly<Record<EntityId, number>> {
    const levels: Record<EntityId, number> = {};
    for (const [id, state] of this.states) {
      levels[id] = state.level;
    }
    return levels;
  }

  /* -------------------------------- Reset ------------------------------- */

  /**
   * Clears velocity/acceleration history WITHOUT changing the meter.
   * Call right after a slingshot launch so the launch impulse does not
   * register as jerk. Do not call after a Tablecloth Tug.
   */
  resetMotionHistory(dishId: EntityId): void {
    const state = this.states.get(dishId);
    if (state !== undefined) {
      state.prevVelocity = null;
      state.prevAcceleration = null;
    }
  }

  /** Fully resets one dish: level, spill latch, and motion history. */
  resetDish(dishId: EntityId): void {
    const state = this.states.get(dishId);
    if (state !== undefined) {
      state.level = 0;
      state.spilled = false;
      state.prevVelocity = null;
      state.prevAcceleration = null;
    }
  }

  /** Fully resets every tracked dish (for example on level restart). */
  reset(): void {
    for (const dishId of this.states.keys()) {
      this.resetDish(dishId);
    }
  }

  /** Stops tracking every dish. Call when loading a new level. */
  clear(): void {
    this.states.clear();
  }
}