import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const source = readFileSync(
    new URL('../src/squad-obliteration/runtime/mode-runtime.ts', import.meta.url),
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

test('deploy-screen route evaluation does not query the undeployed player handle', () => {
    const currentCheck = functionBody('isCipherRespawnRouteJobCurrent');
    const tick = functionBody('tickCipherRespawnRouteJob');
    assert.doesNotMatch(currentCheck, /GetTeam\(sp\.player\)|GetSoldierState|GetSquad/);
    assert.doesNotMatch(tick, /GetTeam\(sp\.player\)|GetSoldierState|GetSquad/);
    assert.match(tick, /mod\.GetTeam\(job\.teamId\)/);
});

test('deployed route teleports immediately and consumes before teleport', () => {
    const seal = functionBody('sealCipherRespawnRouteJobForDeploy');
    const settle = functionBody('settleAndConsumeCipherRespawnRoute');
    assert.match(seal, /settleAndConsumeCipherRespawnRoute\(playerId, job\.token\)/);
    assert.doesNotMatch(seal, /scheduleCipherGlobalTask/);
    assert.ok(
        settle.indexOf('delete cipherRespawnRouteJobByPlayerId[playerId]') <
            settle.indexOf('mod.Teleport(player, anchorPos, yawRadians)')
    );
    assert.equal(settle.match(/mod\.Teleport\(player, anchorPos, yawRadians\)/g)?.length, 1);
});

test('spawn anchor objects are warmed once at game-mode start', () => {
    const started = functionBody('Mode_OnGameModeStarted');
    const warm = functionBody('warmCipherSpawnAnchorPositionCache');
    assert.match(started, /warmCipherSpawnAnchorPositionCache\(\)/);
    assert.match(warm, /getCachedCipherAnchorPosition/);
});

test('undeploy synchronously starts the known-good interval route without scoreboard rendering', () => {
    const undeploy = functionBody('recordPlayerUndeployedMinimal');
    const startRoute = functionBody('startCipherRespawnRouteJobForPlayer');
    const cancelRoute = functionBody('cancelCipherRespawnRouteJobForPlayer');

    assert.match(undeploy, /startCipherRespawnRouteJobForPlayer/);
    assert.match(undeploy, /p\.addDeath\(\)/);
    assert.doesNotMatch(undeploy, /recordScoreboardDeathForPlayer|updateScoreboard/);
    assert.doesNotMatch(undeploy, /playerUndeployCleanupQueue/);
    assert.match(startRoute, /Timers\.setInterval/);
    assert.match(cancelRoute, /Timers\.clearInterval/);
});

test('global scheduler does not own live respawn route timing', () => {
    const ongoing = functionBody('OngoingGlobal_Inner');
    assert.doesNotMatch(ongoing, /processCipherRespawnRouteJobs/);
});
