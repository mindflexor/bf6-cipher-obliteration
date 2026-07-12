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

test('deploy-screen route evaluation never queries an undeployed player handle', () => {
    const currentCheck = functionBody('isCipherRespawnRouteJobCurrent');
    const tick = functionBody('tickCipherRespawnRouteJob');
    assert.doesNotMatch(currentCheck, /GetTeam\(sp\.player\)|GetSoldierState|GetSquad/);
    assert.doesNotMatch(tick, /GetTeam\(sp\.player\)|GetSoldierState|GetSquad/);
    assert.match(tick, /mod\.GetTeam\(job\.teamId\)/);
});

test('live deploy uses the direct known-good path without rebuilding HUD widgets', () => {
    const deployed = functionBody('Mode_OnPlayerDeployed');
    assert.match(deployed, /repairCipherKeyHudCacheForPlayer\(p, false\)/);
    assert.match(deployed, /recordLastLiveHqSpawnSourceFromDeploy/);
    assert.match(deployed, /isNativeFriendlyOrSquadSpawn/);
    assert.match(deployed, /queueSafeSpawnCheckForPlayer\(playerId\)/);
    assert.doesNotMatch(deployed, /queueLiveHudBuild|rebuildPlayerLiveHud|buildRestrictedAreaUiForPlayer/);
    assert.doesNotMatch(deployed, /SetScoreboardPlayerValues|UpdateScoreboard|updateScoreboard/);
    assert.doesNotMatch(source, /function recordPlayerDeployedMinimal|function commitDeployedHumanPlayerNow/);
});

test('normal live deploy finalizes the route and queues one generation-guarded check', () => {
    const deployed = functionBody('Mode_OnPlayerDeployed');
    const queue = functionBody('queueSafeSpawnCheckForPlayer');
    assert.match(deployed, /finalizeCipherRespawnRouteJobForPlayer/);
    assert.match(deployed, /requestCipherSpawnAnchorForPlayer/);
    assert.match(deployed, /queueSafeSpawnCheckForPlayer\(playerId\)/);
    assert.match(queue, /safeSpawnCheckQueuedGenerationByPlayerId\[playerId\] === generation/);
    assert.match(queue, /generation,/);
});

test('objective pressure uses authored A east, B west, C west, D east geometry', () => {
    const lane = functionBody('getCipherPresenceLaneForObjective');
    assert.match(lane, /def\.lane === "A" \|\| def\.lane === "D" \? "east" : "west"/);
});

test('respawn routing resamples pressure at finalization and consumes the route once', () => {
    const tick = functionBody('tickCipherRespawnRouteJob');
    const finalize = functionBody('finalizeCipherRespawnRouteJobForPlayer');
    const teleport = functionBody('teleportCipherPlayerToRoutedAnchor');
    assert.match(tick, /Continuously refresh the preferred quadrant/);
    assert.match(tick, /selectCipherRespawnRouteCandidate/);
    assert.ok(
        finalize.indexOf('selectCipherRespawnRouteCandidate') <
            finalize.indexOf('job.finalizedCandidate = candidate')
    );
    assert.match(teleport, /routeJob\.status = "consumed"/);
    assert.match(teleport, /delete cipherRespawnRouteJobByPlayerId\[playerId\]/);
});

test('safe-spawn queue waits 0.1 seconds and is bounded', () => {
    const queue = functionBody('queueSafeSpawnCheckForPlayer');
    const process = functionBody('processSafeSpawnCheckQueue');
    assert.match(spawnRoutingConfig, /safeSpawnCheckDelaySeconds:\s*0\.1/);
    assert.match(source, /const SAFE_SPAWN_CHECK_DELAY_TICKS = CIPHER_RESPAWN_POST_DEPLOY_DELAY_TICKS/);
    assert.match(source, /const SAFE_SPAWN_CHECKS_PER_TICK = 2/);
    assert.match(queue, /dueTick: serverTickCount \+ SAFE_SPAWN_CHECK_DELAY_TICKS/);
    assert.match(process, /item\.dueTick > serverTickCount/);
    assert.match(process, /processed >= SAFE_SPAWN_CHECKS_PER_TICK/);
});

test('delayed safe check validates generation and deployed state before placement', () => {
    const check = functionBody('runSafeSpawnCheck');
    assert.match(check, /item\.generation !== getSafeSpawnGeneration/);
    assert.match(check, /!p \|\| !p\.isDeployed \|\| !mod\.IsPlayerValid/);
    assert.match(check, /isPlayerAliveSafe/);
    assert.match(check, /isNativeFriendlyOrSquadSpawn/);
    assert.match(check, /finalizeSafeSpawnDeploySuccess/);
    assert.doesNotMatch(check, /queueLiveHudBuild|SetScoreboardPlayerValues|UpdateScoreboard/);
});

test('safe-spawn success is the normal-live teleport boundary', () => {
    const finalize = functionBody('finalizeSafeSpawnDeploySuccess');
    const teleport = functionBody('teleportCipherPlayerToRoutedAnchor');
    assert.match(finalize, /teleportCipherPlayerToRoutedAnchor\(player, playerId\)/);
    assert.match(finalize, /queueForcedSafeSpawnRetryForCurrentRoute/);
    assert.ok(
        teleport.indexOf('delete cipherQueuedAnchorByPlayerId[playerId]') <
            teleport.indexOf('(mod as any).Teleport(player, anchorPos, yawRadians)')
    );
    assert.equal(teleport.match(/\.Teleport\(player, anchorPos, yawRadians\)/g)?.length, 1);
});

test('forced fallback uses the stable HQ-to-player-spawner mapping and bounded retries', () => {
    const retry = functionBody('queueForcedSafeSpawnRetryForCurrentRoute');
    const process = functionBody('processForcedSafeSpawnQueue');
    assert.match(source, /const HQ_TO_PLAYERSPAWNER_ID:[\s\S]*1: 11, 2: 12, 3: 13, 4: 14/);
    assert.match(retry, /used >= SAFE_SPAWN_MAX_FORCED_REDEPLOYS/);
    assert.match(retry, /safeSpawnForcedQueuedGenerationByPlayerId/);
    assert.match(process, /SAFE_SPAWN_FORCED_QUEUE_BUDGET_PER_TICK/);
    assert.match(process, /trySpawnPlayerFromSpawnPointSafe/);
});

test('duplicate deploy callbacks and manual undeploy are generation guarded', () => {
    const deployed = functionBody('Mode_OnPlayerDeployed');
    const undeploy = functionBody('Mode_OnPlayerUndeploy');
    assert.match(deployed, /bumpSafeSpawnGeneration\(playerId\)/);
    assert.match(deployed, /queueSafeSpawnCheckForPlayer\(playerId\)/);
    assert.match(undeploy, /removeSafeSpawnCheckForPlayer\(playerId\)/);
    assert.match(undeploy, /bumpSafeSpawnGeneration\(playerId\)/);
    assert.match(undeploy, /beginNextPlayerLife\(playerId\)/);
    assert.match(undeploy, /startCipherRespawnRouteJobForPlayer/);
});

test('runtime snapshots all configured anchor vectors once per game-mode load', () => {
    const started = functionBody('Mode_OnGameModeStarted');
    const warm = functionBody('warmCipherSpawnAnchorPositionCache');
    const cached = functionBody('getCachedCipherAnchorPosition');
    assert.match(started, /startupPipelineAnchorIds = getStartupSpawnAnchorIds\(\)/);
    assert.match(functionBody('processStartupPipelineStep'), /getCachedCipherAnchorPosition\(startupPipelineAnchorIds\[startupPipelineAnchorCursor\]\)/);
    assert.match(warm, /cipherAnchorPositionByObjectId = \{\}/);
    assert.match(warm, /getCachedCipherAnchorPosition\(ids\[anchorIndex\]\)/);
    assert.match(cached, /mod\.GetSpatialObject\(anchorId\)/);
    assert.match(cached, /mod\.GetObjectPosition\(spatialAnchor\)/);
    assert.match(cached, /snapshotVector\(position\)/);
    assert.match(cached, /Number\.isFinite\(snapshot\.x\)/);
    assert.match(cached, /mod\.CreateVector\(snapshot\.x, snapshot\.y, snapshot\.z\)/);
    assert.doesNotMatch(functionBody('runSafeSpawnCheck'), /GetSpatialObject|GetObjectPosition|CreateVector/);
});

test('pending join acknowledgement re-enters the direct deploy handler after activation', () => {
    const activate = functionBody('activatePendingPlayerSession');
    assert.match(activate, /player\.isDeployed = false/);
    assert.match(activate, /if \(pending\.deployAckSeen\)/);
    assert.match(activate, /Mode_OnPlayerDeployed\(player\.player\)/);
});

test('scheduler owns the bounded safe-spawn and forced-fallback lanes only', () => {
    const supervisor = functionBody('processPlayerLifecycleSupervisor');
    assert.match(supervisor, /processForcedSafeSpawnQueue\(\)/);
    assert.match(supervisor, /processSafeSpawnCheckQueue\(\)/);
    assert.doesNotMatch(source, /PlayerDeployPlacement|processPlayerDeployPlacementQueue|CipherRespawnTeleportHandoff/);
});

test('player map has no implicit engine validation fan-out', () => {
    assert.match(source, /const serverPlayers = new Map<number, Player>\(\)/);
    assert.doesNotMatch(source, /class ActivePlayerMap/);
});
