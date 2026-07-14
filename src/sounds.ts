// Simple synthesized cues using the Web Audio API, so there are no audio files
// to bundle. Each cue is a short sequence of tones.

let ctx: AudioContext | null = null;

function audioContext(): AudioContext {
  if (!ctx) {
    ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext)();
  }
  return ctx;
}

// Browsers start the AudioContext suspended until a user gesture. Call this from
// a click handler so later programmatic sounds are allowed to play.
export async function unlockAudio(): Promise<void> {
  const c = audioContext();
  if (c.state === "suspended") {
    await c.resume();
  }
}

interface Tone {
  freq: number;
  /** Start time offset in seconds. */
  at: number;
  /** Duration in seconds. */
  dur: number;
  type?: OscillatorType;
  gain?: number;
}

function playTones(tones: Tone[]): void {
  const c = audioContext();
  if (c.state === "suspended") void c.resume();
  const now = c.currentTime;
  for (const t of tones) {
    const osc = c.createOscillator();
    const gainNode = c.createGain();
    osc.type = t.type ?? "sine";
    osc.frequency.value = t.freq;

    const start = now + t.at;
    const end = start + t.dur;
    const peak = t.gain ?? 0.25;
    // Short attack/decay envelope to avoid clicks.
    gainNode.gain.setValueAtTime(0.0001, start);
    gainNode.gain.exponentialRampToValueAtTime(peak, start + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gainNode).connect(c.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

// Ascending C-major scale, one pitch per progress beep (t = 0..5 seconds). The
// rising pitch lets you hear how far into the hold you are; if the beeps stop or
// drop back to the low pitch, you've gone out of range.
const PROGRESS_FREQS = [
  523.25, // C5  (t=0, the moment you hit the threshold)
  587.33, // D5
  659.25, // E5
  698.46, // F5
  783.99, // G5
  880.0, // A5  (t=5)
];

/** A short progress beep. `index` is the whole-second mark (0..5). */
export function playHoldBeep(index: number): void {
  const freq = PROGRESS_FREQS[index] ?? PROGRESS_FREQS[PROGRESS_FREQS.length - 1];
  playTones([{ freq, at: 0, dur: 0.12, type: "sine", gain: 0.25 }]);
}

/**
 * The final beep at t=6 that completes a successful hold. Longer, louder, and
 * fuller (a bright C6 with a major-third shimmer and an octave below for body)
 * so it clearly stands apart from the progress beeps.
 */
export function playFinalBeep(): void {
  playTones([
    { freq: 1046.5, at: 0, dur: 0.6, type: "triangle", gain: 0.34 }, // C6
    { freq: 1318.51, at: 0, dur: 0.6, type: "sine", gain: 0.18 }, // E6 shimmer
    { freq: 523.25, at: 0, dur: 0.6, type: "sine", gain: 0.16 }, // C5 body
  ]);
}
