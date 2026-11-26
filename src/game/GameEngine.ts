/**
 * GameEngine.ts
 * Fixed-timestep game loop and state machine for
 * "Pass the Gravy: Tablecloth Tactics".
 *
 * RULES FOR THIS FILE
 * - No document, no window, no Canvas. Rendering, audio, the HUD and the
 *   frame scheduler are all injected through interfaces from game.types.ts.
 * - Physics stepping is fixed at FIXED_DT_MS, accumulated from frame deltas.
 *
 * PHASES
 *   menu -> aiming <-> simulating -> levelComplete | gameOver
 *
 * AIM CONVENTIONS
 * - angle is the direction the dish will TRAVEL, in radians. 0 points right
 *   and positive angles point DOWN the screen (+y is down).
 * - power is 0..1 (drag length / slingshot.maxDrag).
 * - 'aim-update' carries the pointer drag vector from the anchor; the dish
 *   travels the opposite way. A zero-length drag sets power to 0, so a plain
 *   click cannot launch.
 */

import { FIXED_DT_MS, MAX_FRAME_MS, SLOSH_MAX } from '../types/game.types';
import type {
  AimState,
  AudioPlayer,
  CollisionEvent,
  DishDefinition,
  EntityId,
  FailReason,
  FellOffEvent,
  FrameScheduler,
  GamePhase,
  GameState,
  HudSink,
  InputCommand,
  LevelDefinition,
  PhysicsEvent,
  Renderer,
  TargetDefinition,
  TargetEvent,
  Vec2,
  ZoneEvent,
} from '../types/game.types';
import { LEVELS } from '../levels/levels';
import { intensityFromImpact } from './AudioManager';
import { DEFAULT_TUG_PARAMETERS, PhysicsWorld, clampDrag } from './PhysicsWorld';
import { SloshTracker } from './SloshTracker';

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** Initial aim for each new dish: straight right at half power. */
const DEFAULT_AIM_ANGLE = 0;
const DEFAULT_AIM_POWER = 0.5;

/** Power at or below this does not launch. */
const MIN_LAUNCH_POWER = 0.05;

/** A dish must move slower than this (units per step) to count as settled. */
const SETTLE_SPEED = 0.15;

/** Simulation turn limits, in ms of simulated time. */
const MIN_SIM_MS = 400;
const MAX_SIM_MS = 15_000;

/** Minimum ms between HUD refreshes for continuously changing values. */
const HUD_INTERVAL_MS = 100;

/** Minimum ms between keyboard aim announcements. */
const AIM_ANNOUNCE_INTERVAL_MS = 400;

/** Points per unused tug when a level is completed. */
const TUG_BONUS = 25;

/** Fraction of target points a perfectly steady liquid dish can add. */
const SLOSH_BONUS_FRACTION = 0.5;

/** Collision audio thresholds (units per step). */
const MIN_AUDIBLE_IMPACT = 0.6;
const SPLASH_IMPACT = 6;

const ZERO: Vec2 = { x: 0, y: 0 };

/* ------------------------------------------------------------------ */
/* Public dependency contract                                          */
/* ------------------------------------------------------------------ */

export interface GameEngineDependencies {
  readonly renderer: Renderer;
  readonly audio: AudioPlayer;
  readonly hud: HudSink;
  readonly scheduler: FrameScheduler;
  /** Defaults to the LEVELS exported by src/levels/levels.ts. */
  readonly levels?: readonly LevelDefinition[];
}

/* ------------------------------------------------------------------ */
/* Internal types and helpers                                          */
/* ------------------------------------------------------------------ */

/**
 * queued    - waiting in the dish queue
 * ready     - spawned on the slingshot, not yet launched
 * onTable   - launched and still in play
 * delivered - handed to a relative (removed from the world)
 * lost      - fell off the table (removed from the world)
 */
type DishStatus = 'queued' | 'ready' | 'onTable' | 'delivered' | 'lost';

type EntityKind = 'dish' | 'obstacle' | 'hazard';

interface SettleTimer {
  readonly dishId: EntityId;
  elapsedMs: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Wraps an angle into (-PI, PI]. */
function wrapAngle(angle: number): number {
  const twoPi = 2 * Math.PI;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) {
    wrapped -= twoPi;
  } else if (wrapped <= -Math.PI) {
    wrapped += twoPi;
  }
  return wrapped;
}

function isInsideTarget(point: Vec2, target: TargetDefinition): boolean {
  return (
    Math.abs(point.x - target.position.x) <= target.width / 2 &&
    Math.abs(point.y - target.position.y) <= target.height / 2
  );
}

/* ------------------------------------------------------------------ */
/* GameEngine                                                          */
/* ------------------------------------------------------------------ */

export class GameEngine {
  private readonly renderer: Renderer;
  private readonly audio: AudioPlayer;
  private readonly hud: HudSink;
  private readonly scheduler: FrameScheduler;
  private readonly levels: readonly LevelDefinition[];

  private readonly physics: PhysicsWorld;
  private readonly tracker = new SloshTracker();
  private readonly unsubscribePhysics: () => void;

  /* Loop state */
  private running = false;
  private frameHandle: number | null = null;
  private lastFrameMs: number | null = null;
  private accumulatorMs = 0;
  private nowMs = 0;

  /* HUD refresh state */
  private hudDirty = true;
  private lastHudMs = 0;
  private lastAimAnnounceMs = Number.NEGATIVE_INFINITY;

  /* Game state */
  private phase: GamePhase = 'menu';
  private levelIndex = 0;
  private level: LevelDefinition;
  private score = 0;
  private levelStartScore = 0;
  private tugsRemaining = 0;
  private failReason: FailReason | null = null;
  private muted = false;

  /* Per-level state */
  private activeDishId: EntityId | null = null;
  private aimAngle = DEFAULT_AIM_ANGLE;
  private aimPower = DEFAULT_AIM_POWER;
  private simElapsedMs = 0;
  private deliveredTargetIds: EntityId[] = [];
  private readonly statuses = new Map<EntityId, DishStatus>();
  private readonly dishById = new Map<EntityId, DishDefinition>();
  private readonly targetById = new Map<EntityId, TargetDefinition>();
  private readonly entityKinds = new Map<EntityId, EntityKind>();
  private readonly targetTimers = new Map<EntityId, SettleTimer>();
  private stepEvents: PhysicsEvent[] = [];

  constructor(dependencies: GameEngineDependencies) {
    this.renderer = dependencies.renderer;
    this.audio = dependencies.audio;
    this.hud = dependencies.hud;
    this.scheduler = dependencies.scheduler;
    this.levels = dependencies.levels ?? LEVELS;

    const firstLevel = this.levels[0];
    if (firstLevel === undefined) {
      throw new Error('GameEngine requires at least one level.');
    }
    this.level = firstLevel;
    this.physics = new PhysicsWorld(firstLevel);
    this.unsubscribePhysics = this.physics.addListener((event) => {
      this.stepEvents.push(event);
    });
    this.indexLevel(firstLevel);
    this.tugsRemaining = firstLevel.maxTugs;
  }

  /* ------------------------------ Lifecycle ----------------------------- */

  /** Starts the animation loop. Safe to call repeatedly. */
  run(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastFrameMs = null;
    this.hud.update(this.getState());
    this.hudDirty = false;
    this.frameHandle = this.scheduler.request(this.onFrame);
  }

  /** Stops the animation loop. The game state is kept. */
  stop(): void {
    this.running = false;
    if (this.frameHandle !== null) {
      this.scheduler.cancel(this.frameHandle);
      this.frameHandle = null;
    }
  }

  /** Stops the loop and releases the physics world. Unusable afterwards. */
  dispose(): void {
    this.stop();
    this.unsubscribePhysics();
    this.physics.dispose();
  }

  isMuted(): boolean {
    return this.muted;
  }

  /* ------------------------------- Commands ----------------------------- */

  /** The only way input reaches the engine. */
  handleCommand(command: InputCommand): void {
    switch (command.type) {
      case 'start':
        this.onStart();
        break;
      case 'aim-update':
        this.onAimUpdate(command.drag);
        break;
      case 'aim-nudge':
        this.onAimNudge(command.deltaAngle, command.deltaPower);
        break;
      case 'launch':
        this.onLaunch();
        break;
      case 'tug':
        this.onTug();
        break;
      case 'restart-level':
        this.onRestart();
        break;
      case 'toggle-mute':
        this.onToggleMute();
        break;
    }
    this.markDirty();
  }

  private onStart(): void {
    switch (this.phase) {
      case 'menu':
        this.score = 0;
        this.startLevel(0);
        break;
      case 'levelComplete': {
        const next = this.levelIndex + 1;
        if (next >= this.levels.length) {
          this.score = 0;
          this.startLevel(0);
        } else {
          this.startLevel(next);
        }
        break;
      }
      case 'gameOver':
        this.score = this.levelStartScore;
        this.startLevel(this.levelIndex);
        break;
      case 'aiming':
      case 'simulating':
        break;
    }
  }

  private onRestart(): void {
    if (this.phase === 'menu') {
      return;
    }
    this.score = this.levelStartScore;
    this.startLevel(this.levelIndex);
  }

  private onAimUpdate(drag: Vec2): void {
    if (this.phase !== 'aiming') {
      return;
    }
    const maxDrag = this.level.slingshot.maxDrag;
    const clamped = clampDrag(drag, maxDrag);
    const length = Math.hypot(clamped.x, clamped.y);
    this.aimPower = maxDrag > 0 ? clamp(length / maxDrag, 0, 1) : 0;
    if (length > 0) {
      // The dish travels opposite to the drag.
      this.aimAngle = Math.atan2(-clamped.y, -clamped.x);
    }
  }

  private onAimNudge(deltaAngle: number, deltaPower: number): void {
    if (this.phase !== 'aiming') {
      return;
    }
    if (Number.isFinite(deltaAngle)) {
      this.aimAngle = wrapAngle(this.aimAngle + deltaAngle);
    }
    if (Number.isFinite(deltaPower)) {
      this.aimPower = clamp(this.aimPower + deltaPower, 0, 1);
    }
    if (this.nowMs - this.lastAimAnnounceMs >= AIM_ANNOUNCE_INTERVAL_MS) {
      this.lastAimAnnounceMs = this.nowMs;
      const degrees = Math.round((this.aimAngle * 180) / Math.PI);
      const percent = Math.round(this.aimPower * 100);
      this.hud.announce(`Aim ${degrees} degrees, power ${percent} percent.`, false);
    }
  }

  private onLaunch(): void {
    if (this.phase !== 'aiming') {
      return;
    }
    const dishId = this.activeDishId;
    if (dishId === null) {
      return;
    }
    if (this.aimPower <= MIN_LAUNCH_POWER) {
      this.hud.announce('Pull back further to launch.', false);
      return;
    }
    const aim = this.buildAim();
    if (!this.physics.launchDish(dishId, aim.drag)) {
      this.hud.announce('That dish cannot be launched.', true);
      return;
    }
    // The slingshot impulse must not count as a spill-causing jerk.
    this.tracker.resetMotionHistory(dishId);
    this.statuses.set(dishId, 'onTable');
    this.simElapsedMs = 0;
    this.phase = 'simulating';
    this.audio.play('launch', aim.power);
    const dish = this.dishById.get(dishId);
    this.hud.announce(`${dish?.label ?? 'Dish'} launched.`, false);
  }

  private onTug(): void {
    if (this.phase === 'aiming') {
      this.hud.announce('Launch a dish first. The tug works while dishes are moving.', false);
      return;
    }
    if (this.phase !== 'simulating') {
      return;
    }
    if (this.tugsRemaining <= 0) {
      this.hud.announce('No tablecloth tugs left.', true);
      return;
    }
    const affected = this.physics.applyTug(DEFAULT_TUG_PARAMETERS);
    if (affected === 0) {
      return;
    }
    this.tugsRemaining -= 1;
    this.audio.play('tug', 1);
    this.hud.announce(`Tablecloth tug! ${this.tugsRemaining} left.`, false);
  }

  private onToggleMute(): void {
    this.muted = !this.muted;
    this.audio.setMuted(this.muted);
    this.hud.announce(this.muted ? 'Sound muted.' : 'Sound on.', false);
  }

  /* ------------------------------ Level flow ---------------------------- */

  private startLevel(index: number): void {
    const level = this.levels[index];
    if (level === undefined) {
      return;
    }
    this.levelIndex = index;
    this.level = level;
    this.levelStartScore = this.score;
    this.tugsRemaining = level.maxTugs;
    this.failReason = null;
    this.activeDishId = null;
    this.simElapsedMs = 0;
    this.accumulatorMs = 0;
    this.deliveredTargetIds = [];
    this.targetTimers.clear();
    this.stepEvents = [];
    this.aimAngle = DEFAULT_AIM_ANGLE;
    this.aimPower = DEFAULT_AIM_POWER;

    this.physics.loadLevel(level);
    this.tracker.clear();
    this.indexLevel(level);

    this.beginNextDish(`${level.briefing} `);
  }

  /** Rebuilds the id lookup tables for a level. */
  private indexLevel(level: LevelDefinition): void {
    this.statuses.clear();
    this.dishById.clear();
    this.targetById.clear();
    this.entityKinds.clear();

    for (const dish of level.dishes) {
      this.statuses.set(dish.id, 'queued');
      this.dishById.set(dish.id, dish);
      this.entityKinds.set(dish.id, 'dish');
    }
    for (const target of level.targets) {
      this.targetById.set(target.id, target);
    }
    for (const obstacle of level.obstacles) {
      this.entityKinds.set(obstacle.id, 'obstacle');
    }
    for (const hazard of level.hazards) {
      this.entityKinds.set(hazard.id, 'hazard');
    }
  }

  /** Spawns the next queued dish on the slingshot and enters 'aiming'. */
  private beginNextDish(announcePrefix = ''): void {
    for (const dish of this.level.dishes) {
      if (this.statuses.get(dish.id) !== 'queued') {
        continue;
      }
      if (!this.physics.spawnDish(dish.id)) {
        this.statuses.set(dish.id, 'lost');
        continue;
      }
      this.statuses.set(dish.id, 'ready');
      if (dish.isLiquid) {
        this.tracker.registerDish(dish.id, dish.sloshSensitivity);
      }
      this.activeDishId = dish.id;
      this.aimAngle = DEFAULT_AIM_ANGLE;
      this.aimPower = DEFAULT_AIM_POWER;
      this.phase = 'aiming';

      const requester = this.level.targets.find(
        (target) =>
          target.requestedDish === dish.kind && !this.deliveredTargetIds.includes(target.id),
      );
      const requestText = requester === undefined ? '' : ` ${requester.relativeName} wants it.`;
      const left = this.countStatuses('queued', 'ready');
      this.hud.announce(
        `${announcePrefix}${dish.label} ready.${requestText} ${left} ${left === 1 ? 'dish' : 'dishes'} left, ${this.tugsRemaining} tugs left.`,
        false,
      );
      return;
    }
    this.failLevel(this.lossReason(), this.failureMessage(this.lossReason()));
  }

  /** Called when the current simulation turn has settled (or timed out). */
  private endTurn(): void {
    if (this.allTargetsDelivered()) {
      this.completeLevel();
      return;
    }
    if (this.countStatuses('queued') === 0 || !this.isStillWinnable()) {
      const reason = this.lossReason();
      this.failLevel(reason, this.failureMessage(reason));
      return;
    }
    this.beginNextDish();
  }

  private completeLevel(): void {
    const tugBonus = this.tugsRemaining * TUG_BONUS;
    this.score += tugBonus;
    this.phase = 'levelComplete';
    this.activeDishId = null;
    this.markDirty();

    const isLast = this.levelIndex >= this.levels.length - 1;
    if (isLast) {
      this.hud.announce(
        `Everyone is fed! You saved Thanksgiving. Final score ${this.score}. Press Start to play again.`,
        false,
      );
    } else {
      const bonusText = tugBonus > 0 ? `, including ${tugBonus} bonus points for unused tugs` : '';
      this.hud.announce(
        `Level ${this.level.id} complete! Score ${this.score}${bonusText}. Press Start for the next level.`,
        false,
      );
    }
  }

  private failLevel(reason: FailReason, message: string): void {
    this.phase = 'gameOver';
    this.failReason = reason;
    this.markDirty();
    this.audio.play('fail', 1);
    this.hud.announce(message, true);
  }

  private failureMessage(reason: FailReason): string {
    switch (reason) {
      case 'spill':
        return 'Spilled! Level failed. Press Start to retry.';
      case 'fell-off-table':
        return 'A dish somebody needed fell off the table. Level failed. Press Start to retry.';
      case 'out-of-dishes':
        return 'Out of dishes and someone is still hungry. Level failed. Press Start to retry.';
    }
  }

  /** 'fell-off-table' when a lost dish was of a still-requested kind. */
  private lossReason(): FailReason {
    for (const target of this.level.targets) {
      if (this.deliveredTargetIds.includes(target.id)) {
        continue;
      }
      for (const dish of this.level.dishes) {
        if (dish.kind === target.requestedDish && this.statuses.get(dish.id) === 'lost') {
          return 'fell-off-table';
        }
      }
    }
    return 'out-of-dishes';
  }

  private allTargetsDelivered(): boolean {
    return this.level.targets.every((target) => this.deliveredTargetIds.includes(target.id));
  }

  /** True when every hungry relative still has a usable dish of their kind. */
  private isStillWinnable(): boolean {
    for (const target of this.level.targets) {
      if (this.deliveredTargetIds.includes(target.id)) {
        continue;
      }
      const available = this.level.dishes.some((dish) => {
        const status = this.statuses.get(dish.id);
        return (
          dish.kind === target.requestedDish &&
          (status === 'queued' || status === 'ready' || status === 'onTable')
        );
      });
      if (!available) {
        return false;
      }
    }
    return true;
  }

  private countStatuses(...wanted: readonly DishStatus[]): number {
    let count = 0;
    for (const status of this.statuses.values()) {
      if (wanted.includes(status)) {
        count += 1;
      }
    }
    return count;
  }

  private isPlaying(): boolean {
    return this.phase === 'aiming' || this.phase === 'simulating';
  }

  /* --------------------------------- Loop ------------------------------- */

  private readonly onFrame = (timeMs: number): void => {
    if (!this.running) {
      return;
    }
    this.nowMs = timeMs;
    const previous = this.lastFrameMs;
    this.lastFrameMs = timeMs;
    const frameMs = previous === null ? 0 : clamp(timeMs - previous, 0, MAX_FRAME_MS);

    if (this.isPlaying()) {
      this.accumulatorMs += frameMs;
      while (this.accumulatorMs >= FIXED_DT_MS && this.isPlaying()) {
        this.stepSimulation();
        this.accumulatorMs -= FIXED_DT_MS;
      }
    } else {
      this.accumulatorMs = 0;
    }

    const state = this.getState();
    const showPreview = state.phase === 'aiming' && state.aim.power > MIN_LAUNCH_POWER;
    const trajectory: readonly Vec2[] = showPreview
      ? this.physics.predictTrajectory(state.aim.drag)
      : [];
    this.renderer.render(state, this.physics.getBodySnapshots(), trajectory, timeMs);

    const hudDue =
      this.hudDirty ||
      (state.phase === 'simulating' && timeMs - this.lastHudMs >= HUD_INTERVAL_MS);
    if (hudDue) {
      this.hud.update(state);
      this.hudDirty = false;
      this.lastHudMs = timeMs;
    }

    this.frameHandle = this.scheduler.request(this.onFrame);
  };

  /** One fixed physics step plus all rules that depend on its results. */
  private stepSimulation(): void {
    const samples = this.physics.step();
    for (const sample of samples) {
      this.tracker.update(sample);
    }

    this.processStepEvents();
    if (!this.isPlaying()) {
      return;
    }

    this.checkSpills();
    if (!this.isPlaying()) {
      return;
    }

    if (this.phase === 'simulating') {
      this.simElapsedMs += FIXED_DT_MS;
      const timedOut = this.simElapsedMs >= MAX_SIM_MS;
      const settled = this.simElapsedMs >= MIN_SIM_MS && this.physics.areDishesSettled();
      if (settled || timedOut) {
        this.endTurn();
      }
    }
  }

  private checkSpills(): void {
    const spilledId = this.tracker.getSpilledDishIds()[0];
    if (spilledId === undefined) {
      return;
    }
    const label = this.dishById.get(spilledId)?.label ?? 'A dish';
    this.audio.play('splash', 1);
    this.failLevel('spill', `${label} spilled everywhere! Level failed. Press Start to retry.`);
  }

  /* --------------------------- Event processing ------------------------- */

  private processStepEvents(): void {
    if (this.stepEvents.length === 0) {
      this.pruneTargetTimers(new Set<EntityId>());
      return;
    }
    const events = this.stepEvents;
    this.stepEvents = [];

    const seenTargets = new Set<EntityId>();
    let dishPositions: ReadonlyMap<EntityId, Vec2> | null = null;

    for (const event of events) {
      if (!this.isPlaying()) {
        return;
      }
      switch (event.type) {
        case 'collision':
          this.handleCollision(event);
          break;
        case 'zone-enter':
        case 'zone-exit':
          this.handleZone(event);
          break;
        case 'target-overlap':
          if (dishPositions === null) {
            dishPositions = this.buildDishPositions();
          }
          this.handleTargetOverlap(event, dishPositions, seenTargets);
          break;
        case 'fell-off':
          this.handleFellOff(event);
          break;
      }
    }

    this.pruneTargetTimers(seenTargets);
    this.collectDeliveries();
  }

  private handleCollision(event: CollisionEvent): void {
    if (event.impactSpeed < MIN_AUDIBLE_IMPACT) {
      return;
    }
    const intensity = intensityFromImpact(event.impactSpeed);
    const bothDishes =
      this.entityKinds.get(event.aId) === 'dish' && this.entityKinds.get(event.bId) === 'dish';
    this.audio.play(bothDishes ? 'clink' : 'thud', intensity);

    if (
      event.impactSpeed >= SPLASH_IMPACT &&
      (this.isLiquidDish(event.aId) || this.isLiquidDish(event.bId))
    ) {
      this.audio.play('splash', intensity);
    }
  }

  private handleZone(event: ZoneEvent): void {
    if (event.type !== 'zone-enter') {
      return;
    }
    if (event.zoneKind === 'mashed-potato') {
      this.audio.play('squelch', intensityFromImpact(this.physics.getDishSpeed(event.dishId)));
    } else {
      this.audio.play('splash', 0.3);
    }
  }

  private handleFellOff(event: FellOffEvent): void {
    const status = this.statuses.get(event.dishId);
    if (status === undefined || status === 'delivered' || status === 'lost') {
      return;
    }
    this.statuses.set(event.dishId, 'lost');
    this.tracker.unregisterDish(event.dishId);
    this.physics.removeDish(event.dishId);
    this.audio.play('fail', 0.6);
    const label = this.dishById.get(event.dishId)?.label ?? 'A dish';
    this.hud.announce(`${label} fell off the table!`, true);
    this.markDirty();
  }

  private handleTargetOverlap(
    event: TargetEvent,
    dishPositions: ReadonlyMap<EntityId, Vec2>,
    seenTargets: Set<EntityId>,
  ): void {
    const target = this.targetById.get(event.targetId);
    const dish = this.dishById.get(event.dishId);
    if (target === undefined || dish === undefined) {
      return;
    }
    if (this.deliveredTargetIds.includes(target.id)) {
      return;
    }
    if (dish.kind !== target.requestedDish || this.statuses.get(dish.id) !== 'onTable') {
      return;
    }
    if (event.speed > SETTLE_SPEED) {
      return;
    }
    const center = dishPositions.get(dish.id);
    if (center === undefined || !isInsideTarget(center, target)) {
      return;
    }

    seenTargets.add(target.id);
    const timer = this.targetTimers.get(target.id);
    if (timer === undefined || timer.dishId !== dish.id) {
      this.targetTimers.set(target.id, { dishId: dish.id, elapsedMs: FIXED_DT_MS });
    } else {
      timer.elapsedMs += FIXED_DT_MS;
    }
  }

  /** Drops settle timers for targets that did not qualify this step. */
  private pruneTargetTimers(seenTargets: ReadonlySet<EntityId>): void {
    for (const targetId of [...this.targetTimers.keys()]) {
      if (!seenTargets.has(targetId)) {
        this.targetTimers.delete(targetId);
      }
    }
  }

  private collectDeliveries(): void {
    const ready: Array<{ readonly target: TargetDefinition; readonly dish: DishDefinition }> = [];
    for (const [targetId, timer] of this.targetTimers) {
      const target = this.targetById.get(targetId);
      const dish = this.dishById.get(timer.dishId);
      if (target !== undefined && dish !== undefined && timer.elapsedMs >= target.settleMs) {
        ready.push({ target, dish });
      }
    }
    for (const item of ready) {
      if (!this.isPlaying()) {
        return;
      }
      this.deliver(item.target, item.dish);
    }
  }

  private deliver(target: TargetDefinition, dish: DishDefinition): void {
    this.statuses.set(dish.id, 'delivered');
    this.deliveredTargetIds.push(target.id);
    this.targetTimers.delete(target.id);

    const sloshLevel = this.tracker.getLevel(dish.id);
    const bonus = dish.isLiquid
      ? Math.round(target.points * SLOSH_BONUS_FRACTION * (1 - sloshLevel / SLOSH_MAX))
      : 0;
    const total = target.points + bonus;
    this.score += total;

    this.tracker.unregisterDish(dish.id);
    this.physics.removeDish(dish.id);

    this.audio.play('success', 1);
    this.markDirty();
    this.hud.announce(`${target.relativeName} got the ${dish.label}! Plus ${total} points.`, false);

    if (this.allTargetsDelivered()) {
      this.completeLevel();
    }
  }

  private isLiquidDish(id: EntityId): boolean {
    return this.dishById.get(id)?.isLiquid ?? false;
  }

  private buildDishPositions(): ReadonlyMap<EntityId, Vec2> {
    const positions = new Map<EntityId, Vec2>();
    for (const body of this.physics.getBodySnapshots()) {
      if (body.role === 'dish') {
        positions.set(body.id, body.position);
      }
    }
    return positions;
  }

  /* ------------------------------ State access -------------------------- */

  /** Immutable snapshot for the renderer and HUD. A fresh object each call. */
  getState(): GameState {
    return {
      phase: this.phase,
      levelIndex: this.levelIndex,
      level: this.level,
      activeDishId: this.activeDishId,
      dishesRemaining: this.countStatuses('queued', 'ready'),
      tugsRemaining: this.tugsRemaining,
      score: this.score,
      deliveredTargetIds: [...this.deliveredTargetIds],
      slosh: this.tracker.getAllLevels(),
      aim: this.buildAim(),
      failReason: this.failReason,
    };
  }

  private buildAim(): AimState {
    const active = this.phase === 'aiming' && this.activeDishId !== null;
    if (!active) {
      return { active: false, drag: ZERO, power: 0, angle: this.aimAngle };
    }
    const length = this.aimPower * this.level.slingshot.maxDrag;
    return {
      active: true,
      drag: {
        x: -Math.cos(this.aimAngle) * length,
        y: -Math.sin(this.aimAngle) * length,
      },
      power: this.aimPower,
      angle: this.aimAngle,
    };
  }

  private markDirty(): void {
    this.hudDirty = true;
  }
}