import { db, newId } from '../data/db';
import { DEFAULT_METRONOME, type MetronomeSettings } from './metronomeCore';
import { REF_DEFAULT, type TunerInstrument } from './tuner';

export interface GadgetPreset {
  id: string;
  name: string;
  settings: MetronomeSettings;
}

/** Everything the gadget remembers for one kid. */
export interface GadgetState {
  metronome: MetronomeSettings;
  presets: GadgetPreset[];
  volume: number;
  refHz: number;
  tunerInstrument: TunerInstrument;
  timerMinutes: number;
  countPractice: boolean;
}

export const DEFAULT_GADGET: GadgetState = {
  metronome: DEFAULT_METRONOME,
  presets: [],
  volume: 0.8,
  refHz: REF_DEFAULT,
  tunerInstrument: 'violin',
  timerMinutes: 0,
  countPractice: false,
};

const key = (profileId: string) => `gadget:${profileId}`;

export async function loadGadget(profileId: string): Promise<GadgetState> {
  const row = await db.settings.get(key(profileId));
  const v = (row?.value as Partial<GadgetState> | undefined) ?? {};
  return { ...DEFAULT_GADGET, ...v, metronome: { ...DEFAULT_METRONOME, ...(v.metronome ?? {}) } };
}

export async function saveGadget(profileId: string, state: GadgetState) {
  await db.settings.put({ key: key(profileId), value: state });
}

export function makePreset(name: string, settings: MetronomeSettings): GadgetPreset {
  return { id: newId(), name, settings: { ...settings } };
}

export const MAX_PRESETS = 8;
