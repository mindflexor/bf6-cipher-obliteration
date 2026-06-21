import { RULES } from './rules.ts';

export const UI_CONFIG = {
    phaseSecondIntervalMs: RULES.timerLanes.phaseSecondMs,
    holdUiIntervalMs: RULES.timerLanes.holdUiMs,
    iconFollowIntervalMs: RULES.timerLanes.iconFollowMs,
    noFireEnforceIntervalMs: RULES.timerLanes.noFireEnforceMs,
} as const;
