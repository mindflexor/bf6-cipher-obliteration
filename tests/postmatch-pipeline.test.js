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

test('postmatch entry starts a bounded pipeline without bulk player fan-out', () => {
    const enter = functionBody('enterPostmatchFromLive');
    assert.match(enter, /startPostmatchPipeline\(\)/);
    assert.doesNotMatch(enter, /prepareAllPostmatchPlayers|schedulePostmatchPlayerStateReassert/);
    assert.doesNotMatch(enter, /serverPlayers\.forEach/);
});

test('postmatch pipeline enforces undeploy, deploy, teleport, UI, reveal, timer barriers', () => {
    const process = functionBody('processPostmatchPipeline');
    for (const stage of [
        'undeploy',
        'undeploySettle',
        'deploy',
        'deploySettle',
        'showcaseBuild',
        'teleport',
        'input',
        'reportUi',
        'cardUi',
        'scoreFade',
        'cardFade',
        'complete',
    ]) {
        assert.match(process, new RegExp(`"${stage}"`));
    }
    assert.match(functionBody('processPostmatchPlayerUndeploy'), /postmatchPipelineCursor\+\+/);
    assert.match(functionBody('processPostmatchPlayerDeploy'), /postmatchPipelineCursor\+\+/);
    assert.match(functionBody('finishPostmatchReveal'), /postmatchEndTick = serverTickCount/);
    assert.match(functionBody('finishPostmatchReveal'), /schedulePostmatchEndGameModeFallback/);
});

test('postmatch winner movement and loser full restrictions are explicit', () => {
    const winner = functionBody('applyPostmatchShowcaseMovementLockForPlayer');
    assert.match(winner, /MoveForwardBack/);
    assert.match(winner, /MoveLeftRight/);
    assert.doesNotMatch(winner, /Jump|Crouch|Prone|FireWeapon|SelectPrimary/);
    assert.match(source, /POSTMATCH_LOSING_TEAM_RESTRICTED_INPUTS:[\s\S]*CameraPitch[\s\S]*SelectThrowable[\s\S]*Zoom/);
});

test('postmatch score and cards start hidden and reveal in five bounded steps', () => {
    assert.match(source, /POSTMATCH_SCORE_FADE_STEPS = 5/);
    assert.match(source, /POSTMATCH_CARD_FADE_STEPS = 5/);
    assert.match(functionBody('setPostmatchScoreRevealAlpha'), /SetPostMatchTextAlpha|setPostMatchTextAlpha/);
    assert.match(functionBody('setPostmatchCardRevealAlpha'), /PM_PlayerContainer/);
    assert.match(functionBody('processPostmatchPipeline'), /SFX_ReadyUp/);
});

test('postmatch cards pass depth before their team receiver', () => {
    const container = functionBody('addPostMatchContainer');
    const text = functionBody('addPostMatchText');
    assert.match(container, /mod\.UIDepth\.AboveGameUI,[\s\S]*receiver/);
    assert.match(text, /mod\.UIDepth\.AboveGameUI,[\s\S]*receiver/);
});

test('postmatch preparation holds score before fixed camera and pedestal activation', () => {
    const process = functionBody('processPostmatchPipeline');
    const jobs = functionBody('processPostmatchStateAwarePlayerJob');
    const finalize = functionBody('processPostmatchCameraFinalize');
    assert.match(process, /"cameraFinalize"/);
    assert.match(process, /postmatchPreparationEndTick/);
    assert.match(process, /activatePostmatchShowcase\(\)/);
    assert.match(jobs, /"postmatchFrozen"/);
    assert.doesNotMatch(jobs, /advancePostmatchPipeline\("cameraFinalize"\)/);
    assert.match(finalize, /advancePostmatchPipeline\("teleport"\)/);
    assert.match(finalize, /setPostmatchShowcaseCameraForPlayer\(player\.player, true\)/);
    assert.match(functionBody('setPostmatchShowcaseCameraForPlayer'), /mod\.Cameras\.Fixed, POSTMATCH_CAMERA_ID/);
    assert.match(functionBody('schedulePostmatchCameraForPlayerAfterSettle'), /postmatchPipelineToken/);
    assert.match(functionBody('Mode_OnRevived'), /OnRevived_Postmatch/);
});

test('postmatch uses a five-second score hold, full showcase clock, and drift maintenance', () => {
    assert.match(source, /POSTMATCH_TRANSITION_SECONDS = RULES\.postmatchTransitionSeconds/);
    assert.match(functionBody('activatePostmatchShowcase'), /postmatchEndTick = serverTickCount \+ POSTMATCH_TIME \* TICK_RATE/);
    const maintain = functionBody('maintainPostmatchShowcasePedestals');
    assert.match(maintain, /POSTMATCH_PEDESTAL_RECHECK_TICKS/);
    assert.match(maintain, /POSTMATCH_PEDESTAL_TOLERANCE_METERS/);
    assert.match(maintain, /teleportPostmatchShowcaseSlotPlayer\(slot, "pedestal_reassert"\)/);
});

test('postmatch card text owns its receiver-relative colored background', () => {
    const build = functionBody('buildPostmatchShowcaseScreenUi');
    const text = functionBody('addPostMatchText');
    assert.match(build, /color,[\s\S]*mod\.UIBgFill\.Blur/);
    assert.match(text, /backgroundColor,[\s\S]*backgroundAlpha,[\s\S]*backgroundFill/);
    assert.match(functionBody('setPostmatchCardRevealAlpha'), /PM_PlayerText[\s\S]*setPostMatchContainerAlpha/);
});
