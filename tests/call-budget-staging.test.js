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

test('production runtime uses direct Portal calls without the removed governor', () => {
    assert.doesNotMatch(source, /portalCall|FrameJobManager|PortalCallBudget|beginPortalServerFrame/);
    assert.match(source, /mod\.SetSpawnMode\(/);
});

test('game-mode start establishes safe prematch synchronously', () => {
    const started = functionBody('Mode_OnGameModeStarted');
    assert.match(started, /gameModeStarted = true/);
    assert.match(started, /gameStatus = 0/);
    assert.match(started, /disableAllObjectiveCapturePointObjectives/);
    assert.match(started, /disableAllObjectiveSurfaceSectors/);
    assert.match(started, /disableAllObjectiveInteractPoints/);
    assert.match(started, /hideAllObjectiveArmedWorldIcons/);
    assert.match(started, /ConfigurePreMatchSpawns/);
    assert.match(started, /PreMatchContainer[\s\S]*true/);
});

test('heavy phase work is cursor driven and timers cannot catch up in a burst', () => {
    assert.match(functionBody('processCipherScheduledTasks'), /processed >= 1/);
    const ongoing = functionBody('OngoingGlobal_Inner');
    assert.match(ongoing, /const scheduledTaskRan = processCipherScheduledTasks\(nowSec\)/);
    assert.match(ongoing, /processCriticalNextKeyUnlockTimerVisual\(nowSec\)/);
    assert.match(ongoing, /if \(scheduledTaskRan\) return/);
    assert.match(functionBody('InitializePreLive'), /preliveInitializationStage/);
    assert.match(functionBody('processLiveInitializationStep'), /liveInitializationObjectiveCursor\+\+/);
    assert.match(functionBody('processLiveHudQueues'), /"topBuild"[\s\S]*"topBind"/);
    assert.match(functionBody('UpdateScoreboard'), /liveScoreboardCursor/);
    assert.match(functionBody('updateCipherSuddenDeathAliveHudForAllPlayers'), /suddenDeathAliveHudCursor/);
});
