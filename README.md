# Pass the Gravy: Tablecloth Tactics

Pass the Gravy is a browser-based Thanksgiving physics game. Launch dishes across the table, avoid spills and hazards, and deliver every dish to the right hungry relative before you run out of dishes.

The game is built with TypeScript, Vite, Matter.js, the Canvas 2D API, and the Web Audio API. There are no image or audio assets: the table, dishes, effects, and sound cues are generated at runtime.

## How to Play

1. Press **Start game** or **Enter**.
2. Drag backward from the slingshot near the lower-left of the table.
3. Aim in the opposite direction and release to launch.
4. Move the dish into the matching green relative target.
5. Keep it slow and inside the target for 600 ms to deliver it.
6. Complete all three levels by feeding every relative.

The dish queue advances automatically after each shot. Incorrect dishes may pass over targets, but they cannot be delivered to the wrong relative.

## Controls

| Action | Mouse / touch | Keyboard |
| --- | --- | --- |
| Aim | Drag back from the slingshot | Left / Right arrows adjust angle; Up / Down adjust power |
| Fine aim | - | Hold Shift with the arrow keys |
| Launch | Release the drag | Enter |
| Tablecloth Tug | - | Space |
| Restart level | - | R |
| Mute / unmute | Mute button | M |
| Cancel aim drag | Release outside / press Escape | Escape |

Mouse and touch aiming starts from within the slingshot area. The HUD, status banner, canvas, and controls can also be operated with standard keyboard and screen-reader tools.

## Table Hazards

- **Cranberry spill:** Diagonal stripes with a snowflake marker. It is slippery and lets dishes travel farther.
- **Mashed potato:** Dotted fill with a circle marker. It is sticky and slows dishes down.
- **Candlesticks and salt shakers:** Static obstacles that deflect dishes.
- **Toddler hand:** A sweeping moving hazard.
- **Wandering cat:** A moving hazard that crosses the table.

Liquid dishes have a slosh meter. Sudden motion, spinning, and collisions raise it. Calm movement drains it. Reaching 100% causes an immediate spill and fails the level.

## Levels

1. **Warm-Up Round:** Gravy boat and roll basket, with cranberry and potato surfaces.
2. **Little Hands:** Cranberry bowl, turkey platter, and pie tin, plus a moving toddler hand.
3. **Holiday Chaos:** Gravy boat, cranberry bowl, turkey platter, and roll basket, with both a toddler hand and a cat.

Each level provides two **Tablecloth Tugs**. A tug adds a lateral impulse and torque to dishes already on the table, so it can be used while a shot is moving. Tugs do not reset while the game is in the same level.

## Scoring

- Deliveries earn the points defined by each relative.
- Steady liquid deliveries earn up to 50% extra based on how low their slosh meter remains.
- Unused Tablecloth Tugs earn 25 bonus points each after a level is completed.
- Restarting or retrying a level restores the score from when that level began.

The level fails if a liquid dish spills, a needed dish falls off the table, or there are no suitable dishes left for the remaining relatives.

## Run Locally

Requirements:

- Node.js 18 or newer
- npm

```bash
cd pass-the-gravy
npm install
npm run dev
```

Open the local address printed by Vite, normally `http://localhost:5173`.

## Build and Preview

```bash
npm run typecheck
npm run build
npm run preview
```

`npm run build` performs TypeScript checking and writes the production bundle to `dist/`.

## Project Structure

```text
src/
  main.ts                 DOM, HUD, audio setup, and bootstrap
  game/
    GameEngine.ts         Game state, turns, scoring, and level progression
    PhysicsWorld.ts       Matter.js physics and collision zones
    SloshTracker.ts       Liquid spill calculation
    AudioManager.ts       Procedural Web Audio cues
  input/
    InputController.ts    Pointer and keyboard input
  levels/
    levels.ts             Dish, target, obstacle, zone, and level data
  render/
    CanvasRenderer.ts     Canvas drawing and visual effects
  types/
    game.types.ts         Shared domain types and interfaces
```

## Accessibility

- Patterns and glyphs accompany most hazard and dish colors.
- Important state changes are announced through an ARIA live status region.
- The game supports mouse, touch, and keyboard-only play.
- Hold Shift for fine 0.5-degree and low-power keyboard aim adjustments.
- Every control is reachable as a labeled HTML button.
