import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const source = readFileSync(new URL('../src/squad-obliteration/runtime/mode-runtime.ts', import.meta.url), 'utf8');
const spawnRoutingConfig = readFileSync(
    new URL('../src/squad-obliteration/config/spawn-routing.ts', import.meta.url),
    'utf8'
);

function functionBody(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        if (source[i] === '}') depth -= 1;
        if (depth === 0) return source.slice(bodyStart, i + 1);
    }
    assert.fail(`${name} body is incomplete`);
}

test('live respawns use team queues instead of five-second per-player route timers', () => {
    const undeploy = functionBody('Mode_OnPlayerUndeploy');
    const deployed = functionBody('Mode_OnPlayerDeployed');
    assert.doesNotMatch(source, /CipherRespawnRouteJob|cipherRespawnRoute|routeEvaluationDurationSeconds/);
    assert.match(undeploy, /assignCipherTeamQueuedAnchorToPlayer\(playerId, "live_undeploy"\)/);
    assert.doesNotMatch(undeploy, /Timers\.setInterval/);
    assert.doesNotMatch(deployed, /requestCipherSpawnAnchorForPlayer|processCipherSpawnJobs\("OnPlayerDeployed_LiveAnchor"\)/);
});

test('an undeploy claims the team queue and immediately replaces it', () => {
    const assign = functionBody('assignCipherTeamQueuedAnchorToPlayer');
    assert.match(assign, /cipherAssignedTeamSpawnAnchorByPlayerId\[playerId\]/);
    assert.match(assign, /cipherQueuedAnchorByPlayerId\[playerId\] = anchor/);
    assert.match(assign, /refreshCipherTeamQueuedAnchor\(team, source \+ "_replace"\)/);
    assert.match(assign, /sessionToken: ensurePlayerSessionToken\(playerId\)/);
    assert.match(assign, /lifeGeneration: getPlayerLifeGeneration\(playerId\)/);
});

test('team queues use objective pressure and all four quadrant presence inputs', () => {
    const select = functionBody('selectCipherTeamQueuedAnchor');
    assert.match(select, /buildCipherTeamQueueRegionCandidates/);
    assert.match(functionBody('buildCipherTeamQueueRegionCandidates'), /getCipherObjectivePressureTarget/);
    assert.match(functionBody('buildCipherTeamQueueRegionCandidates'), /appendCipherForwardRegionsByLowestPressure/);
    assert.match(functionBody('markCipherPresenceZoneActive'), /refreshAllCipherTeamQueuedAnchors/);
    assert.match(functionBody('clearCipherPresenceZoneActive'), /refreshAllCipherTeamQueuedAnchors/);
    assert.match(functionBody('startCipherNodeReboot'), /refreshAllCipherTeamQueuedAnchors/);
    assert.match(functionBody('reactivateCipherNode'), /refreshAllCipherTeamQueuedAnchors/);
});

test('team queues are built at live start and rebuilt after a transition', () => {
    const liveInitialization = functionBody('processLiveInitializationStep');
    assert.match(liveInitialization, /liveInitializationTeamQueueCursor === 0/);
    assert.match(liveInitialization, /refreshCipherTeamQueuedAnchor\(team1, "live_initialization_team1"\)/);
    assert.match(liveInitialization, /refreshCipherTeamQueuedAnchor\(team2, "live_initialization_team2"\)/);
    assert.match(functionBody('finalizeCipherTransitionLiveStart'), /refreshAllCipherTeamQueuedAnchors/);
    assert.match(functionBody('resetCipherSpawnRoutingState'), /clearCipherTeamQueuedAnchors/);
});

test('only the bounded post-deploy check evaluates nearby enemies for an assigned anchor', () => {
    const check = functionBody('runSafeSpawnCheck');
    const finalize = functionBody('finalizeSafeSpawnDeploySuccess');
    const teleport = functionBody('teleportCipherPlayerToRoutedAnchor');
    assert.match(spawnRoutingConfig, /safeSpawnCheckDelaySeconds:\s*0\.1/);
    assert.match(check, /getCurrentCipherTeamSpawnAssignment/);
    assert.match(check, /getCachedCipherAnchorPosition\(assignment\.anchor\.anchorObjectId\)/);
    assert.match(check, /countCipherEnemiesNearPositionWithinRadius/);
    assert.match(check, /selectNextSafeCipherSpawnCandidate/);
    assert.match(check, /refreshCipherTeamQueuedAnchor\(team, "final_unsafe"\)/);
    assert.doesNotMatch(check, /queueForcedSafeSpawnRetryForCurrentRoute/);
    assert.doesNotMatch(finalize, /hasEnemyNearPosition/);
    assert.doesNotMatch(teleport, /isCipherAnchorSafeFromEnemies/);
});

test('unsafe final checks remain generation guarded and reroute the same life', () => {
    const assignment = functionBody('getCurrentCipherTeamSpawnAssignment');
    const finalize = functionBody('finalizeSafeSpawnDeploySuccess');
    assert.match(assignment, /isCurrentPlayerSession/);
    assert.match(assignment, /lifeGeneration !== getPlayerLifeGeneration/);
    assert.match(assignment, /expectedMatchStage !== cipherMatchStage/);
    assert.match(finalize, /teleportCipherPlayerToRoutedAnchor\(player, playerId, false\)/);
    assert.match(finalize, /queueForcedSafeSpawnRetryForCurrentRoute/);
    const reroute = functionBody('selectNextSafeCipherSpawnCandidate');
    assert.match(reroute, /candidateChecksPerTick/);
    assert.match(reroute, /applyCipherSpawnAssignmentCandidate/);
    assert.match(reroute, /"deferred"/);
});

test('pressure uses opposite lane rear anchors while clear nodes use forward variants', () => {
    const pressure = functionBody('getCipherObjectivePressureTarget');
    const candidates = functionBody('buildCipherTeamQueueRegionCandidates');
    assert.match(pressure, /lane === "west" \? "east" : "west"/);
    assert.match(pressure, /isCipherNodeRebooting|isObjectiveDisabledAfterAward/);
    assert.match(candidates, /objectivePressure\.region/);
    assert.match(candidates, /appendCipherForwardRegionsByLowestPressure/);
    assert.match(functionBody('getCipherForwardSpawnRegion'), /"north" \? "south" : "north"/);
    assert.match(functionBody('selectCipherTeamQueuedAnchor'), /getCipherAnchorRoutingDistanceSquared/);
});

test('live deploy remains bounded and does not rebuild HUD widgets', () => {
    const deployed = functionBody('Mode_OnPlayerDeployed');
    assert.match(deployed, /repairCipherKeyHudCacheForPlayer\(p, false\)/);
    assert.match(deployed, /queueSafeSpawnCheckForPlayer\(playerId\)/);
    assert.doesNotMatch(deployed, /queueLiveHudBuild|rebuildPlayerLiveHud|buildRestrictedAreaUiForPlayer/);
});
