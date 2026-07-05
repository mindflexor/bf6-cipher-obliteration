export const SPAWN_ROUTING_CONFIG = {
    safeSpawnCheckDelaySeconds: 0.1,
    squadSpawnProbeWindowSeconds: 0.25,
    squadSpawnProbeIntervalSeconds: 0.05,
    squadSpawnBypassLifetimeSeconds: 1.0,
    routeEvaluationDurationSeconds: 5,
    routeEvaluationTickSeconds: 1,
    objectivePressureRadiusMeters: 25,
    queuedCandidateSafetyRadiusMeters: 40,
    rerouteSafetyRadiusMeters: 20,
} as const;
