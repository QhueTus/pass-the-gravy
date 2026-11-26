/**
 * PhysicsWorld.ts
 * Matter.js wrapper for "Pass the Gravy: Tablecloth Tactics".
 *
 * RULES FOR THIS FILE
 * - No DOM, no window, no document, no Canvas.
 * - Matter.js is imported here and nowhere else in src/game/.
 * - Everything crossing the boundary is a plain type from game.types.ts.
 *
 * COORDINATES
 * Every `position` in level data is the CENTER of its shape (this matches
 * Matter.js). The renderer must draw rectangles centered on `position`.
 *
 * STEP ORDER (inside step())
 *  1. Move kinematic hazards along their sine paths (sets their velocity).
 *  2. Snapshot pre-step velocities (used for collision impact speed).
 *  3. Engine.update at the fixed timestep.
 *  4. Apply surface-zone friction effects to dishes.
 *  5. Detect dishes that left the table.
 *  6. Queue target-overlap events.
 *  7. Build one SloshSample per liquid dish.
 *  8. Flush queued events to listeners.
 */

import Matter from 'matter-js';

import { FIXED_DT_MS } from '../types/game.types';
import type {
  BodySnapshot,
  DishDefinition,
  EntityId,
  HazardDefinition,
  LevelDefinition,
  PhysicsEvent,
  PhysicsEventListener,
  Shape,
  SlingshotDefinition,
  SloshSample,
  SurfaceZoneDefinition,
  SurfaceZoneEffect,
  SurfaceZoneKind,
  TargetDefinition,
  TugParameters,
  Vec2,
} from '../types/game.types';

const { Engine, Bodies, Body, Composite, Events } = Matter;

/* ------------------------------------------------------------------ */
/* Exported tunables and pure helpers                                  */
/* ------------------------------------------------------------------ */

/**
 * Physical effect of each surface zone while a dish overlaps it.
 * - cranberry-spill: near-zero air friction and low contact friction (ice).
 * - mashed-potato:   heavy air friction and higher contact friction (trap).
 * Matter applies frictionAir as a per-step velocity loss fraction.
 */
export const SURFACE_ZONE_EFFECTS: Readonly<Record<SurfaceZoneKind, SurfaceZoneEffect>> = {
  'cranberry-spill': { frictionAir: 0.0008, frictionMultiplier: 0.2 },
  'mashed-potato': { frictionAir: 0.15, frictionMultiplier: 2 },
};

/**
 * Default Tablecloth Tug.
 * - lateralImpulse: velocity change = impulse / mass (units per step).
 * - torque: angular velocity change = torque / inertia (radians per step).
 * - direction +1 pulls toward the relatives on the right.
 */
export const DEFAULT_TUG_PARAMETERS: TugParameters = {
  lateralImpulse: 8,
  torque: 12,
  direction: 1,
};

/** Preview and rest thresholds (units per step). */
const MIN_PREVIEW_SPEED = 0.05;
export const DEFAULT_LINEAR_REST_SPEED = 0.05;
export const DEFAULT_ANGULAR_REST_SPEED = 0.01;

const ZERO: Vec2 = { x: 0, y: 0 };

function magnitude(vec: Vec2): number {
  return Math.hypot(vec.x, vec.y);
}

/** Limits a drag vector's length to `maxDrag`. Non-finite input yields zero. */
export function clampDrag(drag: Vec2, maxDrag: number): Vec2 {
  const length = magnitude(drag);
  if (!Number.isFinite(length) || length === 0) {
    return ZERO;
  }
  if (length <= maxDrag) {
    return drag;
  }
  const scale = maxDrag / length;
  return { x: drag.x * scale, y: drag.y * scale };
}

/**
 * Launch velocity (units per step) for a drag vector. The dish travels
 * opposite to the drag, like a slingshot.
 */
export function computeLaunchVelocity(drag: Vec2, slingshot: SlingshotDefinition): Vec2 {
  const clamped = clampDrag(drag, slingshot.maxDrag);
  return {
    x: -clamped.x * slingshot.powerScale,
    y: -clamped.y * slingshot.powerScale,
  };
}

/* ------------------------------------------------------------------ */
/* Internal records                                                    */
/* ------------------------------------------------------------------ */

interface DishRecord {
  readonly def: DishDefinition;
  readonly body: Matter.Body;
  fellOff: boolean;
}

interface HazardRecord {
  readonly def: HazardDefinition;
  readonly body: Matter.Body;
  /** Normalized motion axis (zero vector when the axis was zero). */
  readonly axis: Vec2;
  /** Velocity applied this step, in units per step. */
  velocity: Vec2;
}

interface ObstacleRecord {
  readonly id: EntityId;
  readonly body: Matter.Body;
  readonly shape: Shape;
}

interface ZoneRecord {
  readonly def: SurfaceZoneDefinition;
  readonly body: Matter.Body;
}

interface TargetRecord {
  readonly def: TargetDefinition;
  readonly body: Matter.Body;
}

type BodyRole = 'dish' | 'zone' | 'target' | 'obstacle' | 'hazard' | 'unknown';

/* ------------------------------------------------------------------ */
/* Matter helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Matter tracks the previous pose on every body at runtime, but
 * @types/matter-js does not declare these fields.
 */
interface BodyPreviousState {
  readonly positionPrev: Matter.Vector;
  readonly anglePrev: number;
}

/** Runtime guard: true when the body carries its previous position and angle. */
function hasPreviousState(body: Matter.Body): body is Matter.Body & BodyPreviousState {
  const candidate = body as Matter.Body & Partial<BodyPreviousState>;
  const previous = candidate.positionPrev;
  return (
    previous !== undefined &&
    Number.isFinite(previous.x) &&
    Number.isFinite(previous.y) &&
    typeof candidate.anglePrev === 'number' &&
    Number.isFinite(candidate.anglePrev)
  );
}

/**
 * Velocity in units per fixed step. Prefers the position delta, because
 * collision solving adjusts positionPrev, so it reflects post-collision
 * velocity on the same step. Falls back to Matter's own velocity field.
 */
function readVelocity(body: Matter.Body): Vec2 {
  if (hasPreviousState(body)) {
    return {
      x: body.position.x - body.positionPrev.x,
      y: body.position.y - body.positionPrev.y,
    };
  }
  return { x: body.velocity.x, y: body.velocity.y };
}

/** Angular velocity in radians per fixed step, with the same fallback. */
function readAngularVelocity(body: Matter.Body): number {
  if (hasPreviousState(body)) {
    return body.angle - body.anglePrev;
  }
  return body.angularVelocity;
}

function createBody(
  shape: Shape,
  position: Vec2,
  options: Matter.IChamferableBodyDefinition,
): Matter.Body {
  if (shape.type === 'rect') {
    return Bodies.rectangle(position.x, position.y, shape.width, shape.height, options);
  }
  return Bodies.circle(position.x, position.y, shape.radius, options);
}

function isInsideRect(point: Vec2, center: Vec2, width: number, height: number): boolean {
  return (
    Math.abs(point.x - center.x) <= width / 2 && Math.abs(point.y - center.y) <= height / 2
  );
}

/* ------------------------------------------------------------------ */
/* PhysicsWorld                                                        */
/* ------------------------------------------------------------------ */

export class PhysicsWorld {
  private readonly engine: Matter.Engine;
  private readonly listeners = new Set<PhysicsEventListener>();

  private level: LevelDefinition | null = null;
  private simTimeMs = 0;

  private readonly dishes = new Map<EntityId, DishRecord>();
  private readonly hazards = new Map<EntityId, HazardRecord>();
  private readonly obstacles = new Map<EntityId, ObstacleRecord>();
  private readonly zones = new Map<EntityId, ZoneRecord>();
  private readonly targets = new Map<EntityId, TargetRecord>();

  /** zoneId / targetId -> ids of dishes currently overlapping it. */
  private readonly zoneOccupants = new Map<EntityId, Set<EntityId>>();
  private readonly targetOccupants = new Map<EntityId, Set<EntityId>>();

  /** Velocities captured before Engine.update (units per step). */
  private readonly preStepVelocities = new Map<EntityId, Vec2>();
  /** Largest collision impact per dish during the current step. */
  private readonly stepImpacts = new Map<EntityId, number>();

  private pendingEvents: PhysicsEvent[] = [];

  constructor(level: LevelDefinition) {
    this.engine = Engine.create();
    // Top-down view: no gravity. Slowing comes from frictionAir.
    this.engine.gravity.x = 0;
    this.engine.gravity.y = 0;
    this.engine.gravity.scale = 0;
    this.engine.enableSleeping = false;

    Events.on(this.engine, 'collisionStart', this.handleCollisionStart);
    Events.on(this.engine, 'collisionEnd', this.handleCollisionEnd);

    this.loadLevel(level);
  }

  /* ------------------------------ Lifecycle ----------------------------- */

  /**
   * Replaces the world contents with a level's obstacles, zones, targets and
   * hazards. Dishes are NOT created here; call spawnDish() for each one.
   * Listeners are kept.
   */
  loadLevel(level: LevelDefinition): void {
    this.clearWorld();
    this.level = level;
    this.simTimeMs = 0;

    for (const obstacle of level.obstacles) {
      const body = createBody(obstacle.shape, obstacle.position, {
        label: obstacle.id,
        isStatic: true,
        angle: obstacle.angle,
        friction: 0.2,
        restitution: 0.4,
      });
      this.obstacles.set(obstacle.id, { id: obstacle.id, body, shape: obstacle.shape });
      Composite.add(this.engine.world, body);
    }

    for (const zone of level.zones) {
      const body = Bodies.rectangle(zone.position.x, zone.position.y, zone.width, zone.height, {
        label: zone.id,
        isStatic: true,
        isSensor: true,
      });
      this.zones.set(zone.id, { def: zone, body });
      this.zoneOccupants.set(zone.id, new Set<EntityId>());
      Composite.add(this.engine.world, body);
    }

    for (const target of level.targets) {
      const body = Bodies.rectangle(
        target.position.x,
        target.position.y,
        target.width,
        target.height,
        { label: target.id, isStatic: true, isSensor: true },
      );
      this.targets.set(target.id, { def: target, body });
      this.targetOccupants.set(target.id, new Set<EntityId>());
      Composite.add(this.engine.world, body);
    }

    for (const hazard of level.hazards) {
      const axis = PhysicsWorld.normalize(hazard.motion.axis);
      const startPosition = PhysicsWorld.hazardPositionAt(hazard, axis, 0);
      const body = createBody(hazard.shape, startPosition, {
        label: hazard.id,
        isStatic: true,
        friction: 0.1,
        restitution: 0.6,
      });
      this.hazards.set(hazard.id, { def: hazard, body, axis, velocity: ZERO });
      Composite.add(this.engine.world, body);
    }
  }

  /** Removes all Matter listeners and bodies. The instance is unusable after. */
  dispose(): void {
    Events.off(this.engine, 'collisionStart', this.handleCollisionStart);
    Events.off(this.engine, 'collisionEnd', this.handleCollisionEnd);
    this.clearWorld();
    this.listeners.clear();
    this.level = null;
  }

  private clearWorld(): void {
    Composite.clear(this.engine.world, false, true);
    Engine.clear(this.engine);
    this.dishes.clear();
    this.hazards.clear();
    this.obstacles.clear();
    this.zones.clear();
    this.targets.clear();
    this.zoneOccupants.clear();
    this.targetOccupants.clear();
    this.preStepVelocities.clear();
    this.stepImpacts.clear();
    this.pendingEvents = [];
  }

  /* ------------------------------- Events ------------------------------- */

  /** Subscribes to physics events. Returns an unsubscribe function. */
  addListener(listener: PhysicsEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* -------------------------------- Dishes ------------------------------ */

  /**
   * Creates the dish's body at its startPosition, at rest.
   * Returns false if the dish is unknown, already spawned, or no level is loaded.
   */
  spawnDish(dishId: EntityId): boolean {
    const level = this.level;
    if (level === null || this.dishes.has(dishId)) {
      return false;
    }
    const def = level.dishes.find((dish) => dish.id === dishId);
    if (def === undefined) {
      return false;
    }

    const body = createBody(def.shape, def.startPosition, {
      label: def.id,
      density: def.density,
      restitution: def.restitution,
      friction: def.friction,
      frictionStatic: 0,
      frictionAir: level.table.baseFrictionAir,
    });
    this.dishes.set(def.id, { def, body, fellOff: false });
    Composite.add(this.engine.world, body);
    return true;
  }

  /** Removes a dish from the world and from all overlap sets. */
  removeDish(dishId: EntityId): void {
    const record = this.dishes.get(dishId);
    if (record !== undefined) {
      Composite.remove(this.engine.world, record.body);
      this.dishes.delete(dishId);
    }
    for (const occupants of this.zoneOccupants.values()) {
      occupants.delete(dishId);
    }
    for (const occupants of this.targetOccupants.values()) {
      occupants.delete(dishId);
    }
    this.preStepVelocities.delete(dishId);
    this.stepImpacts.delete(dishId);
  }

  hasDish(dishId: EntityId): boolean {
    return this.dishes.has(dishId);
  }

  /**
   * Launches a spawned dish. `drag` is the vector from the slingshot anchor to
   * where the player pulled; the dish travels the opposite way.
   * Returns false when nothing was launched (unknown dish or zero drag).
   */
  launchDish(dishId: EntityId, drag: Vec2): boolean {
    const level = this.level;
    const record = this.dishes.get(dishId);
    if (level === null || record === undefined || record.fellOff) {
      return false;
    }
    const velocity = computeLaunchVelocity(drag, level.slingshot);
    if (magnitude(velocity) === 0) {
      return false;
    }
    Body.setVelocity(record.body, velocity);
    Body.setAngularVelocity(record.body, 0);
    return true;
  }

  /**
   * Applies a Tablecloth Tug to every dish still on the table.
   * Returns the number of bodies affected.
   */
  applyTug(params: TugParameters = DEFAULT_TUG_PARAMETERS): number {
    let affected = 0;
    for (const record of this.dishes.values()) {
      if (record.fellOff) {
        continue;
      }
      const { body } = record;
      const mass = body.mass;
      if (!Number.isFinite(mass) || mass <= 0) {
        continue;
      }
      const velocity = readVelocity(body);
      Body.setVelocity(body, {
        x: velocity.x + (params.direction * params.lateralImpulse) / mass,
        y: velocity.y,
      });

      const inertia = body.inertia;
      if (Number.isFinite(inertia) && inertia > 0) {
        Body.setAngularVelocity(
          body,
          readAngularVelocity(body) + (params.direction * params.torque) / inertia,
        );
      }
      affected += 1;
    }
    return affected;
  }

  /* -------------------------------- Queries ----------------------------- */

  getLevel(): LevelDefinition | null {
    return this.level;
  }

  /** Accumulated simulated time in ms (advances only inside step()). */
  getSimTimeMs(): number {
    return this.simTimeMs;
  }

  /** Dish speed in units per step, or 0 for an unknown dish. */
  getDishSpeed(dishId: EntityId): number {
    const record = this.dishes.get(dishId);
    return record === undefined ? 0 : magnitude(readVelocity(record.body));
  }

  /** Zone kinds a dish currently overlaps. */
  getActiveZoneKinds(dishId: EntityId): readonly SurfaceZoneKind[] {
    const kinds: SurfaceZoneKind[] = [];
    for (const [zoneId, occupants] of this.zoneOccupants) {
      const zone = this.zones.get(zoneId);
      if (zone !== undefined && occupants.has(dishId) && !kinds.includes(zone.def.kind)) {
        kinds.push(zone.def.kind);
      }
    }
    return kinds;
  }

  /**
   * True when every dish still on the table is below both rest thresholds.
   * Hazards are ignored (they never rest).
   */
  areDishesSettled(
    linearThreshold: number = DEFAULT_LINEAR_REST_SPEED,
    angularThreshold: number = DEFAULT_ANGULAR_REST_SPEED,
  ): boolean {
    for (const record of this.dishes.values()) {
      if (record.fellOff) {
        continue;
      }
      if (
        magnitude(readVelocity(record.body)) > linearThreshold ||
        Math.abs(readAngularVelocity(record.body)) > angularThreshold
      ) {
        return false;
      }
    }
    return true;
  }

  /** Renderable poses of every dish, obstacle and hazard. */
  getBodySnapshots(): readonly BodySnapshot[] {
    const snapshots: BodySnapshot[] = [];

    for (const [id, record] of this.obstacles) {
      snapshots.push({
        id,
        role: 'obstacle',
        position: { x: record.body.position.x, y: record.body.position.y },
        angle: record.body.angle,
        velocity: ZERO,
        angularVelocity: 0,
        shape: record.shape,
      });
    }

    for (const [id, record] of this.hazards) {
      snapshots.push({
        id,
        role: 'hazard',
        position: { x: record.body.position.x, y: record.body.position.y },
        angle: record.body.angle,
        velocity: record.velocity,
        angularVelocity: 0,
        shape: record.def.shape,
      });
    }

    for (const [id, record] of this.dishes) {
      snapshots.push({
        id,
        role: 'dish',
        position: { x: record.body.position.x, y: record.body.position.y },
        angle: record.body.angle,
        velocity: readVelocity(record.body),
        angularVelocity: readAngularVelocity(record.body),
        shape: record.def.shape,
      });
    }

    return snapshots;
  }

  /**
   * Predicts the launch path as dots for the aiming preview. It accounts for
   * air friction and surface zones but NOT collisions, so it shows the intended
   * line, not a guarantee. Returns one point every `stride` steps.
   */
  predictTrajectory(drag: Vec2, maxPoints = 18, stride = 6): readonly Vec2[] {
    const level = this.level;
    if (level === null) {
      return [];
    }
    const safeStride = Math.max(1, Math.floor(stride));
    const maxSteps = Math.max(1, Math.floor(maxPoints)) * safeStride;

    const launch = computeLaunchVelocity(drag, level.slingshot);
    let vx = launch.x;
    let vy = launch.y;
    let x = level.slingshot.anchor.x;
    let y = level.slingshot.anchor.y;

    const points: Vec2[] = [];
    for (let stepIndex = 1; stepIndex <= maxSteps; stepIndex += 1) {
      const damping = 1 - this.airFrictionAt({ x, y }, level);
      vx *= damping;
      vy *= damping;
      x += vx;
      y += vy;

      if (!this.isInsideTable({ x, y }, level)) {
        break;
      }
      if (Math.hypot(vx, vy) < MIN_PREVIEW_SPEED) {
        break;
      }
      if (stepIndex % safeStride === 0) {
        points.push({ x, y });
      }
    }
    return points;
  }

  /* --------------------------------- Step ------------------------------- */

  /**
   * Advances the simulation by exactly one fixed step and returns one
   * SloshSample per liquid dish still on the table. Call it from the engine's
   * fixed-timestep accumulator loop, every tick the game is running.
   */
  step(): readonly SloshSample[] {
    const level = this.level;
    if (level === null) {
      return [];
    }

    this.stepImpacts.clear();
    this.preStepVelocities.clear();

    // 1. Kinematic hazards.
    this.moveHazards();

    // 2. Pre-step velocities for collision impact calculations.
    for (const [id, record] of this.dishes) {
      this.preStepVelocities.set(id, readVelocity(record.body));
    }
    for (const [id, record] of this.hazards) {
      this.preStepVelocities.set(id, record.velocity);
    }

    // 3. Fixed-timestep physics.
    Engine.update(this.engine, FIXED_DT_MS);
    this.simTimeMs += FIXED_DT_MS;

    // 4. Surface zone effects for the NEXT step.
    this.applySurfaceEffects(level);

    // 5. Dishes leaving the table.
    this.detectFallenDishes(level);

    // 6. Target overlap events.
    this.queueTargetOverlaps();

    // 7. Slosh samples.
    const samples = this.buildSloshSamples();

    // 8. Deliver events after the world is consistent.
    this.flushEvents();

    return samples;
  }

  /* ---------------------------- Step internals -------------------------- */

  private moveHazards(): void {
    const nextTimeMs = this.simTimeMs + FIXED_DT_MS;
    for (const record of this.hazards.values()) {
      const target = PhysicsWorld.hazardPositionAt(record.def, record.axis, nextTimeMs);
      const delta: Vec2 = {
        x: target.x - record.body.position.x,
        y: target.y - record.body.position.y,
      };
      Body.setPosition(record.body, target);
      // Static bodies are not integrated; give the solver a real velocity so
      // dishes are struck with momentum.
      Body.setVelocity(record.body, delta);
      record.velocity = delta;
    }
  }

  private applySurfaceEffects(level: LevelDefinition): void {
    for (const [dishId, record] of this.dishes) {
      const kinds = this.getActiveZoneKinds(dishId);
      let effect: SurfaceZoneEffect | null = null;
      if (kinds.includes('mashed-potato')) {
        effect = SURFACE_ZONE_EFFECTS['mashed-potato'];
      } else if (kinds.includes('cranberry-spill')) {
        effect = SURFACE_ZONE_EFFECTS['cranberry-spill'];
      }

      if (effect === null) {
        record.body.frictionAir = level.table.baseFrictionAir;
        record.body.friction = record.def.friction;
      } else {
        record.body.frictionAir = effect.frictionAir;
        record.body.friction = record.def.friction * effect.frictionMultiplier;
      }
    }
  }

  private detectFallenDishes(level: LevelDefinition): void {
    for (const [dishId, record] of this.dishes) {
      if (record.fellOff) {
        continue;
      }
      if (!this.isBodyInsideTable(record.body, record.def.shape, level)) {
        record.fellOff = true;
        this.pendingEvents.push({ type: 'fell-off', dishId });
      }
    }
  }

  private queueTargetOverlaps(): void {
    for (const [targetId, occupants] of this.targetOccupants) {
      for (const dishId of occupants) {
        const record = this.dishes.get(dishId);
        if (record === undefined || record.fellOff) {
          continue;
        }
        this.pendingEvents.push({
          type: 'target-overlap',
          targetId,
          dishId,
          speed: magnitude(readVelocity(record.body)),
        });
      }
    }
  }

  private buildSloshSamples(): readonly SloshSample[] {
    const samples: SloshSample[] = [];
    for (const [dishId, record] of this.dishes) {
      if (!record.def.isLiquid || record.fellOff) {
        continue;
      }
      samples.push({
        dishId,
        velocity: readVelocity(record.body),
        angularVelocity: readAngularVelocity(record.body),
        dtMs: FIXED_DT_MS,
        impactSpeed: this.stepImpacts.get(dishId) ?? 0,
      });
    }
    return samples;
  }

  private flushEvents(): void {
    if (this.pendingEvents.length === 0) {
      return;
    }
    const events = this.pendingEvents;
    this.pendingEvents = [];
    const listeners = [...this.listeners];
    for (const event of events) {
      for (const listener of listeners) {
        listener(event);
      }
    }
  }

  /* ----------------------------- Collision events ----------------------- */

  private readonly handleCollisionStart = (
    event: Matter.IEventCollision<Matter.Engine>,
  ): void => {
    for (const pair of event.pairs) {
      const idA = pair.bodyA.label;
      const idB = pair.bodyB.label;
      const roleA = this.classify(idA);
      const roleB = this.classify(idB);

      if (roleA === 'dish' && (roleB === 'zone' || roleB === 'target')) {
        this.enterSensor(idB, roleB, idA);
      } else if (roleB === 'dish' && (roleA === 'zone' || roleA === 'target')) {
        this.enterSensor(idA, roleA, idB);
      } else if (
        (roleA === 'dish' || roleB === 'dish') &&
        PhysicsWorld.isSolidRole(roleA) &&
        PhysicsWorld.isSolidRole(roleB)
      ) {
        this.recordCollision(pair, idA, idB, roleA, roleB);
      }
    }
  };

  private readonly handleCollisionEnd = (
    event: Matter.IEventCollision<Matter.Engine>,
  ): void => {
    for (const pair of event.pairs) {
      const idA = pair.bodyA.label;
      const idB = pair.bodyB.label;
      const roleA = this.classify(idA);
      const roleB = this.classify(idB);

      if (roleA === 'dish' && (roleB === 'zone' || roleB === 'target')) {
        this.exitSensor(idB, roleB, idA);
      } else if (roleB === 'dish' && (roleA === 'zone' || roleA === 'target')) {
        this.exitSensor(idA, roleA, idB);
      }
    }
  };

  private enterSensor(sensorId: EntityId, role: BodyRole, dishId: EntityId): void {
    if (role === 'zone') {
      const occupants = this.zoneOccupants.get(sensorId);
      const zone = this.zones.get(sensorId);
      if (occupants !== undefined && zone !== undefined && !occupants.has(dishId)) {
        occupants.add(dishId);
        this.pendingEvents.push({
          type: 'zone-enter',
          zoneId: sensorId,
          zoneKind: zone.def.kind,
          dishId,
        });
      }
    } else if (role === 'target') {
      this.targetOccupants.get(sensorId)?.add(dishId);
    }
  }

  private exitSensor(sensorId: EntityId, role: BodyRole, dishId: EntityId): void {
    if (role === 'zone') {
      const occupants = this.zoneOccupants.get(sensorId);
      const zone = this.zones.get(sensorId);
      if (occupants !== undefined && zone !== undefined && occupants.delete(dishId)) {
        this.pendingEvents.push({
          type: 'zone-exit',
          zoneId: sensorId,
          zoneKind: zone.def.kind,
          dishId,
        });
      }
    } else if (role === 'target') {
      this.targetOccupants.get(sensorId)?.delete(dishId);
    }
  }

  private recordCollision(
    pair: Matter.Pair,
    idA: EntityId,
    idB: EntityId,
    roleA: BodyRole,
    roleB: BodyRole,
  ): void {
    const velocityA = this.preStepVelocities.get(idA) ?? ZERO;
    const velocityB = this.preStepVelocities.get(idB) ?? ZERO;
    const normal = pair.collision.normal;
    const impactSpeed = Math.abs(
      (velocityB.x - velocityA.x) * normal.x + (velocityB.y - velocityA.y) * normal.y,
    );

    if (roleA === 'dish') {
      this.stepImpacts.set(idA, Math.max(this.stepImpacts.get(idA) ?? 0, impactSpeed));
    }
    if (roleB === 'dish') {
      this.stepImpacts.set(idB, Math.max(this.stepImpacts.get(idB) ?? 0, impactSpeed));
    }

    const support = pair.collision.supports[0];
    const point: Vec2 =
      support !== undefined
        ? { x: support.x, y: support.y }
        : {
            x: (pair.bodyA.position.x + pair.bodyB.position.x) / 2,
            y: (pair.bodyA.position.y + pair.bodyB.position.y) / 2,
          };

    this.pendingEvents.push({ type: 'collision', aId: idA, bId: idB, impactSpeed, point });
  }

  /* -------------------------------- Helpers ----------------------------- */

  private classify(id: EntityId): BodyRole {
    if (this.dishes.has(id)) return 'dish';
    if (this.zones.has(id)) return 'zone';
    if (this.targets.has(id)) return 'target';
    if (this.obstacles.has(id)) return 'obstacle';
    if (this.hazards.has(id)) return 'hazard';
    return 'unknown';
  }

  private static isSolidRole(role: BodyRole): boolean {
    return role === 'dish' || role === 'obstacle' || role === 'hazard';
  }

  private isInsideTable(point: Vec2, level: LevelDefinition): boolean {
    const { top } = level.table;
    return (
      point.x >= top.x &&
      point.x <= top.x + top.width &&
      point.y >= top.y &&
      point.y <= top.y + top.height
    );
  }

  private isBodyInsideTable(body: Matter.Body, shape: Shape, level: LevelDefinition): boolean {
    if (shape.type === 'circle') {
      return (
        body.position.x - shape.radius >= level.table.top.x &&
        body.position.x + shape.radius <= level.table.top.x + level.table.top.width &&
        body.position.y - shape.radius >= level.table.top.y &&
        body.position.y + shape.radius <= level.table.top.y + level.table.top.height
      );
    }

    const cos = Math.cos(body.angle);
    const sin = Math.sin(body.angle);
    const halfWidth = shape.width / 2;
    const halfHeight = shape.height / 2;
    const corners: readonly Vec2[] = [
      { x: -halfWidth, y: -halfHeight },
      { x: halfWidth, y: -halfHeight },
      { x: halfWidth, y: halfHeight },
      { x: -halfWidth, y: halfHeight },
    ];

    return corners.every((corner) => {
      const point = {
        x: body.position.x + corner.x * cos - corner.y * sin,
        y: body.position.y + corner.x * sin + corner.y * cos,
      };
      return this.isInsideTable(point, level);
    });
  }

  /** Air friction at a point using zone geometry only (for trajectory preview). */
  private airFrictionAt(point: Vec2, level: LevelDefinition): number {
    let inCranberry = false;
    for (const zone of level.zones) {
      if (isInsideRect(point, zone.position, zone.width, zone.height)) {
        if (zone.kind === 'mashed-potato') {
          return SURFACE_ZONE_EFFECTS['mashed-potato'].frictionAir;
        }
        inCranberry = true;
      }
    }
    return inCranberry
      ? SURFACE_ZONE_EFFECTS['cranberry-spill'].frictionAir
      : level.table.baseFrictionAir;
  }

  private static normalize(vec: Vec2): Vec2 {
    const length = magnitude(vec);
    if (!Number.isFinite(length) || length === 0) {
      return ZERO;
    }
    return { x: vec.x / length, y: vec.y / length };
  }

  /** Deterministic sine-wave position of a hazard at simulated time `timeMs`. */
  private static hazardPositionAt(hazard: HazardDefinition, axis: Vec2, timeMs: number): Vec2 {
    const { amplitude, frequencyHz, phase } = hazard.motion;
    const offset = amplitude * Math.sin(2 * Math.PI * frequencyHz * (timeMs / 1000) + phase);
    return {
      x: hazard.origin.x + axis.x * offset,
      y: hazard.origin.y + axis.y * offset,
    };
  }
}