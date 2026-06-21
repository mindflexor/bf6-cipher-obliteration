import type { CapturePointState } from './capture-point-state.ts';
import type { PlayerState } from './player-state.ts';

export enum GamePhase {
    NotStarted = 'NotStarted',
    Prematch = 'Prematch',
    Countdown = 'Countdown',
    Prelive = 'Prelive',
    Live = 'Live',
    Postmatch = 'Postmatch',
}

export interface PhaseClockHandles {
    phase?: unknown;
    round?: unknown;
}

export interface SchedulerHandles {
    disabledMcomEnforce?: number;
    phaseSecond?: number;
    liveFast?: number;
    liveSlow?: number;
    endgameAudio?: number;
    damageZonePulse?: number;
    iconFollow?: number;
    holdUi?: number;
    noFireEnforce?: number;
    mainLoop?: number;
}

export interface ObjectiveAreaPresenceState {
    byCapturePointId: Record<number, Set<number>>;
    byPlayerId: Record<number, Set<number>>;
}

export interface TransitionSpawnState {
    queuedPlayerIds: Set<number>;
    inflightPlayerIds: Set<number>;
}

export interface HqRoutingState {
    dirty: boolean;
    threatenedFlagTeam1: number | null;
    threatenedFlagTeam2: number | null;
}

export interface BombRuntimeState {
    carrierPlayerId?: number;
    baseSlotIndex: number;
    hasDroppedBomb: boolean;
}

export interface RestrictedAreaRuntimeState {
    activePlayerIds: Set<number>;
    countdownTokenByPlayerId: Record<number, number>;
    activeTriggerIdsByPlayerId: Record<number, Set<number>>;
}

export interface UiRuntimeState {
    liveHudBuiltPlayerIds: Set<number>;
    widgetNamesByPlayerId: Record<number, string[]>;
}

export interface DebugRuntimeState {
    enablePerfTelemetry: boolean;
    enableWorldLogs: boolean;
}

export interface ModuleRuntimeState {
    installed: Record<string, boolean>;
    subscriptions: Array<() => void>;
    installOrder: string[];
}

export interface RuntimeState {
    phase: GamePhase;
    serverTickCount: number;
    phaseTickCount: number;
    roundResetting: boolean;
    phaseClocks: PhaseClockHandles;
    scheduler: SchedulerHandles;
    players: Map<number, PlayerState>;
    disconnectedPlayers: PlayerState[];
    capturePoints: Map<number, CapturePointState>;
    scores: [number, number];
    readyPlayerIds: Set<number>;
    objectiveAreaPresence: ObjectiveAreaPresenceState;
    transitionSpawns: TransitionSpawnState;
    hqRouting: HqRoutingState;
    bomb: BombRuntimeState;
    restrictedArea: RestrictedAreaRuntimeState;
    ui: UiRuntimeState;
    debug: DebugRuntimeState;
    modules: ModuleRuntimeState;
}

export function createRuntimeState(): RuntimeState {
    return {
        phase: GamePhase.NotStarted,
        serverTickCount: 0,
        phaseTickCount: 0,
        roundResetting: false,
        phaseClocks: {},
        scheduler: {},
        players: new Map<number, PlayerState>(),
        disconnectedPlayers: [],
        capturePoints: new Map<number, CapturePointState>(),
        scores: [0, 0],
        readyPlayerIds: new Set<number>(),
        objectiveAreaPresence: {
            byCapturePointId: {},
            byPlayerId: {},
        },
        transitionSpawns: {
            queuedPlayerIds: new Set<number>(),
            inflightPlayerIds: new Set<number>(),
        },
        hqRouting: {
            dirty: true,
            threatenedFlagTeam1: null,
            threatenedFlagTeam2: null,
        },
        bomb: {
            baseSlotIndex: 0,
            hasDroppedBomb: false,
        },
        restrictedArea: {
            activePlayerIds: new Set<number>(),
            countdownTokenByPlayerId: {},
            activeTriggerIdsByPlayerId: {},
        },
        ui: {
            liveHudBuiltPlayerIds: new Set<number>(),
            widgetNamesByPlayerId: {},
        },
        debug: {
            enablePerfTelemetry: false,
            enableWorldLogs: false,
        },
        modules: {
            installed: {},
            subscriptions: [],
            installOrder: [],
        },
    };
}
