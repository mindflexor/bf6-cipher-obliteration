import { WORLD_IDS } from './world-ids.ts';

export const BOMB_CONFIG = {
    pickupTriggerId: WORLD_IDS.areaTriggers.bombPickup,
    anchorSectorId: 3100,
    anchorCapturePointIds: [3101, 3102, 3103, 3104, 3105],
    quadBikeSpawnCapturePointId: 3106,
    liveStartInitialSpawnDelaySeconds: 15,
    objectiveDestroyRespawnDelaySeconds: 0,
    cipherKeyDeliveryRespawnDelaySeconds: 15,
    playerDroppedRelocationDelaySeconds: 30,
    playerDroppedExplosionRespawnDelaySeconds: 5,
    playerDroppedExplosionDamageRadiusMeters: 0,
    playerDroppedExplosionDamage: 0,
    dynamicSpawnRetryDelaySeconds: 2,
} as const;
