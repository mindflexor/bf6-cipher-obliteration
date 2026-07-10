import type { CapturePointState } from './capture-point-state.ts';
import type { PlayerSessionState } from './player-state.ts';

export enum GamePhase {
    NotStarted = 'NotStarted',
    Prematch = 'Prematch',
    Countdown = 'Countdown',
    Prelive = 'Prelive',
    Live = 'Live',
    HalftimeDeployment = 'HalftimeDeployment',
    SuddenDeath = 'SuddenDeath',
    Postmatch = 'Postmatch',
}

export type CipherHalf = 1 | 2;
export type CipherLane = 'A' | 'B' | 'C' | 'D';

export interface CipherObjectiveState {
    capturePointId: number;
    lane: CipherLane;
    half: CipherHalf;
    defendingTeamId: 1 | 2;
    deliveredKeys: number;
    status: 'active' | 'rebooting';
    rebootDeadlineSeconds?: number;
    deliveryOwnerPlayerId?: number;
}

export interface CipherKeyState {
    status: 'locked' | 'base' | 'carried' | 'dropped' | 'respawning';
    carrierPlayerId?: number;
    baseAnchorId?: number;
    deadlineSeconds?: number;
}

export interface RespawnRouteState {
    playerId: number;
    expectedSessionGeneration: number;
    expectedLifeGeneration: number;
    expectedPhase: GamePhase;
    expectedHalf: CipherHalf;
    expectedTransitionToken: number;
    evaluationDeadlineSeconds: number;
    candidateAnchorIds: number[];
    selectedAnchorId?: number;
    completion: 'evaluating' | 'selected' | 'bypassed' | 'teleported' | 'native-hq-fallback';
}

export interface CipherCommand {
    kind: 'lifecycle' | 'deployment' | 'key-objective' | 'ui-audio' | 'bot';
    playerId?: number;
    sessionGeneration?: number;
    lifeGeneration?: number;
    transitionToken: number;
}

export interface ModuleRuntimeState {
    installed: Record<string, boolean>;
    subscriptions: Array<() => void>;
    installOrder: string[];
}

export interface CipherRuntimeState {
    phase: GamePhase;
    half: CipherHalf;
    scores: [number, number];
    halfScores: [number, number];
    phaseDeadlineSeconds?: number;
    matchDeadlineSeconds?: number;
    transitionToken: number;
    serverTickCount: number;
    phaseTickCount: number;
    roundResetting: boolean;
    players: Map<number, PlayerSessionState>;
    disconnectedPlayers: PlayerSessionState[];
    capturePoints: Map<number, CapturePointState>;
    objectives: Map<number, CipherObjectiveState>;
    key: CipherKeyState;
    respawnRoutes: Map<number, RespawnRouteState>;
    commandLanes: Record<CipherCommand['kind'], CipherCommand[]>;
    readyPlayerIds: Set<number>;
    modules: ModuleRuntimeState;
}

export type RuntimeState = CipherRuntimeState;

export function createRuntimeState(): CipherRuntimeState {
    return {
        phase: GamePhase.NotStarted,
        half: 1,
        scores: [0, 0],
        halfScores: [0, 0],
        transitionToken: 0,
        serverTickCount: 0,
        phaseTickCount: 0,
        roundResetting: false,
        players: new Map<number, PlayerSessionState>(),
        disconnectedPlayers: [],
        capturePoints: new Map<number, CapturePointState>(),
        objectives: new Map<number, CipherObjectiveState>(),
        key: { status: 'locked' },
        respawnRoutes: new Map<number, RespawnRouteState>(),
        commandLanes: {
            lifecycle: [],
            deployment: [],
            'key-objective': [],
            'ui-audio': [],
            bot: [],
        },
        readyPlayerIds: new Set<number>(),
        modules: {
            installed: {},
            subscriptions: [],
            installOrder: [],
        },
    };
}
