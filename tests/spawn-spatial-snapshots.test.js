import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

import { WORLD_IDS } from '../src/squad-obliteration/config/world-ids.ts';

const spawnAnchorIds = [
    ...WORLD_IDS.firstDeployAnchors.north,
    ...WORLD_IDS.firstDeployAnchors.south,
    ...Object.values(WORLD_IDS.respawnAnchors).flat(),
];

function loadSpatial(name) {
    const json = JSON.parse(
        readFileSync(new URL(`../spatials/${name}`, import.meta.url), 'utf8')
    );
    return new Map(
        json.Portal_Dynamic
            .filter((entry) => Number.isFinite(Number(entry.ObjId)))
            .map((entry) => [Number(entry.ObjId), entry.position])
    );
}

test('both mode spatials provide every configured spawn anchor id', () => {
    for (const name of ['MF_CAIRO_CO.spatial.json', 'MF_Contaminated_CO.spatial.json']) {
        const objects = loadSpatial(name);
        const missing = spawnAnchorIds.filter((objectId) => !objects.has(objectId));
        assert.deepEqual(missing, [], `${name} is missing configured spawn anchors`);
    }
});

test('shared object ids retain map-specific authored positions', () => {
    const cairo = loadSpatial('MF_CAIRO_CO.spatial.json').get(1411);
    const contaminated = loadSpatial('MF_Contaminated_CO.spatial.json').get(1411);
    assert.ok(cairo);
    assert.ok(contaminated);
    assert.notDeepEqual(cairo, contaminated);
});
