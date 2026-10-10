/** App-wide constants. The app name lives here and only here. */
export const APP_NAME = 'Riffi';

declare const __APP_BASE__: string | undefined;

/** Base path the app is served from (set at build time with VITE_BASE_PATH). */
export const BASE_PATH: string =
  typeof __APP_BASE__ === 'string' && __APP_BASE__ ? __APP_BASE__ : '/';

/** Sheet-reading endpoint. Override with VITE_OMR_ENDPOINT if the API lives elsewhere. */
export const OMR_ENDPOINT: string =
  (import.meta.env?.VITE_OMR_ENDPOINT as string | undefined) || `${BASE_PATH}api/omr.php`;

export const BASIC_PITCH_MODEL_URL = `${BASE_PATH}models/basic-pitch/model.json`;

export const INSTRUMENTS = ['violin', 'piano', 'voice'] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

export const DIFFICULTIES = ['easy', 'normal', 'tricky'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export type PracticeMode = 'playalong' | 'learn';
export type MetronomeMode = 'sound' | 'visual' | 'vibrate';

export const TEMPO_MIN = 40;
export const TEMPO_MAX = 200;
export const TEMPO_DEFAULT = 80;

/** Photo upload preparation (see SPEC §4). */
export const UPLOAD_MAX_EDGE_PX = 2000;
export const UPLOAD_JPEG_QUALITY = 0.85;
export const UPLOAD_MAX_PAGES = 8;

/** Instrument ranges as MIDI note numbers (SPEC §6.1). */
export const INSTRUMENT_RANGE: Record<Instrument, { low: number; high: number }> = {
  violin: { low: 55, high: 100 }, // G3 to E7
  voice: { low: 45, high: 84 }, // A2 to C6
  piano: { low: 21, high: 108 },
};
