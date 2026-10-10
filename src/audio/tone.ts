import { getAudioContext } from './context';
import { midiToHz } from '../engines/types';

/** A short soft tone so kids can hear the note they've picked while fixing the music. */
export function playTone(midi: number, durationS = 0.5) {
  try {
    const ctx = getAudioContext();
    void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = midiToHz(midi);
    const t0 = ctx.currentTime + 0.01;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.25, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + durationS);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + durationS + 0.05);
  } catch {
    // Audio not available: not important here.
  }
}
