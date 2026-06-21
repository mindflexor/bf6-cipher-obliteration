import { WORLD_IDS } from './world-ids.ts';

export type ObjectiveLane = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface SquadObjectiveConfig {
    cpId: number;
    mcomId: number;
    lane: ObjectiveLane;
    displayLane?: 'A' | 'B';
    defendingTeamId: 1 | 2;
    countsForRouting: boolean;
}

export const SQUAD_OBJECTIVE_CONFIGS: SquadObjectiveConfig[] = [
    {
        cpId: WORLD_IDS.capturePoints.a,
        mcomId: 7101,
        lane: 'A',
        displayLane: 'A',
        defendingTeamId: 1,
        countsForRouting: true,
    },
    {
        cpId: WORLD_IDS.capturePoints.b,
        mcomId: 7102,
        lane: 'B',
        displayLane: 'B',
        defendingTeamId: 1,
        countsForRouting: true,
    },
    {
        cpId: WORLD_IDS.capturePoints.e,
        mcomId: 7201,
        lane: 'E',
        displayLane: 'A',
        defendingTeamId: 2,
        countsForRouting: true,
    },
    {
        cpId: WORLD_IDS.capturePoints.f,
        mcomId: 7202,
        lane: 'F',
        displayLane: 'B',
        defendingTeamId: 2,
        countsForRouting: true,
    },
];

export const SQUAD_ROUTING_CAPTURE_POINT_IDS: number[] = [
    WORLD_IDS.capturePoints.a,
    WORLD_IDS.capturePoints.b,
    WORLD_IDS.capturePoints.e,
    WORLD_IDS.capturePoints.f,
];
