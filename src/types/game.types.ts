/**
 * game.types.ts
 * Shared contracts for "Pass the Gravy: Tablecloth Tactics".
 *
 * RULES FOR THIS FILE
 * - Pure types and plain constants only. No imports from matter-js, no DOM.
 * - Everything in src/game/ and src/levels/ may import from here safely.
 */

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** A 2D vector in world units (pixels, +y is down, matching Canvas). */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Stable string id used to correlate level data, physics bodies, and HUD. */
export type EntityId = string;

/** Fixed physics step (ms). The engine accumulates rAF time and steps by this. */
export const FIXED_DT_MS = 1000 / 60;

/** Upper bound on frame time fed to the accumulator (prevents spiral of death). */
export const MAX_FRAME_MS = 250;

/** Slosh meter bounds. Reaching SLOSH_MAX triggers a spill fail-state. */
export const SLOSH_MAX = 100;

/* ------------------------------------------------------------------ */
/* Shapes & accessibility patterns                                     */
/* ------------------------------------------------------------------ */

export type RectShape = {
  readonly type: 'rect';
  readonly width: number;
  readonly height: number;
};

export type CircleShape = {
  readonly type: 'circle';
  readonly radius: number;
};

export type Shape = RectShape | CircleShape;

/**
 * Fill patterns used alongside color so meaning never depends on hue alone.
 * The renderer maps each to a Canvas pattern.
 */
export type FillPattern =
  | 'solid'
  | 'diagonal-stripes'
  | 'dots'
  | 'crosshatch'
  | 'horizontal-lines';

/** Glyph drawn on top of a body or zone as a non-color cue. */
export type Glyph = '❄' | '●' | '⚠' | '★' | '♥';

/* ------------------------------------------------------------------ */
/* Dishes                                                              */
/* ------------------------------------------------------------------ */

export type DishKind =
  | 'gravy-boat'
  | 'cranberry-bowl'
  | 'turkey-platter'
  | 'roll-basket'
  | 'pie-tin';

export interface DishDefinition {
  readonly id: EntityId;
  readonly kind: DishKind;
  /** Human-readable name for HUD and screen readers. */
  readonly label: string;
  readonly shape: Shape;
  /** Matter.js density. */
  readonly density: number;
  /** Matter.js restitution (bounciness). */
  readonly restitution: number;
  /** Matter.js surface friction against the table and other bodies. */
  readonly friction: number;
  /** True for liquid-carrying dishes that feed the Slosh Meter. */
  readonly isLiquid: boolean;
  /**
   * Multiplier on slosh accumulation. 1 = baseline. Ignored when !isLiquid.
   * Higher means spills more easily.
   */
  readonly sloshSensitivity: number;
  /** Where the dish rests before launch / on the table. */
  readonly startPosition: Vec2;
  readonly pattern: FillPattern;
  readonly glyph: Glyph;
  /** CSS color. Always paired with pattern and glyph. */
  readonly color: string;
}

/* ------------------------------------------------------------------ */
/* Static obstacles, surface zones, dynamic hazards                    */
/* ------------------------------------------------------------------ */

/** Immovable decoration or blocker: candlesticks, the table edge lip, etc. */
export interface ObstacleDefinition {
  readonly id: EntityId;
  readonly label: string;
  readonly shape: Shape;
  readonly position: Vec2;
  /** Radians. */
  readonly angle: number;
  readonly pattern: FillPattern;
  readonly color: string;
}

export type SurfaceZoneKind = 'cranberry-spill' | 'mashed-potato';

/**
 * A sensor region that changes how dishes move while overlapping it.
 * Sensors do not collide; PhysicsWorld applies the effect on overlap.
 */
export interface SurfaceZoneDefinition {
  readonly id: EntityId;
  readonly kind: SurfaceZoneKind;
  readonly label: string;
  readonly position: Vec2;
  readonly width: number;
  readonly height: number;
  readonly pattern: FillPattern;
  readonly glyph: Glyph;
  readonly color: string;
}

/** Concrete physical effect for a zone kind (values live in PhysicsWorld). */
export interface SurfaceZoneEffect {
  /** frictionAir applied to dishes while inside the zone. */
  readonly frictionAir: number;
  /** Optional multiplier on the dish's surface friction while inside. */
  readonly frictionMultiplier: number;
}

/** Sine-wave kinematic motion for a moving hazard. */
export interface SineMotion {
  readonly kind: 'sine';
  /** Unit-ish direction of travel (will be normalized by the consumer). */
  readonly axis: Vec2;
  /** Peak displacement from origin, in world units. */
  readonly amplitude: number;
  /** Cycles per second. */
  readonly frequencyHz: number;
  /** Radians. */
  readonly phase: number;
}

export type HazardMotion = SineMotion;

export type HazardKind = 'toddler-hand' | 'wandering-cat' | 'swinging-ladle';

export interface HazardDefinition {
  readonly id: EntityId;
  readonly kind: HazardKind;
  readonly label: string;
  readonly shape: Shape;
  /** Center of motion. */
  readonly origin: Vec2;
  readonly motion: HazardMotion;
  readonly pattern: FillPattern;
  readonly glyph: Glyph;
  readonly color: string;
}

/* ------------------------------------------------------------------ */
/* Targets (hungry relatives)                                          */
/* ------------------------------------------------------------------ */

export interface TargetDefinition {
  readonly id: EntityId;
  /** Display name, e.g. "Aunt Marge". */
  readonly relativeName: string;
  /** Sensor rectangle where the requested dish must come to rest. */
  readonly position: Vec2;
  readonly width: number;
  readonly height: number;
  /** Which dish this relative is asking for. */
  readonly requestedDish: DishKind;
  /** How long (ms) the dish must remain in the zone, slowed, to count. */
  readonly settleMs: number;
  readonly points: number;
  readonly pattern: FillPattern;
  readonly glyph: Glyph;
  readonly color: string;
}

/* ------------------------------------------------------------------ */
/* Levels                                                              */
/* ------------------------------------------------------------------ */

export interface TableDefinition {
  /** World bounds of the playfield (matches canvas logical size). */
  readonly worldWidth: number;
  readonly worldHeight: number;
  /** Table top rectangle; dishes leaving it have fallen off. */
  readonly top: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Matter.js friction of the tablecloth surface. */
  readonly surfaceFriction: number;
  /** Default frictionAir for bodies on bare cloth. */
  readonly baseFrictionAir: number;
}

export interface SlingshotDefinition {
  /** Anchor point the player drags back from. */
  readonly anchor: Vec2;
  /** Maximum drag distance in world units. */
  readonly maxDrag: number;
  /** Launch speed (units per step) per unit of drag distance. */
  readonly powerScale: number;
}

export interface LevelDefinition {
  readonly id: number;
  readonly name: string;
  /** Short intro read aloud via the aria-live status region. */
  readonly briefing: string;
  readonly table: TableDefinition;
  readonly slingshot: SlingshotDefinition;
  /** Dishes available, in launch order. */
  readonly dishes: readonly DishDefinition[];
  readonly obstacles: readonly ObstacleDefinition[];
  readonly zones: readonly SurfaceZoneDefinition[];
  readonly hazards: readonly HazardDefinition[];
  readonly targets: readonly TargetDefinition[];
  /** Max Tablecloth Tugs allowed (spec: 2). */
  readonly maxTugs: number;
}

/* ------------------------------------------------------------------ */
/* Tablecloth Tug                                                      */
/* ------------------------------------------------------------------ */

export interface TugParameters {
  /** Lateral impulse magnitude applied to each dynamic body. */
  readonly lateralImpulse: number;
  /** Torque added to each dynamic body (small). */
  readonly torque: number;
  /** +1 pulls right, -1 pulls left. */
  readonly direction: 1 | -1;
}

/* ------------------------------------------------------------------ */
/* Game state                                                          */
/* ------------------------------------------------------------------ */

export type GamePhase =
  | 'menu'
  | 'aiming'
  | 'simulating'
  | 'levelComplete'
  | 'gameOver';

export type FailReason = 'spill' | 'fell-off-table' | 'out-of-dishes';

/** Aim input in world space, produced by input handling, consumed by engine. */
export interface AimState {
  readonly active: boolean;
  /** Drag vector from anchor (pointing where the player pulled). */
  readonly drag: Vec2;
  /** Normalized 0..1 power derived from drag length / maxDrag. */
  readonly power: number;
  /** Radians, direction the dish will travel. */
  readonly angle: number;
}

/** Immutable snapshot the engine hands to the renderer and HUD each frame. */
export interface GameState {
  readonly phase: GamePhase;
  readonly levelIndex: number;
  readonly level: LevelDefinition;
  readonly activeDishId: EntityId | null;
  readonly dishesRemaining: number;
  readonly tugsRemaining: number;
  readonly score: number;
  readonly deliveredTargetIds: readonly EntityId[];
  /** Slosh percent (0..SLOSH_MAX) keyed by liquid dish id. */
  readonly slosh: Readonly<Record<EntityId, number>>;
  readonly aim: AimState;
  readonly failReason: FailReason | null;
}

/* ------------------------------------------------------------------ */
/* Physics snapshot & events (PhysicsWorld → engine/renderer)          */
/* ------------------------------------------------------------------ */

/** Renderable pose of one body, decoupled from Matter.js types. */
export interface BodySnapshot {
  readonly id: EntityId;
  readonly role: 'dish' | 'obstacle' | 'hazard';
  readonly position: Vec2;
  readonly angle: number;
  readonly velocity: Vec2;
  readonly angularVelocity: number;
  readonly shape: Shape;
}

export interface CollisionEvent {
  readonly type: 'collision';
  readonly aId: EntityId;
  readonly bId: EntityId;
  /** Relative speed along the contact normal, used to scale audio and slosh. */
  readonly impactSpeed: number;
  readonly point: Vec2;
}

export interface ZoneEvent {
  readonly type: 'zone-enter' | 'zone-exit';
  readonly zoneId: EntityId;
  readonly zoneKind: SurfaceZoneKind;
  readonly dishId: EntityId;
}

export interface TargetEvent {
  readonly type: 'target-overlap';
  readonly targetId: EntityId;
  readonly dishId: EntityId;
  /** Speed of the dish while overlapping; engine checks settling. */
  readonly speed: number;
}

export interface FellOffEvent {
  readonly type: 'fell-off';
  readonly dishId: EntityId;
}

export type PhysicsEvent = CollisionEvent | ZoneEvent | TargetEvent | FellOffEvent;

export type PhysicsEventListener = (event: PhysicsEvent) => void;

/* ------------------------------------------------------------------ */
/* Slosh tracking                                                      */
/* ------------------------------------------------------------------ */

/** One per-step sample fed to SloshTracker for a liquid dish. */
export interface SloshSample {
  readonly dishId: EntityId;
  readonly velocity: Vec2;
  readonly angularVelocity: number;
  /** Time covered by this sample, in ms (normally FIXED_DT_MS). */
  readonly dtMs: number;
  /** Largest collision impactSpeed this step, or 0. */
  readonly impactSpeed: number;
}

export interface SloshTunables {
  /** Weight of linear jerk (Δacceleration / Δt) in the spill model. */
  readonly jerkWeight: number;
  /** Weight of angular velocity magnitude. */
  readonly angularWeight: number;
  /** Weight of collision impact. */
  readonly impactWeight: number;
  /** Percent drained per second when calm. */
  readonly settleRatePerSec: number;
}

/* ------------------------------------------------------------------ */
/* Input, rendering, audio, HUD: boundary interfaces                   */
/* ------------------------------------------------------------------ */

/** Commands the input layer emits; the engine never sees raw DOM events. */
export type InputCommand =
  | { readonly type: 'start' }
  | { readonly type: 'aim-update'; readonly drag: Vec2 }
  | { readonly type: 'aim-nudge'; readonly deltaAngle: number; readonly deltaPower: number }
  | { readonly type: 'launch' }
  | { readonly type: 'tug' }
  | { readonly type: 'restart-level' }
  | { readonly type: 'toggle-mute' };

/** Implemented by src/render/CanvasRenderer.ts. */
export interface Renderer {
  render(
    state: GameState,
    bodies: readonly BodySnapshot[],
    trajectoryPreview: readonly Vec2[],
    timeMs: number,
  ): void;
}

export type SoundCue =
  | 'launch'
  | 'thud'
  | 'clink'
  | 'splash'
  | 'tug'
  | 'success'
  | 'fail'
  | 'squelch';

/** Implemented by src/game/AudioManager.ts. Volume scales with intensity. */
export interface AudioPlayer {
  play(cue: SoundCue, intensity: number): void;
  setMuted(muted: boolean): void;
}

/** Implemented in main.ts against the DOM HUD. */
export interface HudSink {
  update(state: GameState): void;
  /** Politely announce a message via the aria-live status region. */
  announce(message: string, isFailure: boolean): void;
}

/* ------------------------------------------------------------------ */
/* Frame scheduling (implemented in main.ts)                           */
/* ------------------------------------------------------------------ */

/** Called once per animation frame with a monotonic timestamp in ms. */
export type FrameCallback = (timeMs: number) => void;

/** Abstraction over requestAnimationFrame so src/game/ never touches window. */
export interface FrameScheduler {
  request(callback: FrameCallback): number;
  cancel(handle: number): void;
}