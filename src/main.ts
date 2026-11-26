/**
 * main.ts
 * Bootstrap for "Pass the Gravy: Tablecloth Tactics".
 *
 * RULES FOR THIS FILE
 * - The only module that touches window, builds the AudioContext, and owns the
 *   requestAnimationFrame scheduler.
 * - Wires: DOM HUD <-> GameEngine <-> CanvasRenderer / AudioManager / InputController.
 * - No non-null assertions: every DOM lookup is checked at runtime.
 */

import { AudioManager } from './game/AudioManager';
import { GameEngine } from './game/GameEngine';
import { InputController } from './input/InputController';
import type { InputView } from './input/InputController';
import { LEVELS, validateLevels } from './levels/levels';
import { CanvasRenderer } from './render/CanvasRenderer';
import type {
  AudioPlayer,
  FrameScheduler,
  GameState,
  HudSink,
  InputCommand,
} from './types/game.types';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Cap on the canvas pixel ratio, to keep fill cost reasonable. */
const MAX_PIXEL_RATIO = 2;

const WELCOME_MESSAGE =
  'Welcome to Pass the Gravy: Tablecloth Tactics. Press the Start game button, or press Enter, to begin.';

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

/** Finds an element by id and verifies its type, or throws a clear error. */
function requireElement<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`index.html is missing the element with id "${id}".`);
  }
  if (!(element instanceof type)) {
    throw new Error(`The element with id "${id}" is not a ${type.name}.`);
  }
  return element;
}

/** Writes text only when it changed, to avoid needless DOM churn. */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

/* ------------------------------------------------------------------ */
/* Canvas resolution                                                   */
/* ------------------------------------------------------------------ */

/**
 * Sizes the canvas backing store to the world size times the pixel ratio.
 * Setting width or height clears the canvas, so it only runs on change; the
 * renderer repaints every frame anyway.
 */
function applyCanvasResolution(
  canvas: HTMLCanvasElement,
  worldWidth: number,
  worldHeight: number,
): void {
  const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1), MAX_PIXEL_RATIO);
  const width = Math.round(worldWidth * ratio);
  const height = Math.round(worldHeight * ratio);
  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }
}

/* ------------------------------------------------------------------ */
/* Frame scheduler                                                     */
/* ------------------------------------------------------------------ */

const animationFrameScheduler: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => {
    window.cancelAnimationFrame(handle);
  },
};

/* ------------------------------------------------------------------ */
/* Audio host                                                          */
/* ------------------------------------------------------------------ */

/** Silent stand-in used when Web Audio is unavailable. */
class SilentAudio implements AudioPlayer {
  play(): void {}
  setMuted(): void {}
}

interface AudioHost {
  readonly player: AudioPlayer;
  /** Resumes the context. Call from a user gesture. Never rejects. */
  resume(): Promise<void>;
  dispose(): void;
}

function createAudioHost(): AudioHost {
  if (typeof AudioContext === 'undefined') {
    return { player: new SilentAudio(), resume: () => Promise.resolve(), dispose: () => undefined };
  }
  try {
    const context = new AudioContext();
    const manager = new AudioManager(context);
    return {
      player: manager,
      resume: () => manager.resume().catch(() => undefined),
      dispose: () => {
        manager.dispose();
        context.close().catch(() => undefined);
      },
    };
  } catch (error) {
    console.warn('Web Audio is unavailable; continuing without sound.', error);
    return { player: new SilentAudio(), resume: () => Promise.resolve(), dispose: () => undefined };
  }
}

/* ------------------------------------------------------------------ */
/* DOM HUD                                                             */
/* ------------------------------------------------------------------ */

interface HudElements {
  readonly level: HTMLElement;
  readonly score: HTMLElement;
  readonly tugs: HTMLElement;
  readonly dish: HTMLElement;
  readonly slosh: HTMLMeterElement;
  readonly banner: HTMLElement;
  readonly scoreLive: HTMLElement;
  readonly start: HTMLButtonElement;
  readonly launch: HTMLButtonElement;
  readonly tug: HTMLButtonElement;
  readonly restart: HTMLButtonElement;
  readonly mute: HTMLButtonElement;
}

/** HudSink backed by the semantic HUD in index.html. */
class DomHud implements HudSink {
  private readonly elements: HudElements;
  private lastScore: number | null = null;
  private announceToggle = false;

  constructor(elements: HudElements) {
    this.elements = elements;
  }

  update(state: GameState): void {
    const e = this.elements;

    setText(e.level, String(state.level.id));
    setText(e.score, String(state.score));
    setText(e.tugs, String(state.tugsRemaining));

    const activeDish = state.level.dishes.find((dish) => dish.id === state.activeDishId);
    setText(e.dish, activeDish?.label ?? '—');

    const sloshValues = Object.values(state.slosh);
    const slosh = Math.round(Math.max(0, ...sloshValues));
    if (e.slosh.value !== slosh) {
      e.slosh.value = slosh;
      setText(e.slosh, `${slosh}%`);
      e.slosh.setAttribute('aria-valuetext', `${slosh} percent`);
    }

    if (this.lastScore !== null && this.lastScore !== state.score) {
      setText(e.scoreLive, `Score ${state.score}`);
    }
    this.lastScore = state.score;

    const isLastLevel = state.levelIndex >= LEVELS.length - 1;
    switch (state.phase) {
      case 'menu':
        setText(e.start, 'Start game');
        e.start.disabled = false;
        break;
      case 'levelComplete':
        setText(e.start, isLastLevel ? 'Play again' : 'Next level');
        e.start.disabled = false;
        break;
      case 'gameOver':
        setText(e.start, 'Retry level');
        e.start.disabled = false;
        break;
      case 'aiming':
      case 'simulating':
        setText(e.start, 'Playing…');
        e.start.disabled = true;
        break;
    }

    e.launch.disabled = state.phase !== 'aiming';
    e.tug.disabled = state.phase !== 'simulating' || state.tugsRemaining <= 0;
    e.restart.disabled = state.phase === 'menu';
  }

  announce(message: string, isFailure: boolean): void {
    const { banner } = this.elements;
    banner.classList.toggle('fail', isFailure);
    // Alternating a trailing non-breaking space makes the text node change,
    // so a repeated message is announced again by screen readers.
    this.announceToggle = !this.announceToggle;
    banner.textContent = this.announceToggle ? message : `${message}\u00A0`;
  }

  /** Keeps the mute button's pressed state and label in sync. */
  setMuted(muted: boolean): void {
    const { mute } = this.elements;
    mute.setAttribute('aria-pressed', String(muted));
    setText(mute, muted ? 'Unmute sound (M)' : 'Mute sound (M)');
  }
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

function bootstrap(): void {
  const problems = validateLevels();
  for (const problem of problems) {
    console.warn(`Level data: ${problem}`);
  }

  const firstLevel = LEVELS[0];
  if (firstLevel === undefined) {
    throw new Error('No levels are defined in src/levels/levels.ts.');
  }

  const canvas = requireElement('game-canvas', HTMLCanvasElement);
  const hud = new DomHud({
    level: requireElement('hud-level', HTMLElement),
    score: requireElement('hud-score', HTMLElement),
    tugs: requireElement('hud-tugs', HTMLElement),
    dish: requireElement('hud-dish', HTMLElement),
    slosh: requireElement('hud-slosh', HTMLMeterElement),
    banner: requireElement('status-banner', HTMLElement),
    scoreLive: requireElement('score-live', HTMLElement),
    start: requireElement('btn-start', HTMLButtonElement),
    launch: requireElement('btn-launch', HTMLButtonElement),
    tug: requireElement('btn-tug', HTMLButtonElement),
    restart: requireElement('btn-restart', HTMLButtonElement),
    mute: requireElement('btn-mute', HTMLButtonElement),
  });
  const startButton = requireElement('btn-start', HTMLButtonElement);
  const launchButton = requireElement('btn-launch', HTMLButtonElement);
  const tugButton = requireElement('btn-tug', HTMLButtonElement);
  const restartButton = requireElement('btn-restart', HTMLButtonElement);
  const muteButton = requireElement('btn-mute', HTMLButtonElement);

  // Canvas resolution must be set before the renderer paints its first frame.
  const { worldWidth, worldHeight } = firstLevel.table;
  applyCanvasResolution(canvas, worldWidth, worldHeight);
  const windowListeners = new AbortController();
  window.addEventListener(
    'resize',
    () => {
      applyCanvasResolution(canvas, worldWidth, worldHeight);
    },
    { signal: windowListeners.signal },
  );

  const audioHost = createAudioHost();
  const renderer = new CanvasRenderer(canvas);
  const engine = new GameEngine({
    renderer,
    audio: audioHost.player,
    hud,
    scheduler: animationFrameScheduler,
    levels: LEVELS,
  });

  /** Single entry point for every command, from buttons and from input. */
  const dispatch = (command: InputCommand): void => {
    if (command.type === 'start') {
      // Starting is a user gesture, so this is where audio may be unlocked.
      void audioHost.resume();
    }
    engine.handleCommand(command);
    if (command.type === 'toggle-mute') {
      hud.setMuted(engine.isMuted());
    }
  };

  /** Binds a visible button to a command and returns focus to the canvas. */
  const bindButton = (
    button: HTMLButtonElement,
    command: InputCommand,
    refocusCanvas: boolean,
  ): void => {
    button.addEventListener('click', () => {
      dispatch(command);
      if (refocusCanvas) {
        canvas.focus({ preventScroll: true });
      }
    });
  };
  bindButton(startButton, { type: 'start' }, true);
  bindButton(launchButton, { type: 'launch' }, true);
  bindButton(tugButton, { type: 'tug' }, true);
  bindButton(restartButton, { type: 'restart-level' }, true);
  bindButton(muteButton, { type: 'toggle-mute' }, false);

  const input = new InputController({
    canvas,
    onCommand: dispatch,
    getView: (): InputView => {
      const state = engine.getState();
      return {
        worldWidth: state.level.table.worldWidth,
        worldHeight: state.level.table.worldHeight,
        anchor: state.level.slingshot.anchor,
        phase: state.phase,
      };
    },
  });

  hud.setMuted(engine.isMuted());
  hud.announce(WELCOME_MESSAGE, false);
  engine.run();

  // Vite hot reload: tear everything down so edits don't stack duplicate loops.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      input.dispose();
      engine.dispose();
      audioHost.dispose();
      windowListeners.abort();
    });
  }
}

bootstrap();