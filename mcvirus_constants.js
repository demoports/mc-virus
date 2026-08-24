// Shared hardware and capture constants. Keeping this module data-free lets
// the renderer and other leaf modules load without evaluating embedded assets.
export const SCREEN_WIDTH = 240;
export const SCREEN_HEIGHT = 160;
export const FRAMEBUFFER_PIXELS = SCREEN_WIDTH * SCREEN_HEIGHT;

export const AUDIO_SAMPLE_RATE = 32768;
export const AUDIO_DURATION_SECONDS = 191.0065;
export const GBA_FRAMES_PER_SECOND = 16777216 / 280896;

// The headless reference records krapPlay between VBlanks 262 and 263.
export const KRAP_PLAY_SAMPLE = 143820;
