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

test('final ready interaction refreshes authority and attempts prelive immediately', () => {
    const ready = functionBody('HandlePrematchReadyUp');
    assert.match(ready, /refreshPrematchReadyStateUi\(\)/);
    assert.match(ready, /tryStartPreliveFromPrematch\("prematch_ready_interact"/);
    assert.doesNotMatch(functionBody('isPrematchHudPreloadCompleteForCurrentPlayers'), /isCipherRuntimeBotPlayerId/);
    assert.doesNotMatch(functionBody('tryStartPreliveFromPrematch'), /getInitialRuntimeBotDeployProgress/);
});

test('bots are absent in prematch and stage once per second during the match countdown', () => {
    const ongoing = functionBody('OngoingGlobal_Inner');
    assert.doesNotMatch(ongoing, /tickRuntimeBotStagedSpawning\(nowSec, "prematch_staging"\)/);
    assert.doesNotMatch(ongoing, /tickRuntimeBotStagedSpawning\(nowSec, "ready_countdown"\)/);
    assert.match(ongoing, /tickRuntimeBotStagedSpawning\(nowSec, "prelive_countdown"\)/);
    assert.match(source, /CIPHER_RUNTIME_BOT_STAGED_SPAWN_INTERVAL_TICKS = TICK_RATE/);
    assert.match(functionBody('InitializePreLive'), /countDown = mod\.Max\(PRELIVE_TIME, stagedBotCount \+ 2\)/);
    assert.match(functionBody('bindRuntimeBotPlayerToSlot'), /enqueueRuntimeBotPreliveRoutePlayer/);
});

test('prelive countdown uses registered strings and never blocks on bot callbacks', () => {
    const prelive = functionBody('InitializePreLive');
    assert.match(prelive, /mod\.stringkeys\.MatchStarts/);
    assert.doesNotMatch(source, /mod\.Message\("MATCH STARTS IN"\)/);
    const ongoing = functionBody('OngoingGlobal_Inner');
    assert.doesNotMatch(ongoing, /CipherDeployingBots/);
    assert.doesNotMatch(ongoing, /areRuntimeBotPreliveRoutesTerminal/);
});

test('first live enters at zero without waiting for every human deployment', () => {
    const ongoing = functionBody('OngoingGlobal_Inner');
    const preliveStart = ongoing.indexOf('} else if (gameStatus === 2)');
    const liveStart = ongoing.indexOf('} else if (gameStatus === 3)', preliveStart);
    assert.notEqual(preliveStart, -1);
    assert.notEqual(liveStart, -1);
    const prelive = ongoing.slice(preliveStart, liveStart);
    assert.doesNotMatch(prelive, /areReadyTransitionHumansTerminal/);
    assert.doesNotMatch(prelive, /CipherWaitingForPlayers/);
    assert.match(prelive, /countDown === 0 && !preliveZeroTransitionHandled/);
    assert.match(prelive, /gameStatus = 3/);
});

test('key deadline lane survives scheduled-task frames and hides stale countdown banners', () => {
    const ongoing = functionBody('OngoingGlobal_Inner');
    assert.match(ongoing, /const scheduledTaskRan = processCipherScheduledTasks\(nowSec\)/);
    assert.match(ongoing, /processCriticalNextKeyUnlockTimerVisual\(nowSec\)/);
    assert.match(ongoing, /if \(scheduledTaskRan\) return/);
    const critical = functionBody('processCriticalNextKeyUnlockTimerVisual');
    assert.match(critical, /runDeferredBombRespawn/);
    assert.match(critical, /processNextKeyUnlockHideSweep/);
    assert.match(functionBody('clearNextKeyUnlockCountdown'), /beginNextKeyUnlockHideSweep\(\)/);
    assert.match(functionBody('updateNextKeyUnlockCountdownVisuals'), /refreshNextKeyUnlockHudForAllPlayers\(nowSec, force\)/);
});

test('audio preload spawns one manifest entry per startup step', () => {
    const preload = functionBody('processAudioPreloadStep');
    assert.match(preload, /audioPreloadCursor\+\+/);
    assert.equal((preload.match(/mod\.SpawnObject\(/g) ?? []).length, 1);
    assert.match(functionBody('processStartupPipelineStep'), /if \(!processAudioPreloadStep\(\)\) return/);
});

test('carrier custom loop is removed and dropped key owns the rush loop', () => {
    assert.doesNotMatch(source, /AltCacheCarrierBeep/);
    assert.match(source, /SFX_GameModes_Rush_Defusing_SimpleLoop3D/);
    assert.match(functionBody('startDroppedKeyDefusingLoop'), /PlaySound\(SFX_DroppedKeyDefusingLoop, 0\.8, pos, 10\)/);
    assert.match(functionBody('clearDroppedBombRuntimeObjects'), /stopDroppedKeyDefusingLoop/);
});

test('Gauntlet event cues and music phases are wired to authoritative paths', () => {
    assert.match(functionBody('showCipherKeyPickupNoticeForTeam'), /SFX_KeyPickupFriendly[\s\S]*SFX_KeyPickupEnemy/);
    assert.match(functionBody('showCipherKeyDeliveryNoticeForTeam'), /SFX_KeyDeliveryFriendly[\s\S]*SFX_KeyDeliveryEnemy/);
    assert.match(functionBody('startCipherNodeReboot'), /NODE_OVERLOAD_COOLDOWN_SECONDS - 0\.755/);
    assert.match(functionBody('reactivateCipherNode'), /SFX_NodeReactivated, 0\.5/);
    assert.match(functionBody('consumeCipherSuddenDeathLife'), /SFX_SuddenDeathFriendlyLost/);
    assert.match(functionBody('Mode_OnPlayerEarnedKill'), /playSuddenDeathEnemyKillSfxForKillerSquad/);
    assert.match(functionBody('getCipherMusicEvent'), /Gauntlet_Urgency_FinalMission/);
});

test('reboot counter icons render on a bounded per-tick lane instead of the slow objective cursor', () => {
    const rebootTick = functionBody('updateCipherNodeRebootCountdownWorldIconTick');
    assert.match(rebootTick, /cipherNodeRebootCountdownCursor/);
    assert.match(rebootTick, /cipherNodeRebootLastDisplayedSecondByCpId/);
    assert.match(rebootTick, /updateCipherCounterWorldIconForCp\(def\.cpId, false\)/);
    assert.match(functionBody('OngoingGlobal_Inner'), /updateCipherNodeRebootCountdownWorldIconTick\(\)/);
});

test('delivery notices resolve the viewer team from the live engine handle', () => {
    const delivery = functionBody('showCipherKeyDeliveryNoticeForTeam');
    assert.match(delivery, /getAuthoritativeCipherPlayerTeam\(viewer\)/);
    assert.match(delivery, /mod\.Equals\(viewerTeam, attackingTeam\)/);
    assert.doesNotMatch(delivery, /cipherKeyTeamIdByPlayerIdSnapshot\[viewer\.id\]/);
});

test('successful native bot spawn requests are terminal without callback binding', () => {
    const spawn = functionBody('spawnRuntimeBotFromSlot');
    const shouldSpawn = functionBody('shouldRuntimeBotSlotSpawn');
    const chooseStaged = functionBody('chooseReadyRuntimeBotSlotForStagedSpawn');
    assert.match(spawn, /slot\.spawnIssued = true/);
    assert.match(shouldSpawn, /slot\.spawnIssued && slot\.playerId === undefined/);
    assert.match(chooseStaged, /if \(slot\.spawnIssued\) return/);
    assert.match(functionBody('getIssuedRuntimeBotDeployCount'), /slot\.spawnIssued/);
});

test('half-two deployment remains active until everyone is ready or force deploy expires', () => {
    const finish = functionBody('tryFinishCipherDeployPhase');
    assert.match(finish, /const deployCounts = getCipherDeployCounts\(\)/);
    assert.match(finish, /deployCounts\.ready >= deployCounts\.required/);
    assert.match(finish, /beginCipherTransitionForceDeployFinish/);
    assert.doesNotMatch(finish, /hasAnyReadyCipherTransitionHuman\(\)/);
});
