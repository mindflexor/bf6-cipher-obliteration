import { WORLD_IDS } from './world-ids.ts';

export const BOMB_CONFIG = {
    pickupTriggerId: WORLD_IDS.areaTriggers.bombPickup,
    anchorSectorId: 3100,
    // Overload-style cipher key spawning uses exactly three center anchors.
    anchorObjectIds: [3101, 3102, 3103],
    quadBikeSpawnObjectId: 0,
    liveStartInitialSpawnDelaySeconds: 20,
    objectiveDestroyRespawnDelaySeconds: 0,
    cipherKeyDeliveryRespawnDelaySeconds: 20,
    playerDroppedRelocationDelaySeconds: 20,
    playerDroppedExplosionRespawnDelaySeconds: 5,
    playerDroppedExplosionDamageRadiusMeters: 0,
    playerDroppedExplosionDamage: 0,
    dynamicSpawnRetryDelaySeconds: 2,
} as const;
