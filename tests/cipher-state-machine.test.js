import assert from 'node:assert/strict';
import test from 'node:test';

import {
    closePurePlayerLife,
    connectPurePlayer,
    consumePureRespawnRoute,
    createPureCipherState,
    createPureRespawnRoute,
    deliverPureKey,
    disconnectPurePlayer,
    getPurePostmatchCountdown,
    isPurePostmatchTeleportCurrent,
    pickUpPureKey,
    processPureNodeReboots,
    resetPureCipherMatch,
    selectPurePostmatchSlots,
    transitionPureCipherPhase,
} from '../src/squad-obliteration/state/cipher-state-machine.ts';

test('phase flow reaches half two, sudden death, postmatch, and reset', () => {
    const state = createPureCipherState();
    for (const phase of ['countdown', 'prelive', 'live', 'halftime-deployment', 'live', 'sudden-death', 'postmatch']) {
        transitionPureCipherPhase(state, phase);
    }
    assert.equal(state.half, 2);
    assert.equal(state.phase, 'postmatch');
    resetPureCipherMatch(state);
    assert.equal(state.phase, 'prematch');
    assert.deepEqual(state.score, [0, 0]);
});

test('postmatch fills four deterministic slots even when every stat is zero', () => {
    const players = [4, 2, 3, 1].map((playerId) => ({
        playerId,
        scoreboard: [0, 0, 0, 0, 0],
    }));
    const slots = selectPurePostmatchSlots(players);
    assert.equal(slots.length, 4);
    assert.deepEqual(slots.map((slot) => slot.playerId), [1, 2, 3, 4]);
    assert.equal(new Set(slots.map((slot) => slot.playerId)).size, 4);
    assert.deepEqual(slots.map((slot) => slot.statKind), [
        'eliminations',
        'destroyed',
        'keyTime',
        'moralSupport',
    ]);
});

test('postmatch uses available players, tick countdown, and rejects stale teleport identity', () => {
    const slots = selectPurePostmatchSlots([
        { playerId: 7, scoreboard: [50, 3, 0, 0, 0] },
        { playerId: 8, scoreboard: [25, 0, 0, 10, 0] },
    ]);
    assert.equal(slots.length, 2);
    assert.equal(getPurePostmatchCountdown(600, 0, 30), 20);
    assert.equal(getPurePostmatchCountdown(600, 30, 30), 19);
    assert.equal(getPurePostmatchCountdown(600, 600, 30), 0);
    assert.equal(isPurePostmatchTeleportCurrent(4, 4, 101, 101), true);
    assert.equal(isPurePostmatchTeleportCurrent(4, 5, 101, 101), false);
    assert.equal(isPurePostmatchTeleportCurrent(4, 4, 101, 202), false);
});

test('reconnect restores score while reused ids invalidate stale work', () => {
    const state = createPureCipherState();
    const first = connectPurePlayer(state, 7, 'account-a');
    first.scoreboard[0] = 500;
    const staleSession = first.sessionGeneration;
    disconnectPurePlayer(state, 7);
    const rejoined = connectPurePlayer(state, 7, 'account-a');
    assert.equal(rejoined.scoreboard[0], 500);
    assert.ok(rejoined.sessionGeneration > staleSession);
});

test('respawn routes reject stale lives, bypass squads, and teleport once', () => {
    const state = createPureCipherState();
    transitionPureCipherPhase(state, 'live');
    connectPurePlayer(state, 3, 'account-b');
    const bypass = createPureRespawnRoute(state, 3, [1411]);
    assert.equal(consumePureRespawnRoute(state, bypass, true), 'bypassed');
    assert.equal(consumePureRespawnRoute(state, bypass, false), 'bypassed');

    const teleport = createPureRespawnRoute(state, 3, [1412]);
    assert.equal(consumePureRespawnRoute(state, teleport, false), 'teleported');
    assert.equal(consumePureRespawnRoute(state, teleport, false), 'teleported');

    const stale = createPureRespawnRoute(state, 3, [1413]);
    closePurePlayerLife(state, 3);
    assert.equal(consumePureRespawnRoute(state, stale, false), 'stale');
    assert.equal(createPureRespawnRoute(state, 3, []).completion, 'native-hq-fallback');
});

test('key pickup, two deliveries, reboot, and sudden-death join elimination', () => {
    const state = createPureCipherState();
    transitionPureCipherPhase(state, 'live');
    connectPurePlayer(state, 9, 'account-c');
    assert.equal(pickUpPureKey(state, 9), true);
    assert.equal(deliverPureKey(state, 'A', 0, 10), 'counter');
    state.key = { status: 'base' };
    assert.equal(pickUpPureKey(state, 9), true);
    assert.equal(deliverPureKey(state, 'A', 0, 20), 'overload');
    assert.deepEqual(state.score, [1, 0]);
    processPureNodeReboots(state, 64);
    assert.notEqual(state.nodes.A.rebootDeadline, undefined);
    processPureNodeReboots(state, 65);
    assert.equal(state.nodes.A.rebootDeadline, undefined);

    transitionPureCipherPhase(state, 'sudden-death');
    const late = connectPurePlayer(state, 10, 'account-d');
    assert.equal(late.eliminated, true);
    assert.equal(createPureRespawnRoute(state, 10, [3411]), undefined);
});
