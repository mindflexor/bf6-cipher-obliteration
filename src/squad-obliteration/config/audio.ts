import { RULES } from './rules.ts';

export const AUDIO_CONFIG = {
    endgameLoopIntervalMs: RULES.timerLanes.endgameAudioMs,
    holdUiIntervalMs: RULES.timerLanes.holdUiMs,
    liveFastIntervalMs: RULES.timerLanes.liveFastMs,
    liveSlowIntervalMs: RULES.timerLanes.liveSlowMs,
} as const;
