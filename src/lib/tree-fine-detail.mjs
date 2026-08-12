function classify(block) {
  const id = String(block || '');
  if (id.includes('_fence')) return 'fence';
  if (id.includes('_trapdoor')) return 'trapdoor';
  if (id.includes('_stairs')) return 'stairs';
  if (id.includes('_slab')) return 'slab';
  if (id.includes('_log') || id.includes('_planks') || id.includes('_wood')) return 'solid';
  return 'other';
}

export function resolveTreeFineDetail({ preset, detailLevel = 'high', family, structuralForm } = {}) {
  const branchPalette = [...(preset?.branches || [])];
  const twigPalette = [...(preset?.twigs || [])];
  const all = [...new Set([...twigPalette, ...branchPalette])];
  const groups = Object.fromEntries(['fence','trapdoor','stairs','slab','solid','other'].map(k => [k, all.filter(b => classify(b) === k)]));
  const enabled = detailLevel === 'high' && (groups.fence.length || groups.trapdoor.length || groups.slab.length || groups.stairs.length);
  const isConifer = family === 'conifer' || preset?.family === 'conifer';
  const damaged = structuralForm?.form === 'damaged' || structuralForm?.form === 'veteran';
  return {
    enabled: Boolean(enabled),
    terminalChance: enabled ? (isConifer ? 0.72 : damaged ? 0.78 : 0.64) : 0,
    edgeChance: enabled ? (isConifer ? 0.38 : 0.28) : 0,
    tertiaryChance: enabled ? (isConifer ? 0.74 : 0.56) : 0,
    fence: groups.fence,
    trapdoor: groups.trapdoor,
    stairs: groups.stairs,
    slab: groups.slab,
    solid: groups.solid.length ? groups.solid : branchPalette,
    fallback: twigPalette.length ? twigPalette : branchPalette
  };
}

export function pickFineTwigBlock(detail, { phase = 'run', seed = 0 } = {}) {
  if (!detail?.enabled) return pick(detail?.fallback, seed);
  const n = hash(`${seed}:${phase}`);
  const candidates = phase === 'terminal'
    ? [...detail.trapdoor, ...detail.fence, ...detail.slab]
    : phase === 'junction'
      ? [...detail.stairs, ...detail.slab, ...detail.solid]
      : phase === 'edge'
        ? [...detail.trapdoor, ...detail.slab, ...detail.fence]
        : [...detail.fence, ...detail.slab, ...detail.solid];
  return pick(candidates.length ? candidates : detail.fallback, n);
}

export function shouldEmitFineDetail(detail, { kind = 'terminal', seed = 0 } = {}) {
  if (!detail?.enabled) return false;
  const chance = kind === 'edge' ? detail.edgeChance : kind === 'tertiary' ? detail.tertiaryChance : detail.terminalChance;
  return unit(seed, kind) < chance;
}

export function tertiaryTwigVector({ angle = 0, seed = 0, family = 'broadleaf' } = {}) {
  const side = unit(seed, 'side') < 0.5 ? -1 : 1;
  const delta = (0.34 + unit(seed, 'delta') * 0.52) * side;
  const length = family === 'conifer' ? 1 + Math.round(unit(seed, 'len') * 2) : 1 + Math.round(unit(seed, 'len'));
  const dy = family === 'conifer' ? (unit(seed, 'dy') < 0.62 ? 0 : -1) : (unit(seed, 'dy') < 0.5 ? 1 : 0);
  return { angle: angle + delta, length, dy };
}

function pick(list, seed) { return list?.length ? list[Math.abs(Number(seed) || 0) % list.length] : null; }
function unit(seed, salt) { return (hash(`${seed}:${salt}`) % 10000) / 9999; }
function hash(text) { let h = 2166136261 >>> 0; for (const c of String(text)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
