import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTreeFineDetail, pickFineTwigBlock, shouldEmitFineDetail, tertiaryTwigVector } from '../src/lib/tree-fine-detail.mjs';

const preset = {
  family:'broadleaf',
  branches:['minecraft:oak_log','minecraft:oak_fence','minecraft:oak_stairs','minecraft:oak_slab'],
  twigs:['minecraft:oak_fence','minecraft:oak_trapdoor','minecraft:brown_wool']
};

test('high detail enables thin Bedrock-safe branch materials', () => {
  const d = resolveTreeFineDetail({ preset, detailLevel:'high', family:'broadleaf' });
  assert.equal(d.enabled, true);
  assert.ok(d.fence.includes('minecraft:oak_fence'));
  assert.ok(d.trapdoor.includes('minecraft:oak_trapdoor'));
  assert.ok(d.slab.includes('minecraft:oak_slab'));
  assert.ok(d.stairs.includes('minecraft:oak_stairs'));
});

test('medium detail does not add extra close-up detail', () => {
  const d = resolveTreeFineDetail({ preset, detailLevel:'medium' });
  assert.equal(d.enabled, false);
  assert.equal(d.terminalChance, 0);
});

test('terminal and junction selections prefer appropriate thin forms', () => {
  const d = resolveTreeFineDetail({ preset, detailLevel:'high' });
  const terminal = pickFineTwigBlock(d, { phase:'terminal', seed:3 });
  const junction = pickFineTwigBlock(d, { phase:'junction', seed:9 });
  assert.ok(['minecraft:oak_trapdoor','minecraft:oak_fence','minecraft:oak_slab'].includes(terminal));
  assert.ok(['minecraft:oak_stairs','minecraft:oak_slab','minecraft:oak_log'].includes(junction));
});

test('tertiary twig direction is deterministic and short', () => {
  const a = tertiaryTwigVector({ angle:1.2, seed:42, family:'broadleaf' });
  const b = tertiaryTwigVector({ angle:1.2, seed:42, family:'broadleaf' });
  assert.deepEqual(a,b);
  assert.ok(a.length >= 1 && a.length <= 2);
});

test('detail emission decisions are deterministic', () => {
  const d = resolveTreeFineDetail({ preset, detailLevel:'high' });
  assert.equal(shouldEmitFineDetail(d,{kind:'terminal',seed:77}), shouldEmitFineDetail(d,{kind:'terminal',seed:77}));
});
