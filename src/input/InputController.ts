/**
 * InputController.ts
 * Translates pointer and keyboard events into InputCommands for
 * "Pass the Gravy: Tablecloth Tactics".
 *
 * RULES FOR THIS FILE
 * - The only module that reads raw DOM input events. src/game/ never sees them.
 * - Keeps no aim state: the engine owns aim, and the renderer draws it.
 * - Imports types only from src/types/game.types.ts.
 *
 * POINTER MODEL
 * 1. pointerdown within GRAB_RADIUS of the slingshot anchor (aiming phase only)
 *    starts tracking, but sends nothing yet.
 * 2. Once the pointer moves DRAG_START_PX CSS pixels, every move sends
 *    aim-update with drag = pointerWorld - anchor.
 * 3. pointerup after a real drag sends a final aim-update, then launch.
 *    A plain click sends nothing, so it can never launch by accident.
 * 4. Escape, pointercancel and lost pointer capture cancel the drag with a
 *    zero-length aim-update (power 0, so the engine refuses to launch).
 *
 * KEYBOARD MODEL
 *   ArrowLeft / ArrowRight  aim-nudge deltaAngle -/+ (Right = clockwise on screen)
 *   ArrowUp / ArrowDown     aim-nudge deltaPower +/-
 *   Shift + arrows          fine adjustment
 *   Enter                   launch while aiming; start/next/retry otherwise
 *   Space                   tablecloth tug
 *   R                       restart level      M   toggle mute
 *   Escape                  cancel an active pointer drag
 */

import type { GamePhase, InputCommand, Vec2 } from '../types/game.types';

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** A drag may only begin this close to the slingshot anchor (world units). */
const GRAB_RADIUS = 80;

/** Pointer travel (CSS pixels) before a press counts as a drag. */
const DRAG_START_PX = 6;

/** Keyboard aim steps. */
const ANGLE_STEP = Math.PI / 90; // 2 degrees
const ANGLE_STEP_FINE = Math.PI / 360; // 0.5 degrees
const POWER_STEP = 0.02;
const POWER_STEP_FINE = 0.005;

const ZERO: Vec2 = { x: 0, y: 0 };

/* ------------------------------------------------------------------ */
/* Public contracts                                                    */
/* ------------------------------------------------------------------ */

/** What the controller needs to know about the current level and phase. */
export interface InputView {
  readonly worldWidth: number;
  readonly worldHeight: number;
  /** Slingshot anchor in world units (center of the launch point). */
  readonly anchor: Vec2;
  readonly phase: GamePhase;
}

export interface InputControllerOptions {
  /** The game canvas. It receives pointer events, and its document receives keys. */
  readonly canvas: HTMLCanvasElement;
  /** Receives every command. Normally `engine.handleCommand`. */
  readonly onCommand: (command: InputCommand) => void;
  /**
   * Read on every event (levels change at runtime). Normally built from
   * `engine.getState()`.
   */
  readonly getView: () => InputView;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** True when the key is Space under any browser's naming. */
function isSpaceKey(key: string): boolean {
  return key === ' ' || key === 'Spacebar';
}

/** True for elements where typing must never be intercepted. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

/**
 * True for elements that already react to Enter and Space themselves.
 * Handling those keys here as well would fire an action twice.
 */
function activatesOnEnterOrSpace(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.closest('button, a[href], summary') !== null;
}

/* ------------------------------------------------------------------ */
/* InputController                                                     */
/* ------------------------------------------------------------------ */

export class InputController {
  private readonly canvas: HTMLCanvasElement;
  private readonly onCommand: (command: InputCommand) => void;
  private readonly getView: () => InputView;
  private readonly abort = new AbortController();

  /** Pointer currently dragging, or null. */
  private activePointerId: number | null = null;
  /** Where the active pointer went down, in client (CSS pixel) coordinates. */
  private downClient: Vec2 = ZERO;
  /** True once the pointer has moved far enough to count as a drag. */
  private dragStarted = false;

  constructor(options: InputControllerOptions) {
    this.canvas = options.canvas;
    this.onCommand = options.onCommand;
    this.getView = options.getView;

    const { signal } = this.abort;
    this.canvas.addEventListener('pointerdown', this.onPointerDown, { signal });
    this.canvas.addEventListener('pointermove', this.onPointerMove, { signal });
    this.canvas.addEventListener('pointerup', this.onPointerUp, { signal });
    this.canvas.addEventListener('pointercancel', this.onPointerCancel, { signal });
    this.canvas.addEventListener('lostpointercapture', this.onLostPointerCapture, { signal });
    this.canvas.ownerDocument.addEventListener('keydown', this.onKeyDown, { signal });
  }

  /** Removes every listener. The instance does nothing afterwards. */
  dispose(): void {
    this.abort.abort();
    this.resetDrag();
  }

  /* ------------------------------ Pointer ------------------------------- */

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.activePointerId !== null) {
      return;
    }
    // Mouse: primary button only. Touch and pen report button 0 as well.
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    const view = this.getView();
    if (view.phase !== 'aiming') {
      return;
    }
    const world = this.toWorld(event.clientX, event.clientY, view);
    if (world === null || distance(world, view.anchor) > GRAB_RADIUS) {
      return;
    }

    this.activePointerId = event.pointerId;
    this.downClient = { x: event.clientX, y: event.clientY };
    this.dragStarted = false;
    this.canvas.focus({ preventScroll: true });
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // The pointer vanished before capture. Dragging still works without it.
    }
    event.preventDefault();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      return;
    }
    const view = this.getView();
    if (view.phase !== 'aiming') {
      this.cancelDrag(false);
      return;
    }
    if (!this.dragStarted) {
      const moved = distance({ x: event.clientX, y: event.clientY }, this.downClient);
      if (moved < DRAG_START_PX) {
        return;
      }
      this.dragStarted = true;
    }
    const drag = this.dragVector(event, view);
    if (drag !== null) {
      this.onCommand({ type: 'aim-update', drag });
    }
    event.preventDefault();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      return;
    }
    const view = this.getView();
    const shouldLaunch = this.dragStarted && view.phase === 'aiming';
    const drag = shouldLaunch ? this.dragVector(event, view) : null;

    this.finishDrag(event.pointerId);

    if (drag !== null) {
      this.onCommand({ type: 'aim-update', drag });
      this.onCommand({ type: 'launch' });
    }
    event.preventDefault();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.activePointerId) {
      this.cancelDrag(true);
    }
  };

  private readonly onLostPointerCapture = (event: PointerEvent): void => {
    // Deliberate releases clear activePointerId first, so they never land here.
    if (event.pointerId === this.activePointerId) {
      this.cancelDrag(true);
    }
  };

  /** Drag vector (pointer minus anchor) in world units, or null when unmeasurable. */
  private dragVector(event: PointerEvent, view: InputView): Vec2 | null {
    const world = this.toWorld(event.clientX, event.clientY, view);
    if (world === null) {
      return null;
    }
    return { x: world.x - view.anchor.x, y: world.y - view.anchor.y };
  }

  /** CSS pixel position to world units, or null when the canvas has no size. */
  private toWorld(clientX: number, clientY: number, view: InputView): Vec2 | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return {
      x: ((clientX - rect.left) * view.worldWidth) / rect.width,
      y: ((clientY - rect.top) * view.worldHeight) / rect.height,
    };
  }

  /** Ends the drag normally and releases pointer capture. */
  private finishDrag(pointerId: number): void {
    this.resetDrag();
    this.releaseCapture(pointerId);
  }

  /**
   * Aborts the drag. When `notifyEngine` is true and a drag had started, a
   * zero-length aim-update zeroes the power so the engine cannot launch.
   */
  private cancelDrag(notifyEngine: boolean): void {
    const pointerId = this.activePointerId;
    const hadStarted = this.dragStarted;
    this.resetDrag();
    if (pointerId !== null) {
      this.releaseCapture(pointerId);
    }
    if (notifyEngine && hadStarted) {
      this.onCommand({ type: 'aim-update', drag: ZERO });
    }
  }

  private resetDrag(): void {
    this.activePointerId = null;
    this.dragStarted = false;
    this.downClient = ZERO;
  }

  private releaseCapture(pointerId: number): void {
    try {
      if (this.canvas.hasPointerCapture(pointerId)) {
        this.canvas.releasePointerCapture(pointerId);
      }
    } catch {
      // Already released by the browser.
    }
  }

  /* ------------------------------ Keyboard ------------------------------ */

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) {
      return;
    }
    // Leave browser and OS shortcuts alone (Ctrl+R, Cmd+M, Alt+Left, ...).
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (isTextEntry(event.target)) {
      return;
    }

    const view = this.getView();
    const key = event.key;

    switch (key) {
      case 'ArrowLeft':
        this.handleArrow(event, view, -1, 0);
        return;
      case 'ArrowRight':
        this.handleArrow(event, view, 1, 0);
        return;
      case 'ArrowUp':
        this.handleArrow(event, view, 0, 1);
        return;
      case 'ArrowDown':
        this.handleArrow(event, view, 0, -1);
        return;
      case 'Escape':
        if (this.activePointerId !== null) {
          this.cancelDrag(true);
          event.preventDefault();
        }
        return;
      case 'Enter':
        this.handleEnter(event, view);
        return;
      case 'r':
      case 'R':
        if (!event.repeat) {
          this.onCommand({ type: 'restart-level' });
          event.preventDefault();
        }
        return;
      case 'm':
      case 'M':
        if (!event.repeat) {
          this.onCommand({ type: 'toggle-mute' });
          event.preventDefault();
        }
        return;
      default:
        break;
    }

    if (isSpaceKey(key)) {
      this.handleSpace(event, view);
    }
  };

  /**
   * Arrow keys nudge the aim only while aiming, so the page still scrolls
   * normally in every other phase. `angleSign` is +1 for clockwise on screen.
   */
  private handleArrow(
    event: KeyboardEvent,
    view: InputView,
    angleSign: -1 | 0 | 1,
    powerSign: -1 | 0 | 1,
  ): void {
    if (view.phase !== 'aiming') {
      return;
    }
    const angleStep = event.shiftKey ? ANGLE_STEP_FINE : ANGLE_STEP;
    const powerStep = event.shiftKey ? POWER_STEP_FINE : POWER_STEP;
    this.onCommand({
      type: 'aim-nudge',
      deltaAngle: angleSign * angleStep,
      deltaPower: powerSign * powerStep,
    });
    event.preventDefault();
  }

  /** Enter launches while aiming and starts, advances or retries otherwise. */
  private handleEnter(event: KeyboardEvent, view: InputView): void {
    if (event.repeat || activatesOnEnterOrSpace(event.target)) {
      return;
    }
    switch (view.phase) {
      case 'aiming':
        this.onCommand({ type: 'launch' });
        event.preventDefault();
        return;
      case 'menu':
      case 'levelComplete':
      case 'gameOver':
        this.onCommand({ type: 'start' });
        event.preventDefault();
        return;
      case 'simulating':
        return;
    }
  }

  /** Space pulls the tablecloth while a game is running. */
  private handleSpace(event: KeyboardEvent, view: InputView): void {
    if (event.repeat || activatesOnEnterOrSpace(event.target)) {
      return;
    }
    if (view.phase !== 'aiming' && view.phase !== 'simulating') {
      return;
    }
    this.onCommand({ type: 'tug' });
    event.preventDefault();
  }
}