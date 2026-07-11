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

test('native bomb carrier release never destroys the bomb', () => {
    const body = functionBody('removeCipherNativeBombCarrierState');
    assert.doesNotMatch(body, /ForceBombUnspawn|UnspawnObject/);
});

test('native bomb cleanup detaches handles and selects one destruction path', () => {
    const body = functionBody('clearCipherNativeMinimapBomb');
    const detach = body.indexOf('cipherNativeMinimapBombHandle = undefined');
    const nativeDestroy = body.indexOf('ForceBombUnspawn(handle)');
    const fallbackDestroy = body.indexOf('mod.UnspawnObject(object)');

    assert.ok(detach >= 0 && detach < nativeDestroy, 'handle must be detached before native cleanup');
    assert.ok(nativeDestroy >= 0 && nativeDestroy < fallbackDestroy);
    assert.equal(body.match(/ForceBombUnspawn\(handle\)/g)?.length, 1);
    assert.equal(body.match(/mod\.UnspawnObject\(object\)/g)?.length, 1);
    assert.ok(body.includes('if (!destroyedByBombApi && object)'));
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
