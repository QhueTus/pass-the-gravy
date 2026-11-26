/**
 * CanvasRenderer.ts
 * HTML5 Canvas renderer for "Pass the Gravy: Tablecloth Tactics".
 *
 * RULES FOR THIS FILE
 * - This is the only module that draws. It may use the DOM (canvas, and an
 *   offscreen canvas for pattern tiles). src/game/ never imports it.
 * - It renders from GameState + BodySnapshot[] + trajectory dots only.
 * - Every position is a CENTER point (rects and circles are drawn centered).
 * - Meaning is never carried by color alone: patterns, glyphs and text
 *   captions accompany every color cue.
 *
 * SCALING
 * World units map to canvas pixels by canvas.width / table.worldWidth, so
 * main.ts may enlarge the canvas backing store (for example by
 * devicePixelRatio) without changing any game data.
 */

import { SLOSH_MAX } from '../types/game.types';
import type {
  BodySnapshot,
  DishDefinition,
  DishKind,
  EntityId,
  FailReason,
  FillPattern,
  GamePhase,
  GameState,
  Glyph,
  HazardDefinition,
  HazardKind,
  LevelDefinition,
  ObstacleDefinition,
  Renderer,
  Shape,
  Vec2,
} from '../types/game.types';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';

const COLOR = {
  floor: '#241913',
  wood: '#8a5a34',
  cloth: '#2f5d50',
  plate: '#f3e6cf',
  ink: '#1b1410',
  paper: '#fff7ea',
  accent: '#ffd166',
  danger: '#ff6b6b',
  safe: '#7bdf8a',
  band: '#c9a36a',
  panel: '#2a1f18',
} as const;

/** Effect durations in ms. */
const TARGET_FLASH_MS = 900;
const FELL_OFF_MARKER_MS = 1800;
const TUG_EFFECT_MS = 700;

/** Slosh display thresholds (percent). */
const SLOSH_SHAKE_START = 50;
const SLOSH_DANGER = 80;

/** Aim arrow geometry (world units). */
const ARROW_MIN_LENGTH = 36;
const ARROW_POWER_LENGTH = 84;
const MIN_PREVIEW_POWER = 0.05;

const HAZARD_CAPTIONS: Readonly<Record<HazardKind, string>> = {
  'toddler-hand': 'HAND',
  'wandering-cat': 'CAT',
  'swinging-ladle': 'LADLE',
};

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

function font(size: number, weight: 'normal' | 'bold' = 'normal'): string {
  return `${weight} ${size}px ${FONT_FAMILY}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** True for light fills (they get dark pattern ink). Unknown formats count as light. */
function isLightColor(color: string): boolean {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  const digits = match?.[1];
  if (digits === undefined) {
    return true;
  }
  const hex =
    digits.length === 3
      ? digits
          .split('')
          .map((char) => char + char)
          .join('')
      : digits;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
}

function inkFor(color: string): string {
  return isLightColor(color) ? COLOR.ink : COLOR.paper;
}

/** Radius of the circle that encloses a shape (for labels and meters). */
function shapeRadius(shape: Shape): number {
  return shape.type === 'circle' ? shape.radius : Math.hypot(shape.width, shape.height) / 2;
}

function isInsideRect(point: Vec2, center: Vec2, width: number, height: number): boolean {
  return Math.abs(point.x - center.x) <= width / 2 && Math.abs(point.y - center.y) <= height / 2;
}

/* ------------------------------------------------------------------ */
/* Internal types                                                      */
/* ------------------------------------------------------------------ */

interface TextOptions {
  readonly align?: CanvasTextAlign;
  readonly weight?: 'normal' | 'bold';
  readonly color?: string;
  readonly maxWidth?: number;
}

/** What the previous frame looked like, for change detection. */
interface PreviousFrame {
  readonly levelIndex: number;
  readonly phase: GamePhase;
  readonly tugsRemaining: number;
  readonly deliveredIds: ReadonlySet<EntityId>;
  readonly dishPositions: ReadonlyMap<EntityId, Vec2>;
}

interface FellOffMarker {
  readonly position: Vec2;
  readonly startMs: number;
}

interface OverlayContent {
  readonly glyph: Glyph | '✔' | '✖';
  readonly title: string;
  readonly lines: readonly string[];
}

type DishChipStatus = 'used' | 'now' | 'next';

/* ------------------------------------------------------------------ */
/* CanvasRenderer                                                      */
/* ------------------------------------------------------------------ */

export class CanvasRenderer implements Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  /** key = `${pattern}|${ink}`. null = pattern could not be built. */
  private readonly patternCache = new Map<string, CanvasPattern | null>();
  private clothPattern: CanvasPattern | null | undefined = undefined;

  private previous: PreviousFrame | null = null;
  private readonly targetFlashes = new Map<EntityId, number>();
  private fellOffMarkers: FellOffMarker[] = [];
  private tugStartMs: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('CanvasRenderer: a 2D canvas context is not available.');
    }
    this.canvas = canvas;
    this.ctx = context;
  }

  /* ----------------------------- Public API ----------------------------- */

  render(
    state: GameState,
    bodies: readonly BodySnapshot[],
    trajectoryPreview: readonly Vec2[],
    timeMs: number,
  ): void {
    const { canvas, ctx } = this;
    if (canvas.width === 0 || canvas.height === 0) {
      return;
    }

    this.trackChanges(state, bodies, timeMs);

    const scale = canvas.width / state.level.table.worldWidth;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    this.drawBackground(state.level);
    this.drawZones(state.level);
    this.drawHazardLanes(state.level);
    this.drawTargets(state, timeMs);
    this.drawBodies(state, bodies, timeMs);
    this.drawSlingshot(state);
    this.drawAim(state, trajectoryPreview);
    this.drawTugEffect(state.level, timeMs);
    this.drawFellOffMarkers(state.level, timeMs);
    this.drawTopBar(state);
    this.drawOverlay(state);
  }

  /* --------------------------- Change tracking -------------------------- */

  /**
   * Compares this frame with the last one to trigger one-shot effects.
   * A "reset" (new level, restart, retry) clears all effects instead.
   */
  private trackChanges(state: GameState, bodies: readonly BodySnapshot[], timeMs: number): void {
    const dishPositions = new Map<EntityId, Vec2>();
    for (const body of bodies) {
      if (body.role === 'dish') {
        dishPositions.set(body.id, body.position);
      }
    }

    const previous = this.previous;
    const idle = (phase: GamePhase): boolean =>
      phase === 'menu' || phase === 'levelComplete' || phase === 'gameOver';

    const isReset =
      previous === null ||
      previous.levelIndex !== state.levelIndex ||
      (idle(previous.phase) && state.phase === 'aiming') ||
      state.tugsRemaining > previous.tugsRemaining ||
      state.deliveredTargetIds.length < previous.deliveredIds.size;

    if (isReset) {
      this.targetFlashes.clear();
      this.fellOffMarkers = [];
      this.tugStartMs = null;
    } else {
      for (const targetId of state.deliveredTargetIds) {
        if (!previous.deliveredIds.has(targetId)) {
          this.targetFlashes.set(targetId, timeMs);
        }
      }
      if (state.tugsRemaining < previous.tugsRemaining) {
        this.tugStartMs = timeMs;
      }
      for (const [dishId, position] of previous.dishPositions) {
        if (dishPositions.has(dishId)) {
          continue;
        }
        if (!this.wasDelivered(state, position)) {
          this.fellOffMarkers.push({ position, startMs: timeMs });
        }
      }
    }

    this.previous = {
      levelIndex: state.levelIndex,
      phase: state.phase,
      tugsRemaining: state.tugsRemaining,
      deliveredIds: new Set<EntityId>(state.deliveredTargetIds),
      dishPositions,
    };
  }

  /** A vanished dish was delivered when it last sat inside a delivered target. */
  private wasDelivered(state: GameState, lastPosition: Vec2): boolean {
    return state.level.targets.some(
      (target) =>
        state.deliveredTargetIds.includes(target.id) &&
        isInsideRect(lastPosition, target.position, target.width, target.height),
    );
  }

  /* ------------------------------ Patterns ------------------------------ */

  private getPattern(pattern: FillPattern, ink: string): CanvasPattern | null {
    if (pattern === 'solid') {
      return null;
    }
    const key = `${pattern}|${ink}`;
    const cached = this.patternCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const created = this.buildPattern(pattern, ink);
    this.patternCache.set(key, created);
    return created;
  }

  private buildPattern(pattern: FillPattern, ink: string): CanvasPattern | null {
    let size = 10;
    if (pattern === 'diagonal-stripes') {
      size = 12;
    } else if (pattern === 'horizontal-lines') {
      size = 8;
    }
    const tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;
    const tileCtx = tile.getContext('2d');
    if (tileCtx === null) {
      return null;
    }
    tileCtx.strokeStyle = ink;
    tileCtx.fillStyle = ink;

    switch (pattern) {
      case 'solid':
        return null;
      case 'diagonal-stripes':
        tileCtx.lineWidth = 2.5;
        tileCtx.beginPath();
        tileCtx.moveTo(0, size);
        tileCtx.lineTo(size, 0);
        tileCtx.moveTo(-size / 2, size / 2);
        tileCtx.lineTo(size / 2, -size / 2);
        tileCtx.moveTo(size / 2, size * 1.5);
        tileCtx.lineTo(size * 1.5, size / 2);
        tileCtx.stroke();
        break;
      case 'dots':
        tileCtx.beginPath();
        tileCtx.arc(size / 2, size / 2, 2, 0, Math.PI * 2);
        tileCtx.fill();
        break;
      case 'crosshatch':
        tileCtx.lineWidth = 1.3;
        tileCtx.beginPath();
        tileCtx.moveTo(0, 0);
        tileCtx.lineTo(size, size);
        tileCtx.moveTo(0, size);
        tileCtx.lineTo(size, 0);
        tileCtx.stroke();
        break;
      case 'horizontal-lines':
        tileCtx.lineWidth = 2;
        tileCtx.beginPath();
        tileCtx.moveTo(0, size / 2);
        tileCtx.lineTo(size, size / 2);
        tileCtx.stroke();
        break;
    }
    return this.ctx.createPattern(tile, 'repeat');
  }

  private getClothPattern(): CanvasPattern | null {
    if (this.clothPattern !== undefined) {
      return this.clothPattern;
    }
    const size = 48;
    const tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;
    const tileCtx = tile.getContext('2d');
    if (tileCtx === null) {
      this.clothPattern = null;
      return null;
    }
    tileCtx.fillStyle = COLOR.cloth;
    tileCtx.fillRect(0, 0, size, size);
    tileCtx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    tileCtx.fillRect(0, 0, size / 2, size);
    tileCtx.fillRect(0, 0, size, size / 2);
    this.clothPattern = this.ctx.createPattern(tile, 'repeat');
    return this.clothPattern;
  }

  /* ------------------------------ Primitives ---------------------------- */

  /** Adds a centered rect or circle path (no fill or stroke). */
  private tracePath(shape: Shape): void {
    const { ctx } = this;
    ctx.beginPath();
    if (shape.type === 'rect') {
      ctx.rect(-shape.width / 2, -shape.height / 2, shape.width, shape.height);
    } else {
      ctx.arc(0, 0, shape.radius, 0, Math.PI * 2);
    }
  }

  /** Fills the current path with a color, then a pattern overlay in contrasting ink. */
  private fillWithPattern(
    color: string,
    pattern: FillPattern,
    alpha = 1,
    patternAlpha = 0.6,
  ): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fill();
    const tile = this.getPattern(pattern, inkFor(color));
    if (tile !== null) {
      ctx.globalAlpha = patternAlpha;
      ctx.fillStyle = tile;
      ctx.fill();
    }
    ctx.restore();
  }

  /** Strokes the current path with a light halo under a dark outline. */
  private outlineShape(width = 3): void {
    const { ctx } = this;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineWidth = width + 2.5;
    ctx.strokeStyle = COLOR.paper;
    ctx.stroke();
    ctx.lineWidth = width;
    ctx.strokeStyle = COLOR.ink;
    ctx.stroke();
    ctx.restore();
  }

  private drawText(text: string, x: number, y: number, size: number, options: TextOptions = {}): void {
    const { ctx } = this;
    ctx.save();
    ctx.font = font(size, options.weight ?? 'normal');
    ctx.textAlign = options.align ?? 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, size / 3.5);
    ctx.strokeStyle = COLOR.ink;
    ctx.fillStyle = options.color ?? COLOR.paper;
    if (options.maxWidth !== undefined) {
      ctx.strokeText(text, x, y, options.maxWidth);
      ctx.fillText(text, x, y, options.maxWidth);
    } else {
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
    ctx.restore();
  }

  /** Straight arrow with a dark outline pass under a colored pass. */
  private drawArrow(from: Vec2, to: Vec2, headSize: number, lineWidth: number, color: string): void {
    const { ctx } = this;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const baseX = to.x - Math.cos(angle) * headSize;
    const baseY = to.y - Math.sin(angle) * headSize;
    const wingX = Math.cos(angle + Math.PI / 2) * headSize * 0.6;
    const wingY = Math.sin(angle + Math.PI / 2) * headSize * 0.6;

    const passes: ReadonlyArray<{ readonly extra: number; readonly style: string }> = [
      { extra: 4, style: COLOR.ink },
      { extra: 0, style: color },
    ];
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const pass of passes) {
      ctx.strokeStyle = pass.style;
      ctx.fillStyle = pass.style;
      ctx.lineWidth = lineWidth + pass.extra;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(baseX, baseY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(baseX + wingX, baseY + wingY);
      ctx.lineTo(baseX - wingX, baseY - wingY);
      ctx.closePath();
      ctx.fill();
      if (pass.extra > 0) {
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ------------------------------ Scene layers -------------------------- */

  private drawBackground(level: LevelDefinition): void {
    const { ctx } = this;
    const { worldWidth, worldHeight, top } = level.table;

    ctx.fillStyle = COLOR.floor;
    ctx.fillRect(0, 0, worldWidth, worldHeight);

    // Wooden table rim, then the gingham tablecloth on top of it.
    ctx.fillStyle = COLOR.wood;
    ctx.fillRect(top.x - 12, top.y - 12, top.width + 24, top.height + 24);
    ctx.fillStyle = this.getClothPattern() ?? COLOR.cloth;
    ctx.fillRect(top.x, top.y, top.width, top.height);

    ctx.save();
    ctx.strokeStyle = COLOR.ink;
    ctx.lineWidth = 3;
    ctx.strokeRect(top.x, top.y, top.width, top.height);
    ctx.restore();
  }

  private drawZones(level: LevelDefinition): void {
    const { ctx } = this;
    for (const zone of level.zones) {
      const shape: Shape = { type: 'rect', width: zone.width, height: zone.height };
      const caption = zone.kind === 'cranberry-spill' ? 'SLIPPERY' : 'STICKY';

      ctx.save();
      ctx.translate(zone.position.x, zone.position.y);
      this.tracePath(shape);
      this.fillWithPattern(zone.color, zone.pattern, 0.85, 0.7);
      ctx.setLineDash([8, 5]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = COLOR.ink;
      ctx.stroke();
      ctx.restore();

      this.drawText(zone.glyph, zone.position.x, zone.position.y - 6, 26);
      this.drawText(caption, zone.position.x, zone.position.y + zone.height / 2 - 11, 12, {
        weight: 'bold',
        maxWidth: zone.width - 8,
      });
    }
  }

  /** Dashed sweep line with end ticks, so players can time their shots. */
  private drawHazardLanes(level: LevelDefinition): void {
    const { ctx } = this;
    for (const hazard of level.hazards) {
      const axisLength = Math.hypot(hazard.motion.axis.x, hazard.motion.axis.y);
      if (axisLength === 0) {
        continue;
      }
      const ax = hazard.motion.axis.x / axisLength;
      const ay = hazard.motion.axis.y / axisLength;
      const reach = hazard.motion.amplitude;
      const start: Vec2 = { x: hazard.origin.x - ax * reach, y: hazard.origin.y - ay * reach };
      const end: Vec2 = { x: hazard.origin.x + ax * reach, y: hazard.origin.y + ay * reach };

      ctx.save();
      ctx.strokeStyle = COLOR.accent;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const point of [start, end]) {
        ctx.beginPath();
        ctx.moveTo(point.x - ay * 8, point.y + ax * 8);
        ctx.lineTo(point.x + ay * 8, point.y - ax * 8);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawTargets(state: GameState, timeMs: number): void {
    const { ctx } = this;
    const labelByKind = new Map<DishKind, string>();
    for (const dish of state.level.dishes) {
      labelByKind.set(dish.kind, dish.label);
    }

    for (const target of state.level.targets) {
      const delivered = state.deliveredTargetIds.includes(target.id);
      const shape: Shape = { type: 'rect', width: target.width, height: target.height };
      const wanted = labelByKind.get(target.requestedDish) ?? target.requestedDish;

      ctx.save();
      ctx.translate(target.position.x, target.position.y);

      // A cream place mat keeps the pattern readable on the green cloth.
      this.tracePath(shape);
      ctx.fillStyle = COLOR.plate;
      ctx.globalAlpha = 0.92;
      ctx.fill();
      ctx.globalAlpha = 1;
      this.fillWithPattern(target.color, target.pattern, delivered ? 0.9 : 0.5, 0.5);
      ctx.lineJoin = 'round';
      ctx.lineWidth = 6;
      ctx.strokeStyle = COLOR.ink;
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.strokeStyle = delivered ? COLOR.accent : COLOR.paper;
      ctx.stroke();

      const flashStart = this.targetFlashes.get(target.id);
      if (flashStart !== undefined) {
        const progress = (timeMs - flashStart) / TARGET_FLASH_MS;
        if (progress >= 0 && progress < 1) {
          ctx.globalAlpha = (1 - progress) * 0.6;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(-target.width / 2, -target.height / 2, target.width, target.height);
          ctx.globalAlpha = 1 - progress;
          ctx.lineWidth = 4;
          ctx.strokeStyle = COLOR.accent;
          const grow = progress * 34;
          ctx.strokeRect(
            -target.width / 2 - grow,
            -target.height / 2 - grow,
            target.width + grow * 2,
            target.height + grow * 2,
          );
        }
      }
      ctx.restore();

      this.drawText(target.relativeName, target.position.x, target.position.y - target.height / 2 + 14, 13, {
        weight: 'bold',
        maxWidth: target.width - 8,
      });
      if (delivered) {
        this.drawText('✔ Fed!', target.position.x, target.position.y + 6, 24, {
          weight: 'bold',
          color: COLOR.accent,
        });
      } else {
        this.drawText(target.glyph, target.position.x, target.position.y + 2, 22);
        this.drawText(`wants ${wanted}`, target.position.x, target.position.y + target.height / 2 - 12, 11, {
          maxWidth: target.width - 8,
        });
      }
    }
  }

  private drawBodies(state: GameState, bodies: readonly BodySnapshot[], timeMs: number): void {
    const dishById = new Map<EntityId, DishDefinition>();
    for (const dish of state.level.dishes) {
      dishById.set(dish.id, dish);
    }
    const obstacleById = new Map<EntityId, ObstacleDefinition>();
    for (const obstacle of state.level.obstacles) {
      obstacleById.set(obstacle.id, obstacle);
    }
    const hazardById = new Map<EntityId, HazardDefinition>();
    for (const hazard of state.level.hazards) {
      hazardById.set(hazard.id, hazard);
    }

    // Draw order: obstacles, hazards, then dishes on top.
    for (const body of bodies) {
      if (body.role !== 'obstacle') continue;
      const def = obstacleById.get(body.id);
      if (def !== undefined) this.drawObstacle(body, def);
    }
    for (const body of bodies) {
      if (body.role !== 'hazard') continue;
      const def = hazardById.get(body.id);
      if (def !== undefined) this.drawHazard(body, def);
    }
    for (const body of bodies) {
      if (body.role !== 'dish') continue;
      const def = dishById.get(body.id);
      if (def !== undefined) this.drawDish(body, def, state, timeMs);
    }
  }

  private drawObstacle(body: BodySnapshot, def: ObstacleDefinition): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    ctx.rotate(body.angle);
    this.tracePath(body.shape);
    this.fillWithPattern(def.color, def.pattern, 1, 0.6);
    this.outlineShape(3);
    ctx.restore();
  }

  private drawHazard(body: BodySnapshot, def: HazardDefinition): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    ctx.rotate(body.angle);
    this.tracePath(body.shape);
    this.fillWithPattern(def.color, def.pattern, 0.95, 0.7);
    this.outlineShape(3);
    ctx.restore();

    this.drawText(def.glyph, body.position.x, body.position.y - 8, 20);
    this.drawText(HAZARD_CAPTIONS[def.kind], body.position.x, body.position.y + 12, 11, {
      weight: 'bold',
    });
  }

  private drawDish(body: BodySnapshot, def: DishDefinition, state: GameState, timeMs: number): void {
    const { ctx } = this;
    const slosh = state.slosh[body.id] ?? 0;
    const shake =
      def.isLiquid && slosh >= SLOSH_SHAKE_START
        ? ((slosh - SLOSH_SHAKE_START) / (SLOSH_MAX - SLOSH_SHAKE_START)) * 2.5
        : 0;
    const x = body.position.x + shake * Math.sin(timeMs * 0.045);
    const y = body.position.y + shake * Math.cos(timeMs * 0.057);
    const radius = shapeRadius(body.shape);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(body.angle);
    this.tracePath(body.shape);
    this.fillWithPattern(def.color, def.pattern, 1, 0.6);
    this.outlineShape(2.5);

    // A notch on round dishes makes their rotation visible.
    if (body.shape.type === 'circle') {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(body.shape.radius, 0);
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLOR.ink;
      ctx.stroke();
    }

    if (def.isLiquid && slosh >= SLOSH_DANGER) {
      this.tracePath(body.shape);
      ctx.globalAlpha = 0.25 + 0.2 * Math.sin(timeMs * 0.012);
      ctx.fillStyle = COLOR.danger;
      ctx.fill();
    }
    ctx.restore();

    this.drawText(def.glyph, x, y, 16);

    if (body.id === state.activeDishId && state.phase === 'aiming') {
      ctx.save();
      ctx.strokeStyle = COLOR.accent;
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 5]);
      ctx.lineDashOffset = -timeMs / 60;
      ctx.beginPath();
      ctx.arc(x, y, radius + 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (def.isLiquid && (slosh > 0.5 || body.id === state.activeDishId)) {
      this.drawSloshMeter(x, y - radius - 18, slosh);
    }
  }

  /** Small bar with a percent label; stripes and ⚠ mark the danger zone. */
  private drawSloshMeter(centerX: number, centerY: number, slosh: number): void {
    const { ctx } = this;
    const width = 48;
    const height = 8;
    const percent = clamp(slosh, 0, SLOSH_MAX);
    const fraction = percent / SLOSH_MAX;
    let fillColor: string = COLOR.safe;
    if (percent >= SLOSH_DANGER) {
      fillColor = COLOR.danger;
    } else if (percent >= SLOSH_SHAKE_START) {
      fillColor = COLOR.accent;
    }

    ctx.save();
    ctx.translate(centerX - width / 2, centerY - height / 2);
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.fillStyle = COLOR.ink;
    ctx.fill();
    ctx.beginPath();
    ctx.rect(0, 0, width * fraction, height);
    this.fillWithPattern(
      fillColor,
      percent >= SLOSH_DANGER ? 'diagonal-stripes' : 'solid',
      1,
      0.8,
    );
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLOR.paper;
    ctx.stroke();
    ctx.restore();

    const prefix = percent >= SLOSH_DANGER ? '⚠ ' : '';
    this.drawText(`${prefix}${Math.round(percent)}%`, centerX, centerY - 11, 11, { weight: 'bold' });
  }

  private drawSlingshot(state: GameState): void {
    if (state.phase === 'menu') {
      return;
    }
    const { ctx } = this;
    const { anchor } = state.level.slingshot;

    ctx.save();
    ctx.strokeStyle = COLOR.paper;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, 34, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    for (const offset of [-30, 30]) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y + offset, 6, 0, Math.PI * 2);
      ctx.fillStyle = COLOR.wood;
      ctx.fill();
      this.outlineShape(2);
      ctx.restore();
    }
    this.drawText('SLINGSHOT', anchor.x, anchor.y - 52, 11, { weight: 'bold' });
  }

  private drawAim(state: GameState, trajectory: readonly Vec2[]): void {
    if (!state.aim.active) {
      return;
    }
    const { ctx } = this;
    const { anchor } = state.level.slingshot;
    const { aim } = state;

    // Elastic bands to the pulled-back point.
    const pull: Vec2 = { x: anchor.x + aim.drag.x, y: anchor.y + aim.drag.y };
    ctx.save();
    ctx.lineCap = 'round';
    for (const offset of [-30, 30]) {
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y + offset);
      ctx.lineTo(pull.x, pull.y);
      ctx.lineWidth = 7;
      ctx.strokeStyle = COLOR.ink;
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.strokeStyle = COLOR.band;
      ctx.stroke();
    }
    ctx.restore();
    if (aim.power > MIN_PREVIEW_POWER) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(pull.x, pull.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = COLOR.paper;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = COLOR.ink;
      ctx.stroke();
      ctx.restore();
    }

    // Trajectory dots, shrinking and fading with distance.
    ctx.save();
    trajectory.forEach((point, index) => {
      const radius = Math.max(2, 5 - index * 0.15);
      ctx.globalAlpha = Math.max(0.35, 1 - index * 0.04);
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = COLOR.paper;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = COLOR.ink;
      ctx.stroke();
    });
    ctx.restore();

    // Launch direction arrow, scaled by power.
    const length = ARROW_MIN_LENGTH + ARROW_POWER_LENGTH * aim.power;
    const tip: Vec2 = {
      x: anchor.x + Math.cos(aim.angle) * length,
      y: anchor.y + Math.sin(aim.angle) * length,
    };
    this.drawArrow(anchor, tip, 16, 5, COLOR.accent);

    const degrees = Math.round((aim.angle * 180) / Math.PI);
    const percent = Math.round(aim.power * 100);
    this.drawText(`Angle ${degrees}° · Power ${percent}%`, anchor.x, anchor.y + 70, 14, {
      weight: 'bold',
    });
  }

  private drawTugEffect(level: LevelDefinition, timeMs: number): void {
    const startMs = this.tugStartMs;
    if (startMs === null) {
      return;
    }
    const progress = (timeMs - startMs) / TUG_EFFECT_MS;
    if (progress < 0 || progress >= 1) {
      if (progress >= 1) {
        this.tugStartMs = null;
      }
      return;
    }
    const { top } = level.table;
    const lanes = 5;
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 1 - progress;
    for (let lane = 0; lane < lanes; lane += 1) {
      const y = top.y + ((lane + 0.5) * top.height) / lanes;
      const fromX = top.x + 20 + progress * top.width * 0.55;
      this.drawArrow({ x: fromX, y }, { x: fromX + 140, y }, 18, 5, COLOR.paper);
    }
    ctx.restore();
    this.drawText('TABLECLOTH TUG!', top.x + top.width / 2, top.y + 28, 26, {
      weight: 'bold',
      color: COLOR.accent,
    });
  }

  private drawFellOffMarkers(level: LevelDefinition, timeMs: number): void {
    const { worldWidth, worldHeight } = level.table;
    this.fellOffMarkers = this.fellOffMarkers.filter(
      (marker) => timeMs - marker.startMs < FELL_OFF_MARKER_MS,
    );
    const { ctx } = this;
    for (const marker of this.fellOffMarkers) {
      const age = timeMs - marker.startMs;
      const fade = clamp((FELL_OFF_MARKER_MS - age) / 600, 0, 1);
      const x = clamp(marker.position.x, 30, worldWidth - 30);
      const y = clamp(marker.position.y, 30, worldHeight - 30);

      ctx.save();
      ctx.globalAlpha = fade;
      ctx.beginPath();
      ctx.arc(x, y, 17, 0, Math.PI * 2);
      ctx.fillStyle = COLOR.danger;
      ctx.fill();
      this.outlineShape(3);
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = fade;
      this.drawText('✖', x, y, 20, { weight: 'bold', color: COLOR.ink });
      this.drawText('Fell off!', x, y + 30, 14, { weight: 'bold' });
      ctx.restore();
    }
  }

  /* --------------------------- Top bar and overlays --------------------- */

  private drawTopBar(state: GameState): void {
    const { level } = state;
    const { worldWidth } = level.table;

    this.drawText(`Level ${level.id}: ${level.name}`, 24, 30, 22, { align: 'left', weight: 'bold' });
    this.drawText(`Score ${state.score}`, worldWidth - 24, 30, 22, { align: 'right', weight: 'bold' });
    this.drawText(
      `Tugs ${state.tugsRemaining}  ·  Dishes left ${state.dishesRemaining}`,
      worldWidth - 24,
      62,
      15,
      { align: 'right' },
    );

    const activeIndex = level.dishes.findIndex((dish) => dish.id === state.activeDishId);
    const chipWidth = 126;
    const chipHeight = 32;
    const chipTop = 72;
    const gap = 10;

    level.dishes.forEach((dish, index) => {
      let status: DishChipStatus;
      if (activeIndex < 0) {
        status = state.phase === 'menu' ? 'next' : 'used';
      } else if (index < activeIndex) {
        status = 'used';
      } else if (index === activeIndex) {
        status = 'now';
      } else {
        status = 'next';
      }

      const left = 24 + index * (chipWidth + gap);
      const { ctx } = this;
      ctx.save();
      ctx.globalAlpha = status === 'used' ? 0.4 : 1;
      ctx.translate(left + chipWidth / 2, chipTop + chipHeight / 2);
      ctx.beginPath();
      ctx.rect(-chipWidth / 2, -chipHeight / 2, chipWidth, chipHeight);
      this.fillWithPattern(dish.color, dish.pattern, 1, 0.55);
      ctx.lineJoin = 'round';
      ctx.lineWidth = status === 'now' ? 7 : 5;
      ctx.strokeStyle = COLOR.ink;
      ctx.stroke();
      ctx.lineWidth = status === 'now' ? 4 : 1.5;
      ctx.strokeStyle = status === 'now' ? COLOR.accent : COLOR.paper;
      ctx.stroke();
      ctx.restore();

      const prefix = status === 'now' ? '▶ ' : '';
      const caption =
        status === 'used' ? 'used' : status === 'next' ? 'next' : state.phase === 'simulating' ? 'in play' : 'ready';
      ctx.save();
      ctx.globalAlpha = status === 'used' ? 0.6 : 1;
      this.drawText(`${prefix}${dish.label}`, left + chipWidth / 2, chipTop + chipHeight / 2, 13, {
        weight: 'bold',
        maxWidth: chipWidth - 8,
      });
      this.drawText(caption, left + chipWidth / 2, chipTop + chipHeight + 14, 11);
      ctx.restore();
    });
  }

  private overlayContent(state: GameState): OverlayContent | null {
    switch (state.phase) {
      case 'menu':
        return {
          glyph: '★',
          title: 'Pass the Gravy',
          lines: [
            'Tablecloth Tactics',
            'Feed every relative the dish they asked for.',
            'Drag back from the dish and release, or use the arrow keys and Enter.',
            'Space pulls the tablecloth. Do not spill. Do not drop.',
            'Press the Start button to begin.',
          ],
        };
      case 'levelComplete':
        return {
          glyph: '✔',
          title: `Level ${state.level.id} complete!`,
          lines: [`Score: ${state.score}`, 'Press the Start button to continue.'],
        };
      case 'gameOver':
        return {
          glyph: '✖',
          title: 'Level failed',
          lines: [this.failText(state.failReason), 'Press the Start button to retry.'],
        };
      case 'aiming':
      case 'simulating':
        return null;
    }
  }

  private failText(reason: FailReason | null): string {
    switch (reason) {
      case 'spill':
        return 'Spilled! The liquid went everywhere.';
      case 'fell-off-table':
        return 'A dish somebody needed fell off the table.';
      case 'out-of-dishes':
        return 'Out of dishes while someone is still hungry.';
      case null:
        return 'Better luck next time.';
    }
  }

  private drawOverlay(state: GameState): void {
    const content = this.overlayContent(state);
    if (content === null) {
      return;
    }
    const { ctx } = this;
    const { worldWidth, worldHeight } = state.level.table;
    const centerX = worldWidth / 2;
    const centerY = worldHeight / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(14, 9, 6, 0.8)';
    ctx.fillRect(0, 0, worldWidth, worldHeight);

    const lineHeight = 30;
    const panelWidth = 660;
    const panelHeight = 120 + content.lines.length * lineHeight;
    const left = centerX - panelWidth / 2;
    const top = centerY - panelHeight / 2;

    ctx.fillStyle = COLOR.panel;
    ctx.fillRect(left, top, panelWidth, panelHeight);
    ctx.lineWidth = 4;
    ctx.strokeStyle = COLOR.accent;
    ctx.strokeRect(left, top, panelWidth, panelHeight);
    ctx.restore();

    this.drawText(`${content.glyph} ${content.title}`, centerX, top + 52, 40, {
      weight: 'bold',
      color: COLOR.accent,
      maxWidth: panelWidth - 40,
    });
    content.lines.forEach((line, index) => {
      this.drawText(line, centerX, top + 104 + index * lineHeight, 18, {
        maxWidth: panelWidth - 40,
      });
    });
  }
}