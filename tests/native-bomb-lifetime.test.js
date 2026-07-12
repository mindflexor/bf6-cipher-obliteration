import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const source = readFileSync(
    new URL('../src/squad-obliteration/runtime/mode-runtime.ts', import.meta.url),
    'utf8'
);

function functionBody(name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
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

test('native bomb carrier state uses the proven native unspawn detach sequence', () => {
    const body = functionBody('removeCipherNativeBombCarrierState');
    assert.match(body, /forceReleaseCipherNativeBombCarrier/);
    assert.match(body, /ForceBombUnspawn\(cipherNativeMinimapBombHandle\)/);
    assert.doesNotMatch(body, /UnspawnObject/);
});

test('native bomb cleanup flushes native state and runtime object before detaching handles', () => {
    const body = functionBody('clearCipherNativeMinimapBomb');
    const detach = body.indexOf('cipherNativeMinimapBombHandle = undefined');
    const nativeDestroy = body.indexOf('ForceBombUnspawn(handle)');
    const fallbackDestroy = body.indexOf('mod.UnspawnObject(object)');

    assert.ok(detach > fallbackDestroy, 'handles must remain available until both cleanup layers run');
    assert.ok(nativeDestroy >= 0 && nativeDestroy < fallbackDestroy);
    assert.equal(body.match(/ForceBombUnspawn\(handle\)/g)?.length, 1);
    assert.equal(body.match(/mod\.UnspawnObject\(object\)/g)?.length, 1);
    assert.match(body, /removeCipherNativeBombCarrierState\(context\)/);
});

test('an absent native bomb is recreated and rebound to a replacement carrier', () => {
    const give = functionBody('giveCipherNativeBombToCarrier');
    const retry = functionBody('scheduleCipherNativeBombCarrierBindRetries');
    const assign = functionBody('assignBombCarrierFromDelta');

    assert.match(give, /cipherNativeMinimapBombLifetime === "destroying"/);
    assert.match(give, /cipherNativeMinimapBombLifetime !== "active" \|\| !cipherNativeMinimapBombHandle/);
    assert.match(give, /spawnCipherNativeBombAtPosition/);
    assert.match(give, /GiveBombToPlayer/);
    assert.match(retry, /\[0, 0\.1, 0\.25\]/);
    assert.match(retry, /isCurrentPlayerSession/);
    assert.match(assign, /scheduleCipherNativeBombCarrierBindRetries/);
});

test('dropped-key cleanup detaches engine references before unspawn', () => {
    const lootBody = functionBody('clearBombDroppedRuntimeLootSpawner');
    assert.ok(
        lootBody.indexOf('bombDroppedRuntimeLootSpawnerObject = undefined') <
            lootBody.indexOf('unspawnObjectSafe(object')
    );

    const dropBody = functionBody('clearDroppedBombRuntimeObjects');
    assert.ok(
        dropBody.indexOf('bombDroppedWorldIconObject = undefined') <
            dropBody.indexOf('unspawnObjectSafe(worldIconObject')
    );
});
