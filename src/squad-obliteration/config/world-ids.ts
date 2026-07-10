export interface CipherWorldConfig {
    hq: {
        team1Initial: number;
        team2Initial: number;
        team1Readyup: number;
        team2Readyup: number;
        team1Live: number;
        team2Live: number;
    };
    capturePoints: {
        a: number;
        b: number;
        c: number;
        d: number;
        aSecondHalf: number;
        bSecondHalf: number;
        cSecondHalf: number;
        dSecondHalf: number;
    };
    objectiveSectors: {
        firstHalf: number;
        secondHalf: number;
    };
    objectivePositionAnchors: Record<number, number>;
    objectiveVisuals: {
        explosionVfxByCapturePoint: Record<number, number>;
        worldIconByCapturePoint: Record<number, number>;
        primaryVfxByCapturePoint: Record<number, number>;
        secondaryVfxByCapturePoint: Record<number, number>;
    };
    interactPoints: {
        team1Switch: number;
        team1Ready: number;
        team2Switch: number;
        team2Ready: number;
        objectiveByCapturePoint: Record<number, number>;
    };
    areaTriggers: {
        objectiveByCapturePoint: Record<number, number>;
        restricted: number;
        combatBoundary: number;
        prematchHealth: number;
    };
    worldIcons: {
        team1Switch: number;
        team1Ready: number;
        team2Switch: number;
        team2Ready: number;
    };
    firstDeployAnchors: {
        north: number[];
        south: number[];
    };
    respawnAnchors: {
        northEastNorth: number[];
        northEastSouth: number[];
        northWestNorth: number[];
        northWestSouth: number[];
        southEastNorth: number[];
        southEastSouth: number[];
        southWestNorth: number[];
        southWestSouth: number[];
    };
    presenceTriggers: {
        northWest: number;
        northEast: number;
        southWest: number;
        southEast: number;
    };
    key: {
        sector: number;
        anchors: number[];
    };
    bots: {
        team1Spawner: number;
        team2Spawner: number;
    };
    postmatch: {
        camera: number;
        anchor: number;
    };
}

export type WorldIdsConfig = CipherWorldConfig;

const WORLD_CP_A_ID = 201;
const WORLD_CP_B_ID = 202;
const WORLD_CP_C_ID = 203;
const WORLD_CP_D_ID = 204;
const WORLD_CP_A_SECOND_HALF_ID = 301;
const WORLD_CP_B_SECOND_HALF_ID = 302;
const WORLD_CP_C_SECOND_HALF_ID = 303;
const WORLD_CP_D_SECOND_HALF_ID = 304;

export const WORLD_IDS: CipherWorldConfig = {
    hq: {
        team1Initial: 1,
        team2Initial: 2,
        team1Readyup: 8888,
        team2Readyup: 8889,
        team1Live: 3,
        team2Live: 4,
    },
    capturePoints: {
        a: WORLD_CP_A_ID,
        b: WORLD_CP_B_ID,
        c: WORLD_CP_C_ID,
        d: WORLD_CP_D_ID,
        aSecondHalf: WORLD_CP_A_SECOND_HALF_ID,
        bSecondHalf: WORLD_CP_B_SECOND_HALF_ID,
        cSecondHalf: WORLD_CP_C_SECOND_HALF_ID,
        dSecondHalf: WORLD_CP_D_SECOND_HALF_ID,
    },
    objectiveSectors: {
        firstHalf: 200,
        secondHalf: 300,
    },
    objectivePositionAnchors: {
        [WORLD_CP_A_ID]: 215,
        [WORLD_CP_B_ID]: 216,
        [WORLD_CP_C_ID]: 217,
        [WORLD_CP_D_ID]: 218,
        [WORLD_CP_A_SECOND_HALF_ID]: 215,
        [WORLD_CP_B_SECOND_HALF_ID]: 216,
        [WORLD_CP_C_SECOND_HALF_ID]: 217,
        [WORLD_CP_D_SECOND_HALF_ID]: 218,
    },
    objectiveVisuals: {
        explosionVfxByCapturePoint: {
            [WORLD_CP_A_ID]: 8101, [WORLD_CP_B_ID]: 8102, [WORLD_CP_C_ID]: 8103, [WORLD_CP_D_ID]: 8201,
            [WORLD_CP_A_SECOND_HALF_ID]: 8101, [WORLD_CP_B_SECOND_HALF_ID]: 8102,
            [WORLD_CP_C_SECOND_HALF_ID]: 8103, [WORLD_CP_D_SECOND_HALF_ID]: 8201,
        },
        worldIconByCapturePoint: {
            [WORLD_CP_A_ID]: 221, [WORLD_CP_B_ID]: 222, [WORLD_CP_C_ID]: 223, [WORLD_CP_D_ID]: 321,
            [WORLD_CP_A_SECOND_HALF_ID]: 221, [WORLD_CP_B_SECOND_HALF_ID]: 222,
            [WORLD_CP_C_SECOND_HALF_ID]: 223, [WORLD_CP_D_SECOND_HALF_ID]: 321,
        },
        primaryVfxByCapturePoint: {
            [WORLD_CP_A_ID]: 211, [WORLD_CP_B_ID]: 212, [WORLD_CP_C_ID]: 213, [WORLD_CP_D_ID]: 311,
            [WORLD_CP_A_SECOND_HALF_ID]: 211, [WORLD_CP_B_SECOND_HALF_ID]: 212,
            [WORLD_CP_C_SECOND_HALF_ID]: 213, [WORLD_CP_D_SECOND_HALF_ID]: 311,
        },
        secondaryVfxByCapturePoint: {
            [WORLD_CP_A_ID]: 611, [WORLD_CP_B_ID]: 612, [WORLD_CP_C_ID]: 613, [WORLD_CP_D_ID]: 711,
            [WORLD_CP_A_SECOND_HALF_ID]: 611, [WORLD_CP_B_SECOND_HALF_ID]: 612,
            [WORLD_CP_C_SECOND_HALF_ID]: 613, [WORLD_CP_D_SECOND_HALF_ID]: 711,
        },
    },
    interactPoints: {
        team1Switch: 2001,
        team1Ready: 2002,
        team2Switch: 2003,
        team2Ready: 2004,
        objectiveByCapturePoint: {
            [WORLD_CP_A_ID]: 2101,
            [WORLD_CP_B_ID]: 2102,
            [WORLD_CP_C_ID]: 2103,
            [WORLD_CP_D_ID]: 2104,
            [WORLD_CP_A_SECOND_HALF_ID]: 2101,
            [WORLD_CP_B_SECOND_HALF_ID]: 2102,
            [WORLD_CP_C_SECOND_HALF_ID]: 2103,
            [WORLD_CP_D_SECOND_HALF_ID]: 2104,
        },
    },
    areaTriggers: {
        objectiveByCapturePoint: {
            [WORLD_CP_A_ID]: 401,
            [WORLD_CP_B_ID]: 402,
            [WORLD_CP_C_ID]: 403,
            [WORLD_CP_D_ID]: 404,
            [WORLD_CP_A_SECOND_HALF_ID]: 401,
            [WORLD_CP_B_SECOND_HALF_ID]: 402,
            [WORLD_CP_C_SECOND_HALF_ID]: 403,
            [WORLD_CP_D_SECOND_HALF_ID]: 404,
        },
        restricted: 7003,
        combatBoundary: 9999,
        prematchHealth: 889,
    },
    worldIcons: {
        team1Switch: 5001,
        team1Ready: 5002,
        team2Switch: 5003,
        team2Ready: 5004,
    },
    firstDeployAnchors: {
        north: [1511, 1512, 1513, 1514],
        south: [3511, 3512, 3513, 3514],
    },
    respawnAnchors: {
        northEastNorth: [1411, 1412, 1413, 1414, 1415],
        northEastSouth: [1421, 1422, 1423, 1424, 1425],
        northWestNorth: [2311, 2312, 2313, 2314, 2315],
        northWestSouth: [2321, 2322, 2323, 2324, 2325],
        southEastNorth: [3411, 3412, 3413, 3414, 3415],
        southEastSouth: [3421, 3422, 3423, 3424, 3425],
        southWestNorth: [4311, 4312, 4313, 4314, 4315],
        southWestSouth: [4321, 4322, 4323, 4324, 4325],
    },
    presenceTriggers: {
        northWest: 901,
        northEast: 902,
        southWest: 903,
        southEast: 904,
    },
    key: {
        sector: 3100,
        anchors: [3101, 3102, 3103],
    },
    bots: {
        team1Spawner: 8085,
        team2Spawner: 8086,
    },
    postmatch: {
        camera: 4646,
        anchor: 4747,
    },
};
