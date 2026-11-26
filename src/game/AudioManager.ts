/**
 * AudioManager.ts
 * Procedural Web Audio sound effects for "Pass the Gravy: Tablecloth Tactics".
 *
 * RULES FOR THIS FILE
 * - No document, no window. The AudioContext is injected by main.ts.
 * - No audio assets: every cue is synthesized.
 * - Imports come from src/types/game.types.ts only.
 *
 * INTENSITY
 * play(cue, intensity) takes intensity in 0..1. Use intensityFromImpact()
 * to convert a CollisionEvent.impactSpeed (units per fixed step).
 */

import type { AudioPlayer, SoundCue } from '../types/game.types';

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** Master output level when unmuted (0..1). */
const MASTER_VOLUME = 0.5;

/** Seconds over which mute/unmute fades, to avoid clicks. */
const MUTE_FADE_SEC = 0.02;

/** Hard cap on simultaneously sounding voices (oscillators + noise). */
const MAX_VOICES = 24;

/** Length of the shared white-noise buffer, in seconds. */
const NOISE_BUFFER_SEC = 1;

/** Impact speed (units per step) that maps to full intensity. */
const FULL_INTENSITY_IMPACT = 12;

/** Floor for exponential ramps (they cannot reach exactly zero). */
const SILENCE = 0.0001;

/** Minimum seconds between two plays of the same cue. */
const MIN_RETRIGGER_SEC: Readonly<Record<SoundCue, number>> = {
  launch: 0.05,
  thud: 0.06,
  clink: 0.04,
  splash: 0.15,
  tug: 0.2,
  success: 0.3,
  fail: 0.3,
  squelch: 0.12,
};

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamps to 0..1 and maps non-finite input to 0. */
function normalizeIntensity(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

/**
 * Converts a collision impact speed (units per fixed step) to a 0..1
 * intensity for play(). Non-finite or negative input yields 0.
 */
export function intensityFromImpact(
  impactSpeed: number,
  fullIntensityAt: number = FULL_INTENSITY_IMPACT,
): number {
  if (!Number.isFinite(impactSpeed) || !Number.isFinite(fullIntensityAt) || fullIntensityAt <= 0) {
    return 0;
  }
  return clamp(impactSpeed / fullIntensityAt, 0, 1);
}

/** Random value in [1 - spread, 1 + spread], for subtle pitch variation. */
function jitter(spread: number): number {
  return 1 + (Math.random() * 2 - 1) * spread;
}

/* ------------------------------------------------------------------ */
/* Voice option shapes                                                 */
/* ------------------------------------------------------------------ */

interface ToneOptions {
  readonly type: OscillatorType;
  readonly startHz: number;
  readonly endHz: number;
  readonly durationSec: number;
  readonly peakGain: number;
  readonly attackSec: number;
  /** Seconds after "now" at which the tone begins. */
  readonly delaySec: number;
}

interface NoiseOptions {
  readonly filter: BiquadFilterType;
  readonly startHz: number;
  readonly endHz: number;
  readonly q: number;
  readonly durationSec: number;
  readonly peakGain: number;
  readonly attackSec: number;
  readonly delaySec: number;
}

/* ------------------------------------------------------------------ */
/* AudioManager                                                        */
/* ------------------------------------------------------------------ */

export class AudioManager implements AudioPlayer {
  private readonly context: AudioContext;
  private readonly master: GainNode;
  private readonly noiseBuffer: AudioBuffer;
  private readonly lastPlayed = new Map<SoundCue, number>();

  private muted = false;
  private activeVoices = 0;

  /**
   * @param context An AudioContext created by main.ts (ideally inside a user
   *                gesture handler, or resumed from one).
   */
  constructor(context: AudioContext) {
    this.context = context;

    this.master = context.createGain();
    this.master.gain.value = MASTER_VOLUME;
    this.master.connect(context.destination);

    this.noiseBuffer = AudioManager.createNoiseBuffer(context);
  }

  /* ----------------------------- Public API ----------------------------- */

  /**
   * Resumes a suspended context. Call from a user-gesture handler (for
   * example the Start button). Safe to call repeatedly.
   */
  async resume(): Promise<void> {
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const now = this.context.currentTime;
    const target = muted ? 0 : MASTER_VOLUME;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(target, now + MUTE_FADE_SEC);
  }

  isMuted(): boolean {
    return this.muted;
  }

  play(cue: SoundCue, intensity: number): void {
    if (this.muted || this.context.state === 'closed') {
      return;
    }
    if (this.context.state === 'suspended') {
      // Best effort. Browsers may refuse outside a user gesture.
      this.context.resume().catch(() => undefined);
    }

    const now = this.context.currentTime;
    const last = this.lastPlayed.get(cue);
    if (last !== undefined && now - last < MIN_RETRIGGER_SEC[cue]) {
      return;
    }
    this.lastPlayed.set(cue, now);

    const level = normalizeIntensity(intensity);

    switch (cue) {
      case 'launch':
        this.playLaunch(level);
        break;
      case 'thud':
        this.playThud(level);
        break;
      case 'clink':
        this.playClink(level);
        break;
      case 'splash':
        this.playSplash(level);
        break;
      case 'tug':
        this.playTug(level);
        break;
      case 'success':
        this.playSuccess();
        break;
      case 'fail':
        this.playFail();
        break;
      case 'squelch':
        this.playSquelch(level);
        break;
    }
  }

  /** Disconnects the master bus. The instance is unusable afterwards. */
  dispose(): void {
    this.master.disconnect();
    this.lastPlayed.clear();
  }

  /* ------------------------------ Cue recipes --------------------------- */

  /** Slingshot release: a rising whoosh plus a short twang. */
  private playLaunch(level: number): void {
    const gain = 0.25 + 0.75 * level;
    this.noise({
      filter: 'bandpass',
      startHz: 400,
      endHz: 1800,
      q: 1.2,
      durationSec: 0.22,
      peakGain: 0.35 * gain,
      attackSec: 0.04,
      delaySec: 0,
    });
    this.tone({
      type: 'triangle',
      startHz: 320 * jitter(0.03),
      endHz: 140,
      durationSec: 0.18,
      peakGain: 0.3 * gain,
      attackSec: 0.005,
      delaySec: 0,
    });
  }

  /** Dull impact (dish on obstacle or hazard): low sine drop plus soft noise. */
  private playThud(level: number): void {
    const gain = 0.15 + 0.85 * level;
    this.tone({
      type: 'sine',
      startHz: (110 + 70 * level) * jitter(0.05),
      endHz: 45,
      durationSec: 0.12 + 0.12 * level,
      peakGain: 0.7 * gain,
      attackSec: 0.003,
      delaySec: 0,
    });
    this.noise({
      filter: 'lowpass',
      startHz: 600 + 900 * level,
      endHz: 200,
      q: 0.7,
      durationSec: 0.08,
      peakGain: 0.3 * gain,
      attackSec: 0.002,
      delaySec: 0,
    });
  }

  /** Ceramic or metal tap (dish on dish): two bright, fast-decaying partials. */
  private playClink(level: number): void {
    const gain = 0.12 + 0.88 * level;
    const base = (1800 + 900 * level) * jitter(0.08);
    const decay = 0.07 + 0.1 * level;
    this.tone({
      type: 'triangle',
      startHz: base,
      endHz: base * 0.98,
      durationSec: decay,
      peakGain: 0.35 * gain,
      attackSec: 0.001,
      delaySec: 0,
    });
    this.tone({
      type: 'sine',
      startHz: base * 1.52,
      endHz: base * 1.5,
      durationSec: decay * 0.8,
      peakGain: 0.25 * gain,
      attackSec: 0.001,
      delaySec: 0,
    });
  }

  /** Liquid slop: a swishing band of noise that falls in pitch. */
  private playSplash(level: number): void {
    const gain = 0.2 + 0.8 * level;
    this.noise({
      filter: 'bandpass',
      startHz: 1400,
      endHz: 450,
      q: 0.9,
      durationSec: 0.3 + 0.25 * level,
      peakGain: 0.5 * gain,
      attackSec: 0.02,
      delaySec: 0,
    });
    this.tone({
      type: 'sine',
      startHz: 260,
      endHz: 120,
      durationSec: 0.2,
      peakGain: 0.18 * gain,
      attackSec: 0.01,
      delaySec: 0.03,
    });
  }

  /** Tablecloth tug: a rising cloth rustle with a low pull underneath. */
  private playTug(level: number): void {
    const gain = 0.4 + 0.6 * level;
    this.noise({
      filter: 'bandpass',
      startHz: 500,
      endHz: 1600,
      q: 0.6,
      durationSec: 0.4,
      peakGain: 0.5 * gain,
      attackSec: 0.12,
      delaySec: 0,
    });
    this.tone({
      type: 'sine',
      startHz: 80,
      endHz: 120,
      durationSec: 0.35,
      peakGain: 0.3 * gain,
      attackSec: 0.08,
      delaySec: 0,
    });
  }

  /** Delivery success: a quick rising major arpeggio (C5 E5 G5 C6). */
  private playSuccess(): void {
    const notes: readonly number[] = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((hz, index) => {
      this.tone({
        type: 'triangle',
        startHz: hz,
        endHz: hz,
        durationSec: 0.22,
        peakGain: 0.3,
        attackSec: 0.008,
        delaySec: index * 0.09,
      });
    });
  }

  /** Spill or fall-off failure: a falling buzz with a low thump. */
  private playFail(): void {
    this.tone({
      type: 'sawtooth',
      startHz: 330,
      endHz: 90,
      durationSec: 0.55,
      peakGain: 0.22,
      attackSec: 0.01,
      delaySec: 0,
    });
    this.tone({
      type: 'sine',
      startHz: 100,
      endHz: 40,
      durationSec: 0.4,
      peakGain: 0.4,
      attackSec: 0.005,
      delaySec: 0.1,
    });
  }

  /** Dish sinking into mashed potato: a wet, low, wobbling drop. */
  private playSquelch(level: number): void {
    const gain = 0.2 + 0.8 * level;
    this.noise({
      filter: 'lowpass',
      startHz: 500,
      endHz: 150,
      q: 3,
      durationSec: 0.2 + 0.1 * level,
      peakGain: 0.45 * gain,
      attackSec: 0.01,
      delaySec: 0,
    });
    this.tone({
      type: 'sine',
      startHz: 200 * jitter(0.1),
      endHz: 70,
      durationSec: 0.18,
      peakGain: 0.3 * gain,
      attackSec: 0.005,
      delaySec: 0,
    });
  }

  /* --------------------------- Voice primitives ------------------------- */

  /** Plays one oscillator with an attack/exponential-decay envelope. */
  private tone(options: ToneOptions): void {
    if (this.activeVoices >= MAX_VOICES) {
      return;
    }
    const ctx = this.context;
    const start = ctx.currentTime + options.delaySec;
    const end = start + options.durationSec;

    const osc = ctx.createOscillator();
    osc.type = options.type;
    osc.frequency.setValueAtTime(Math.max(1, options.startHz), start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, options.endHz), end);

    const env = ctx.createGain();
    AudioManager.applyEnvelope(env, start, options.attackSec, options.durationSec, options.peakGain);

    osc.connect(env);
    env.connect(this.master);

    this.activeVoices += 1;
    osc.onended = () => {
      this.activeVoices -= 1;
      osc.disconnect();
      env.disconnect();
    };
    osc.start(start);
    osc.stop(end + 0.03);
  }

  /** Plays a slice of the shared noise buffer through a swept biquad filter. */
  private noise(options: NoiseOptions): void {
    if (this.activeVoices >= MAX_VOICES) {
      return;
    }
    const ctx = this.context;
    const start = ctx.currentTime + options.delaySec;
    const end = start + options.durationSec;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = options.filter;
    filter.Q.value = options.q;
    filter.frequency.setValueAtTime(Math.max(1, options.startHz), start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(1, options.endHz), end);

    const env = ctx.createGain();
    AudioManager.applyEnvelope(env, start, options.attackSec, options.durationSec, options.peakGain);

    source.connect(filter);
    filter.connect(env);
    env.connect(this.master);

    this.activeVoices += 1;
    source.onended = () => {
      this.activeVoices -= 1;
      source.disconnect();
      filter.disconnect();
      env.disconnect();
    };
    // Random offset into the buffer so repeated hits do not sound identical.
    source.start(start, Math.random() * (NOISE_BUFFER_SEC * 0.5));
    source.stop(end + 0.03);
  }

  /* -------------------------------- Helpers ----------------------------- */

  /** Silence -> peak over attack, then exponential decay to silence. */
  private static applyEnvelope(
    gainNode: GainNode,
    startSec: number,
    attackSec: number,
    durationSec: number,
    peakGain: number,
  ): void {
    const attack = clamp(attackSec, 0.001, durationSec * 0.8);
    const peak = Math.max(SILENCE * 2, peakGain);
    gainNode.gain.setValueAtTime(SILENCE, startSec);
    gainNode.gain.linearRampToValueAtTime(peak, startSec + attack);
    gainNode.gain.exponentialRampToValueAtTime(SILENCE, startSec + durationSec);
  }

  /** One mono buffer of white noise, shared by every noise voice. */
  private static createNoiseBuffer(context: AudioContext): AudioBuffer {
    const length = Math.max(1, Math.floor(context.sampleRate * NOISE_BUFFER_SEC));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }
}