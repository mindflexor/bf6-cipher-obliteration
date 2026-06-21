import { GamePhase } from '../state/runtime-state.ts';
import { RULES } from './rules.ts';

export const PHASE_CONFIG = {
    statuses: {
        notStarted: GamePhase.NotStarted,
        prematch: GamePhase.Prematch,
        countdown: GamePhase.Countdown,
        prelive: GamePhase.Prelive,
        live: GamePhase.Live,
        postmatch: GamePhase.Postmatch,
    },
    durationsSeconds: {
        countdown: RULES.countdownTimeSeconds,
        prelive: RULES.preliveTimeSeconds,
        postmatch: RULES.postmatchTimeSeconds,
        round: RULES.roundTimeSeconds,
    },
} as const;
