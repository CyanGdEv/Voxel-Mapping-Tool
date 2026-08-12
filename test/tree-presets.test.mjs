import test from 'node:test';
import assert from 'node:assert/strict';
import { crownRadiusAt, resolveTreeDimensions, selectTreePreset, treePresetNames } from '../src/lib/tree-presets.mjs';

test('tree library exposes diverse high-fidelity presets', () => {
  const names = treePresetNames();
  for (const required of ['broadleaf-oak','ancient-oak','beech','birch','willow','spruce','pine','cedar']) assert.ok(names.includes(required));
});

test('species evidence selects morphology rather than generic tree', () => {
  assert.equal(selectTreePreset({ species: 'Quercus robur', heightM: 12 }).id, 'broadleaf-oak');
  assert.equal(selectTreePreset({ species: 'Quercus robur', heightM: 24, crownDiameterM: 17 }).id, 'ancient-oak');
  assert.equal(selectTreePreset({ species: 'Salix alba' }).id, 'willow');
  assert.equal(selectTreePreset({ species: 'Picea abies' }).id, 'spruce');
  assert.equal(selectTreePreset({ species: 'Pinus sylvestris' }).id, 'pine');
});

test('measured height and crown dimensions stay 1:1 within Bedrock bounds', () => {
  const p = selectTreePreset({ species: 'Fagus sylvatica' });
  assert.deepEqual(resolveTreeDimensions(p, { heightM: 19.2, crownDiameterM: 12.6 }), { height: 19, crownDiameter: 13, crownRadius: 6.5 });
});

test('crown profiles preserve species silhouette', () => {
  const spruce = selectTreePreset({ species: 'Picea abies' });
  const willow = selectTreePreset({ species: 'Salix alba' });
  assert.ok(crownRadiusAt(spruce, 0.1, 5) > crownRadiusAt(spruce, 0.9, 5));
  assert.ok(crownRadiusAt(willow, 0.5, 5) > crownRadiusAt(willow, 0, 5));
});
