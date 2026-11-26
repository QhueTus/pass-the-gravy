/**
 * levels.ts
 * Declarative level definitions for "Pass the Gravy: Tablecloth Tactics".
 *
 * RULES FOR THIS FILE
 * - Data and pure helper functions only. No DOM, no window, no Matter.js.
 * - All coordinates are world units on a 960 x 540 playfield (+y is down).
 * - Imports come from src/types/game.types.ts only.
 */

import type {
  DishDefinition,
  DishKind,
  HazardDefinition,
  LevelDefinition,
  ObstacleDefinition,
  SlingshotDefinition,
  SurfaceZoneDefinition,
  TableDefinition,
  TargetDefinition,
  Vec2,
} from '../types/game.types';

/* ------------------------------------------------------------------ */
/* Shared constants                                                    */
/* ------------------------------------------------------------------ */

const WORLD_WIDTH = 960;
const WORLD_HEIGHT = 540;

/** Table top used by every level (dishes leaving it count as fallen off). */
const TABLE: TableDefinition = {
  worldWidth: WORLD_WIDTH,
  worldHeight: WORLD_HEIGHT,
  top: { x: 40, y: 140, width: 880, height: 360 },
  surfaceFriction: 0.3,
  baseFrictionAir: 0.02,
};

/** Slingshot shared by every level. Drag back from the anchor to aim. */
const SLINGSHOT: SlingshotDefinition = {
  anchor: { x: 130, y: 400 },
  maxDrag: 120,
  powerScale: 0.14,
};

const MAX_TUGS = 2;

/* ------------------------------------------------------------------ */
/* Dish templates                                                      */
/* ------------------------------------------------------------------ */

/** Everything about a dish kind except its per-level id and start position. */
type DishTemplate = Omit<DishDefinition, 'id' | 'startPosition'>;

/**
 * One template per dish kind. Liquid dishes are lighter and spill-prone;
 * the turkey platter is heavy and low-friction so it plows through.
 * Each kind has a distinct pattern so dishes are distinguishable without color.
 */
const DISH_TEMPLATES: Readonly<Record<DishKind, DishTemplate>> = {
  'gravy-boat': {
    kind: 'gravy-boat',
    label: 'Gravy boat',
    shape: { type: 'rect', width: 56, height: 28 },
    density: 0.0015,
    restitution: 0.3,
    friction: 0.4,
    isLiquid: true,
    sloshSensitivity: 1.3,
    pattern: 'solid',
    glyph: '★',
    color: '#c58b4e',
  },
  'cranberry-bowl': {
    kind: 'cranberry-bowl',
    label: 'Cranberry bowl',
    shape: { type: 'circle', radius: 22 },
    density: 0.0018,
    restitution: 0.25,
    friction: 0.35,
    isLiquid: true,
    sloshSensitivity: 1.0,
    pattern: 'dots',
    glyph: '★',
    color: '#b3203a',
  },
  'turkey-platter': {
    kind: 'turkey-platter',
    label: 'Turkey platter',
    shape: { type: 'rect', width: 80, height: 36 },
    density: 0.004,
    restitution: 0.15,
    friction: 0.25,
    isLiquid: false,
    sloshSensitivity: 1,
    pattern: 'crosshatch',
    glyph: '★',
    color: '#d9a066',
  },
  'roll-basket': {
    kind: 'roll-basket',
    label: 'Roll basket',
    shape: { type: 'circle', radius: 24 },
    density: 0.0012,
    restitution: 0.45,
    friction: 0.5,
    isLiquid: false,
    sloshSensitivity: 1,
    pattern: 'horizontal-lines',
    glyph: '★',
    color: '#e8c07a',
  },
  'pie-tin': {
    kind: 'pie-tin',
    label: 'Pie tin',
    shape: { type: 'circle', radius: 20 },
    density: 0.001,
    restitution: 0.5,
    friction: 0.3,
    isLiquid: false,
    sloshSensitivity: 1,
    pattern: 'diagonal-stripes',
    glyph: '★',
    color: '#d98c3f',
  },
};

/** Builds a level-specific dish from a template. */
function makeDish(levelId: number, kind: DishKind, orderIndex: number, start: Vec2): DishDefinition {
  const template = DISH_TEMPLATES[kind];
  return {
    ...template,
    id: `l${levelId}-dish-${orderIndex}-${kind}`,
    startPosition: start,
  };
}

/** Builds the ordered dish list for a level; every dish starts at the anchor. */
function makeDishQueue(levelId: number, kinds: readonly DishKind[]): readonly DishDefinition[] {
  return kinds.map((kind, index) => makeDish(levelId, kind, index, SLINGSHOT.anchor));
}

/* ------------------------------------------------------------------ */
/* Zone, obstacle, and target factories                                */
/* ------------------------------------------------------------------ */

function cranberrySpill(id: string, x: number, y: number, width: number, height: number): SurfaceZoneDefinition {
  return {
    id,
    kind: 'cranberry-spill',
    label: 'Spilled cranberry sauce (slippery)',
    position: { x, y },
    width,
    height,
    pattern: 'diagonal-stripes',
    glyph: '❄',
    color: '#c2185b',
  };
}

function mashedPotato(id: string, x: number, y: number, width: number, height: number): SurfaceZoneDefinition {
  return {
    id,
    kind: 'mashed-potato',
    label: 'Mashed potato mound (sticky)',
    position: { x, y },
    width,
    height,
    pattern: 'dots',
    glyph: '●',
    color: '#f2e3b3',
  };
}

function candlestick(id: string, x: number, y: number): ObstacleDefinition {
  return {
    id,
    label: 'Candlestick',
    shape: { type: 'circle', radius: 16 },
    position: { x, y },
    angle: 0,
    pattern: 'solid',
    color: '#c9b037',
  };
}

function saltShaker(id: string, x: number, y: number, angle: number): ObstacleDefinition {
  return {
    id,
    label: 'Salt shaker',
    shape: { type: 'rect', width: 36, height: 14 },
    position: { x, y },
    angle,
    pattern: 'horizontal-lines',
    color: '#dfe6ee',
  };
}

function relative(
  id: string,
  relativeName: string,
  requestedDish: DishKind,
  x: number,
  y: number,
  points: number,
): TargetDefinition {
  return {
    id,
    relativeName,
    position: { x, y },
    width: 110,
    height: 90,
    requestedDish,
    settleMs: 600,
    points,
    pattern: 'horizontal-lines',
    glyph: '♥',
    color: '#7bc67b',
  };
}

function toddlerHand(
  id: string,
  origin: Vec2,
  amplitude: number,
  frequencyHz: number,
  phase: number,
): HazardDefinition {
  return {
    id,
    kind: 'toddler-hand',
    label: "Toddler's hand sweeping across the table",
    shape: { type: 'rect', width: 40, height: 80 },
    origin,
    motion: { kind: 'sine', axis: { x: 0, y: 1 }, amplitude, frequencyHz, phase },
    pattern: 'crosshatch',
    glyph: '⚠',
    color: '#ff8a65',
  };
}

function wanderingCat(
  id: string,
  origin: Vec2,
  amplitude: number,
  frequencyHz: number,
  phase: number,
): HazardDefinition {
  return {
    id,
    kind: 'wandering-cat',
    label: 'Cat prowling along the table',
    shape: { type: 'rect', width: 90, height: 40 },
    origin,
    motion: { kind: 'sine', axis: { x: 1, y: 0 }, amplitude, frequencyHz, phase },
    pattern: 'crosshatch',
    glyph: '⚠',
    color: '#9575cd',
  };
}

/* ------------------------------------------------------------------ */
/* Level 1: "Warm-Up Round" (static table, introduces both zones)      */
/* ------------------------------------------------------------------ */

const LEVEL_1: LevelDefinition = {
  id: 1,
  name: 'Warm-Up Round',
  briefing:
    'Level 1, Warm-Up Round. Aunt Marge wants the gravy boat and Uncle Bob wants the rolls. ' +
    'Cranberry spills are slippery and mashed potato is sticky. Drag to aim, or use the arrow keys.',
  table: TABLE,
  slingshot: SLINGSHOT,
  dishes: makeDishQueue(1, ['gravy-boat', 'roll-basket']),
  obstacles: [
    candlestick('l1-candle-a', 480, 250),
    saltShaker('l1-salt-a', 650, 420, 0.4),
  ],
  zones: [
    cranberrySpill('l1-cranberry-a', 420, 400, 160, 80),
    mashedPotato('l1-potato-a', 610, 250, 120, 90),
  ],
  hazards: [],
  targets: [
    relative('l1-target-marge', 'Aunt Marge', 'gravy-boat', 820, 260, 100),
    relative('l1-target-bob', 'Uncle Bob', 'roll-basket', 820, 420, 100),
  ],
  maxTugs: MAX_TUGS,
};

/* ------------------------------------------------------------------ */
/* Level 2: "Little Hands" (toddler's hand sweeps the middle lane)     */
/* ------------------------------------------------------------------ */

const LEVEL_2: LevelDefinition = {
  id: 2,
  name: 'Little Hands',
  briefing:
    "Level 2, Little Hands. A toddler's hand sweeps up and down the middle of the table. " +
    'Time your shots, or use a Tablecloth Tug to nudge things along. Three relatives are waiting.',
  table: TABLE,
  slingshot: SLINGSHOT,
  dishes: makeDishQueue(2, ['cranberry-bowl', 'turkey-platter', 'pie-tin']),
  obstacles: [
    candlestick('l2-candle-a', 380, 210),
    candlestick('l2-candle-b', 380, 440),
    saltShaker('l2-salt-a', 700, 330, -0.3),
  ],
  zones: [
    cranberrySpill('l2-cranberry-a', 290, 310, 140, 100),
    mashedPotato('l2-potato-a', 680, 200, 120, 80),
    cranberrySpill('l2-cranberry-b', 680, 450, 140, 70),
  ],
  hazards: [toddlerHand('l2-hand-a', { x: 520, y: 320 }, 130, 0.35, 0)],
  targets: [
    relative('l2-target-joe', 'Grandpa Joe', 'turkey-platter', 830, 210, 150),
    relative('l2-target-lily', 'Cousin Lily', 'cranberry-bowl', 830, 330, 150),
    relative('l2-target-sam', 'Little Sam', 'pie-tin', 830, 450, 150),
  ],
  maxTugs: MAX_TUGS,
};

/* ------------------------------------------------------------------ */
/* Level 3: "Holiday Chaos" (toddler + cat, four dishes, three guests) */
/* ------------------------------------------------------------------ */

const LEVEL_3: LevelDefinition = {
  id: 3,
  name: 'Holiday Chaos',
  briefing:
    "Level 3, Holiday Chaos. The toddler's hand and a prowling cat are both loose. " +
    'You have four dishes for three hungry relatives, so you can afford one mistake.',
  table: TABLE,
  slingshot: SLINGSHOT,
  dishes: makeDishQueue(3, ['gravy-boat', 'cranberry-bowl', 'turkey-platter', 'roll-basket']),
  obstacles: [
    candlestick('l3-candle-a', 250, 250),
    candlestick('l3-candle-b', 250, 400),
    saltShaker('l3-salt-a', 560, 450, 0.2),
    saltShaker('l3-salt-b', 560, 190, -0.2),
  ],
  zones: [
    mashedPotato('l3-potato-a', 340, 320, 110, 90),
    cranberrySpill('l3-cranberry-a', 560, 320, 130, 90),
    mashedPotato('l3-potato-b', 700, 450, 100, 70),
    cranberrySpill('l3-cranberry-b', 700, 190, 100, 70),
  ],
  hazards: [
    toddlerHand('l3-hand-a', { x: 440, y: 320 }, 120, 0.4, 0),
    wanderingCat('l3-cat-a', { x: 690, y: 320 }, 60, 0.25, Math.PI / 2),
  ],
  targets: [
    relative('l3-target-marge', 'Aunt Marge', 'gravy-boat', 840, 210, 200),
    relative('l3-target-rose', 'Grandma Rose', 'cranberry-bowl', 840, 330, 200),
    relative('l3-target-bob', 'Uncle Bob', 'turkey-platter', 840, 450, 200),
  ],
  maxTugs: MAX_TUGS,
};

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** All levels in play order. */
export const LEVELS: readonly LevelDefinition[] = [LEVEL_1, LEVEL_2, LEVEL_3];

export const LEVEL_COUNT: number = LEVELS.length;

/** Returns the level at `index`, or `undefined` when out of range. */
export function getLevel(index: number): LevelDefinition | undefined {
  return LEVELS[index];
}

/**
 * Sanity-checks level data and returns a list of human-readable problems
 * (empty when everything is consistent). Pure; safe to call from tests
 * or once at startup.
 */
export function validateLevels(levels: readonly LevelDefinition[] = LEVELS): readonly string[] {
  const problems: string[] = [];

  for (const level of levels) {
    const prefix = `Level ${level.id} (${level.name})`;
    const seenIds = new Set<string>();

    const trackId = (id: string): void => {
      if (seenIds.has(id)) {
        problems.push(`${prefix}: duplicate entity id "${id}"`);
      }
      seenIds.add(id);
    };

    for (const dish of level.dishes) trackId(dish.id);
    for (const obstacle of level.obstacles) trackId(obstacle.id);
    for (const zone of level.zones) trackId(zone.id);
    for (const hazard of level.hazards) trackId(hazard.id);
    for (const target of level.targets) trackId(target.id);

    const availableKinds = new Set<DishKind>(level.dishes.map((dish) => dish.kind));
    for (const target of level.targets) {
      if (!availableKinds.has(target.requestedDish)) {
        problems.push(
          `${prefix}: target "${target.relativeName}" requests "${target.requestedDish}" but no such dish is in the queue`,
        );
      }
    }

    if (level.dishes.length < level.targets.length) {
      problems.push(`${prefix}: fewer dishes (${level.dishes.length}) than targets (${level.targets.length})`);
    }

    const { top } = level.table;
    const withinTable = (x: number, y: number): boolean =>
      x >= top.x && x <= top.x + top.width && y >= top.y && y <= top.y + top.height;

    for (const target of level.targets) {
      if (!withinTable(target.position.x, target.position.y)) {
        problems.push(`${prefix}: target "${target.id}" is outside the table top`);
      }
    }
    for (const zone of level.zones) {
      if (!withinTable(zone.position.x, zone.position.y)) {
        problems.push(`${prefix}: zone "${zone.id}" is outside the table top`);
      }
    }
    if (!withinTable(level.slingshot.anchor.x, level.slingshot.anchor.y)) {
      problems.push(`${prefix}: slingshot anchor is outside the table top`);
    }
  }

  return problems;
}