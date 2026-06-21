export interface WorldIdsConfig {
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
        e: number;
        f: number;
    };
    interactPoints: {
        team1Switch: number;
        team1Ready: number;
        team2Switch: number;
        team2Ready: number;
        spectator: number;
        objectiveByCapturePoint: Record<number, number>;
    };
    areaTriggers: {
        objectiveByCapturePoint: Record<number, number>;
        damage: number;
        restricted: number;
        combatBoundary: number;
        team1HqProtection: number;
        team2HqProtection: number;
        prematchHealth: number;
        bombPickup: number;
    };
    worldIcons: {
        team1Switch: number;
        team1Ready: number;
        team2Switch: number;
        team2Ready: number;
    };
}

const WORLD_CP_A_ID = 201;
const WORLD_CP_B_ID = 202;
const WORLD_CP_E_ID = 301;
const WORLD_CP_F_ID = 302;

export const WORLD_IDS: WorldIdsConfig = {
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
        c: 0,
        d: 0,
        e: WORLD_CP_E_ID,
        f: WORLD_CP_F_ID,
    },
    interactPoints: {
        team1Switch: 2001,
        team1Ready: 2002,
        team2Switch: 2003,
        team2Ready: 2004,
        spectator: 6001,
        objectiveByCapturePoint: {
            [WORLD_CP_A_ID]: 2101,
            [WORLD_CP_B_ID]: 2102,
            [WORLD_CP_E_ID]: 2105,
            [WORLD_CP_F_ID]: 2106,
        },
    },
    areaTriggers: {
        objectiveByCapturePoint: {
            [WORLD_CP_A_ID]: 401,
            [WORLD_CP_B_ID]: 402,
            [WORLD_CP_E_ID]: 503,
            [WORLD_CP_F_ID]: 502,
        },
        damage: 7001,
        restricted: 7003,
        combatBoundary: 9999,
        team1HqProtection: 5101,
        team2HqProtection: 5102,
        prematchHealth: 889,
        bombPickup: 3111,
    },
    worldIcons: {
        team1Switch: 5001,
        team1Ready: 5002,
        team2Switch: 5003,
        team2Ready: 5004,
    },
};
