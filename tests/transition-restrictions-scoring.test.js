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

test('restriction profiles never cross the soldier boundary before stored deployed state', () => {
    const gate = functionBody('isPlayerFullyDeployedForRestrictions');
    const apply = functionBody('tryApplyDesiredRestrictionProfileForPlayerId');
    assert.ok(gate.indexOf('!sp || !sp.isDeployed') < gate.indexOf('isPlayerAliveSafe'));
    assert.match(gate, /playerInMandownByPlayerId/);
    assert.match(apply, /isPlayerFullyDeployedForRestrictions/);
    assert.match(functionBody('processPendingRestrictionProfiles'), /restrictionProfileRetryCursor/);
});

test('prelive and transition deploy callbacks apply freeze only after deployment', () => {
    const deployed = functionBody('Mode_OnPlayerDeployed');
    const transition = functionBody('handleCipherTransitionDeployedPlayer');
    const spawnQueue = functionBody('processTransitionSpawnQueue');
    const forceQueue = functionBody('processCipherTransitionForceDeployQueue');
    assert.match(deployed, /gameStatus === 2[\s\S]*"preliveFrozen"[\s\S]*tryApplyDesiredRestrictionProfileForPlayerId/);
    assert.match(transition, /restrictionApplied[\s\S]*cipherTransitionTeleportedByPlayerId[\s\S]*markCipherSecondHalfDeployReadyForPlayer/);
    assert.doesNotMatch(spawnQueue, /applyPhaseInputRestrictionsForPlayer/);
    assert.doesNotMatch(forceQueue, /applyPhaseInputRestrictionsForPlayer/);
});

test('sudden death switches to team spectating only in the finalizer', () => {
    const deployStage = functionBody('enterCipherSecondHalfDeploySupervisorStage');
    const finalizer = functionBody('beginCipherTransitionFinalizer');
    assert.match(deployStage, /setDeploySpawnModeAndDefaultSpectating/);
    assert.doesNotMatch(deployStage, /SpawnModes\.Spectating/);
    assert.match(finalizer, /SetSpectatingFiltersForAll\(mod\.SpectatingGroup\.Team, false, true\)/);
    assert.match(finalizer, /SetSpawnMode\(mod\.SpawnModes\.Spectating\)/);
});

test('all death signals share one epoch guard', () => {
    const record = functionBody('recordScoreboardDeathForPlayer');
    const mandown = functionBody('Mode_OnMandown');
    const died = functionBody('Mode_OnPlayerDied');
    const undeploy = functionBody('Mode_OnPlayerUndeploy');
    const kill = functionBody('Mode_OnPlayerEarnedKill');
    assert.match(record, /scoreboardDeathCountedEpochByPlayerId/);
    assert.match(record, /scoreboardDeathEpochByPlayerId/);
    assert.match(mandown, /recordScoreboardDeathForPlayer/);
    assert.match(died, /recordScoreboardDeathForPlayer/);
    assert.match(undeploy, /recordScoreboardDeathForPlayer/);
    assert.match(kill, /recordScoreboardDeathForPlayer/);
    assert.doesNotMatch(undeploy, /\.addDeath\(\)/);
});
