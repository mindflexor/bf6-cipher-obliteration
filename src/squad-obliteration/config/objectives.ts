import { WORLD_IDS } from './world-ids.ts';

export type ObjectiveLane = 'A' | 'B' | 'C' | 'D';
export type ObjectiveHalf = 1 | 2;
export type ObjectiveSide = 'north' | 'south';

export interface SquadObjectiveConfig {
    cpId: number;
    mcomId?: number;
    lane: ObjectiveLane;
    displayLane?: ObjectiveLane;
    half: ObjectiveHalf;
    side: ObjectiveSide;
    sectorId: number;
    anchorId: number;
    defendingTeamId: 1 | 2;
    countsForRouting: boolean;
}

export const SQUAD_OBJECTIVE_CONFIGS: SquadObjectiveConfig[] = [
    {
        cpId: WORLD_IDS.capturePoints.a,
        mcomId: 7101,
        lane: 'A',
        displayLane: 'A',
        half: 1,
        side: 'north',
        sectorId: 200,
        anchorId: 215,
        defendingTeamId: 1,
        countsForRouting: true,
    },
    {
        cpId: WORLD_IDS.capturePoints.b,
        mcomId: 7102,
        lane: 'B',
        displayLane: 'B',
        half: 1,
        side: 'north',
        sectorId: 200,
        anchorId: 216,
        defendingTeamId: 1,
        countsForRouting: true,
    },
    {
        cpId: WORLD_IDS.capturePoints.c,
        mcomId: 7103,
        lane: 'C',
        displayLane: 'C',
        half: 1,
        side: 'south',
        sectorId: 200,
        anchorId: 217,
        defendingTeamId: 2,
        countsForRouting: true,
    },
    {
        cpId: WORLD_IDS.capturePoints.d,
        mcomId: 7104,
        lane: 'D',
        displayLane: 'D',
        half: 1,
        side: 'south',
        sectorId: 200,
        anchorId: 218,
        defendingTeamId: 2,
        countsForRouting: true,
    },
    {
        cpId: WORLD_IDS.capturePoints.aSecondHalf,
        lane: 'A',
        displayLane: 'A',
        half: 2,
        side: 'north',
        sectorId: 300,
        anchorId: 215,
        defendingTeamId: 2,
        countsForRouting: true,
    },
    {
        cpId: WORLD_IDS.capturePoints.bSecondHalf,
        lane: 'B',
        displayLane: 'B',
        half: 2,
        side: 'north',
        sectorId: 300,
        anchorId: 216,
        defendingTeamId: 2,
        countsForRouting: true,
    },
    {
        cpId: WORLD_IDS.capturePoints.cSecondHalf,
        lane: 'C',
        displayLane: 'C',
        half: 2,
        side: 'south',
        sectorId: 300,
        anchorId: 217,
        defendingTeamId: 1,
        countsForRouting: true,
    },
    {
        cpId: WORLD_IDS.capturePoints.dSecondHalf,
        lane: 'D',
        displayLane: 'D',
        half: 2,
        side: 'south',
        sectorId: 300,
        anchorId: 218,
        defendingTeamId: 1,
        countsForRouting: true,
    },
];

export const SQUAD_ROUTING_CAPTURE_POINT_IDS: number[] = [
    WORLD_IDS.capturePoints.a,
    WORLD_IDS.capturePoints.b,
    WORLD_IDS.capturePoints.c,
    WORLD_IDS.capturePoints.d,
    WORLD_IDS.capturePoints.aSecondHalf,
    WORLD_IDS.capturePoints.bSecondHalf,
    WORLD_IDS.capturePoints.cSecondHalf,
    WORLD_IDS.capturePoints.dSecondHalf,
];
