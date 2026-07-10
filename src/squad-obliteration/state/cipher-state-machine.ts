export type PureCipherPhase =
    | 'prematch'
    | 'countdown'
    | 'prelive'
    | 'live'
    | 'halftime-deployment'
    | 'sudden-death'
    | 'postmatch';

export interface PurePlayerSession {
    playerId: number;
    stableIdentity: string;
    sessionGeneration: number;
    lifeGeneration: number;
    deployed: boolean;
    eliminated: boolean;
    scoreboard: [number, number, number, number, number];
}

export interface PureRespawnRoute {
    playerId: number;
    sessionGeneration: number;
    lifeGeneration: number;
    transitionToken: number;
    selectedAnchorId?: number;
    completion: 'evaluating' | 'selected' | 'bypassed' | 'teleported' | 'native-hq-fallback';
}

export interface PureNodeState {
    lane: 'A' | 'B' | 'C' | 'D';
    deliveredKeys: number;
    rebootDeadline?: number;
}

export interface PureCipherState {
    phase: PureCipherPhase;
    half: 1 | 2;
    transitionToken: number;
    score: [number, number];
    halfScore: [number, number];
    sessions: Map<number, PurePlayerSession>;
    lastSessionGenerationByPlayerId: Map<number, number>;
    reconnectSnapshots: Map<string, PurePlayerSession['scoreboard']>;
    routes: Map<number, PureRespawnRoute>;
    nodes: Record<'A' | 'B' | 'C' | 'D', PureNodeState>;
    key: { status: 'base' | 'carried' | 'dropped' | 'respawning'; carrierPlayerId?: number };
}

function createNodes(): PureCipherState['nodes'] {
    return {
        A: { lane: 'A', deliveredKeys: 0 },
        B: { lane: 'B', deliveredKeys: 0 },
        C: { lane: 'C', deliveredKeys: 0 },
        D: { lane: 'D', deliveredKeys: 0 },
    };
}

export function createPureCipherState(): PureCipherState {
    return {
        phase: 'prematch',
        half: 1,
        transitionToken: 1,
        score: [0, 0],
        halfScore: [0, 0],
        sessions: new Map(),
        lastSessionGenerationByPlayerId: new Map(),
        reconnectSnapshots: new Map(),
        routes: new Map(),
        nodes: createNodes(),
        key: { status: 'base' },
    };
}

export function transitionPureCipherPhase(state: PureCipherState, phase: PureCipherPhase): void {
    state.phase = phase;
    state.transitionToken += 1;
    if (phase === 'halftime-deployment') state.half = 2;
    if (phase === 'sudden-death') state.half = 2;
}

export function resetPureCipherMatch(state: PureCipherState): void {
    state.phase = 'prematch';
    state.half = 1;
    state.transitionToken += 1;
    state.score = [0, 0];
    state.halfScore = [0, 0];
    state.routes.clear();
    state.nodes = createNodes();
    state.key = { status: 'base' };
    for (const session of state.sessions.values()) {
        session.lifeGeneration += 1;
        session.deployed = false;
        session.eliminated = false;
        session.scoreboard = [0, 0, 0, 0, 0];
    }
}

export function connectPurePlayer(
    state: PureCipherState,
    playerId: number,
    stableIdentity: string
): PurePlayerSession {
    const generation = (state.lastSessionGenerationByPlayerId.get(playerId) ?? 0) + 1;
    state.lastSessionGenerationByPlayerId.set(playerId, generation);
    const snapshot = state.reconnectSnapshots.get(stableIdentity) ?? [0, 0, 0, 0, 0];
    const session: PurePlayerSession = {
        playerId,
        stableIdentity,
        sessionGeneration: generation,
        lifeGeneration: 0,
        deployed: false,
        eliminated: state.phase === 'sudden-death',
        scoreboard: [...snapshot] as PurePlayerSession['scoreboard'],
    };
    state.sessions.set(playerId, session);
    return session;
}

export function disconnectPurePlayer(state: PureCipherState, playerId: number): void {
    const session = state.sessions.get(playerId);
    if (!session) return;
    state.reconnectSnapshots.set(session.stableIdentity, [...session.scoreboard] as PurePlayerSession['scoreboard']);
    state.sessions.delete(playerId);
    state.routes.delete(playerId);
    if (state.key.carrierPlayerId === playerId) state.key = { status: 'dropped' };
}

export function closePurePlayerLife(state: PureCipherState, playerId: number): number {
    const session = state.sessions.get(playerId);
    if (!session) return -1;
    session.lifeGeneration += 1;
    session.deployed = false;
    const route = state.routes.get(playerId);
    if (route && route.lifeGeneration !== session.lifeGeneration) state.routes.delete(playerId);
    return session.lifeGeneration;
}

export function createPureRespawnRoute(
    state: PureCipherState,
    playerId: number,
    anchorIds: number[]
): PureRespawnRoute | undefined {
    const session = state.sessions.get(playerId);
    if (!session || state.phase === 'sudden-death') return undefined;
    const route: PureRespawnRoute = {
        playerId,
        sessionGeneration: session.sessionGeneration,
        lifeGeneration: session.lifeGeneration,
        transitionToken: state.transitionToken,
        selectedAnchorId: anchorIds[0],
        completion: anchorIds.length > 0 ? 'selected' : 'native-hq-fallback',
    };
    state.routes.set(playerId, route);
    return route;
}

export function consumePureRespawnRoute(
    state: PureCipherState,
    route: PureRespawnRoute,
    squadSpawned: boolean
): PureRespawnRoute['completion'] | 'stale' {
    const session = state.sessions.get(route.playerId);
    if (
        !session ||
        session.sessionGeneration !== route.sessionGeneration ||
        session.lifeGeneration !== route.lifeGeneration ||
        state.transitionToken !== route.transitionToken
    ) return 'stale';
    if (route.completion === 'teleported' || route.completion === 'bypassed') return route.completion;
    route.completion = squadSpawned ? 'bypassed' : route.selectedAnchorId ? 'teleported' : 'native-hq-fallback';
    return route.completion;
}

export function pickUpPureKey(state: PureCipherState, playerId: number): boolean {
    const session = state.sessions.get(playerId);
    if (!session || session.eliminated || state.key.status === 'carried') return false;
    state.key = { status: 'carried', carrierPlayerId: playerId };
    return true;
}

export function deliverPureKey(
    state: PureCipherState,
    lane: 'A' | 'B' | 'C' | 'D',
    teamIndex: 0 | 1,
    nowSeconds: number
): 'counter' | 'overload' | 'rebooting' {
    if (state.key.status !== 'carried') return 'rebooting';
    const node = state.nodes[lane];
    if (node.rebootDeadline !== undefined && node.rebootDeadline > nowSeconds) return 'rebooting';
    node.deliveredKeys += 1;
    state.key = { status: 'respawning' };
    if (node.deliveredKeys < 2) return 'counter';
    node.deliveredKeys = 0;
    node.rebootDeadline = nowSeconds + 45;
    state.score[teamIndex] += 1;
    state.halfScore[teamIndex] += 1;
    return 'overload';
}

export function processPureNodeReboots(state: PureCipherState, nowSeconds: number): void {
    for (const node of Object.values(state.nodes)) {
        if (node.rebootDeadline !== undefined && nowSeconds >= node.rebootDeadline) {
            node.rebootDeadline = undefined;
        }
    }
}
