import { WORLD_IDS } from './world-ids.ts';

export const BOMB_CONFIG = {
    anchorSectorId: WORLD_IDS.key.sector,
    // Overload-style cipher key spawning uses exactly three center anchors.
    anchorObjectIds: WORLD_IDS.key.anchors,
    liveStartInitialSpawnDelaySeconds: 20,
    objectiveDestroyRespawnDelaySeconds: 0,
    cipherKeyDeliveryRespawnDelaySeconds: 20,
    playerDroppedRelocationDelaySeconds: 20,
    playerDroppedExplosionRespawnDelaySeconds: 5,
    playerDroppedExplosionDamageRadiusMeters: 0,
    playerDroppedExplosionDamage: 0,
    dynamicSpawnRetryDelaySeconds: 2,
} as const;
