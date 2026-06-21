export interface ZiplineDefinition {
    // The player must be inside this area trigger for the shared interact point to activate this zipline.
    areaTriggerId: number;
    // The runtime mover spawns at this anchor, then ascends vertically toward finalTargetY.
    anchorObjectId: number;
    ascentDurationSeconds?: number;
    earlyUnlockSeconds?: number;
    moverPrefab?: mod.RuntimeSpawn_Common;
    moverScale?: mod.Vector;
    rideSfxPrefab?: mod.RuntimeSpawn_Common;
    rideSfxAmplitude?: number;
    rideSfxAttenuationRange?: number;
}

export interface ZiplineConfig {
    interactPointId: number;
    finalTargetY: number;
    ascentDurationSeconds: number;
    earlyUnlockSeconds: number;
    movementEpsilon: number;
    moverPrefab: mod.RuntimeSpawn_Common;
    moverScale: mod.Vector;
    rideSfxPrefab?: mod.RuntimeSpawn_Common;
    rideSfxAmplitude: number;
    rideSfxAttenuationRange: number;
    ziplines: readonly ZiplineDefinition[];
}

export const ZIPLINE_CONFIG: ZiplineConfig = {
    interactPointId: 9301,
    finalTargetY: 41.5,
    ascentDurationSeconds: 2.0,
    earlyUnlockSeconds: 0.5,
    movementEpsilon: 0.001,
    moverPrefab: mod.RuntimeSpawn_Common.WalkwayLadder_512_NoDestruction,
    moverScale: mod.CreateVector(1, 0.01, 0.01),
    rideSfxPrefab: mod.RuntimeSpawn_Common.SFX_Levels_Cairo_SP_NightRaid_Spots_RopeStress_OneShot3D,
    rideSfxAmplitude: 1.0,
    rideSfxAttenuationRange: 10,
    ziplines: [
        // One shared interact point controls all configured ziplines.
        {
            areaTriggerId: 9311,
            anchorObjectId: 9321,
        },
        {
            areaTriggerId: 9312,
            anchorObjectId: 9322,
            ascentDurationSeconds: 2.5,
        },
        {
            areaTriggerId: 9313,
            anchorObjectId: 9323,
        },
    ],
};
