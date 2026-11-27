/** Composite targets: a fallback chain where each step uses its own strategy over deployments. */

import {
  isRecord,
  type Json,
  leafOf,
  plainTargets,
  strategyOf,
  type Target,
  targetsOf,
} from './types';

export type SegmentStrategy = 'single' | 'weighted' | 'fallback' | 'least_busy' | 'least_latency';

export interface TargetSegment {
  /** Stable list key while reordering. */
  key: string;
  strategy: SegmentStrategy;
  targets: Target[];
}

export const SEGMENT_STRATEGIES: {
  value: SegmentStrategy;
  label: string;
  description: string;
}[] = [
  { value: 'single', label: 'One deployment', description: 'Every request in this group goes to one deployment.' },
  { value: 'weighted', label: 'Weighted split', description: 'Split traffic across deployments by weight.' },
  {
    value: 'fallback',
    label: 'Try in order',
    description: 'Try each deployment in order when the previous one fails.',
  },
  { value: 'least_busy', label: 'Least busy', description: 'The deployment with the fewest requests in flight.' },
  { value: 'least_latency', label: 'Least latency', description: 'The deployment with the lowest recent latency.' },
];

let counter = 0;
export const nextSegmentKey = () => `g${(counter += 1)}`;

export function blankSegment(strategy: SegmentStrategy = 'weighted'): TargetSegment {
  return {
    key: nextSegmentKey(),
    strategy,
    targets: [{ deployment: '', weight: 1, role: '' }],
  };
}

const SEGMENT_STRATEGY_VALUES: SegmentStrategy[] = [
  'single',
  'weighted',
  'fallback',
  'least_busy',
  'least_latency',
];

/** Two groups to start a composite rule from the current flat target draft. */
export function defaultCompositeSegments(from: {
  strategy: string;
  targets: Target[];
}): TargetSegment[] {
  const firstStrategy = SEGMENT_STRATEGY_VALUES.includes(from.strategy as SegmentStrategy)
    ? (from.strategy as SegmentStrategy)
    : 'weighted';
  const picked = from.targets.filter((t) => t.deployment);
  const first: TargetSegment = {
    key: nextSegmentKey(),
    strategy: firstStrategy,
    targets:
      picked.length > 0
        ? from.targets.map((t) => ({ ...t }))
        : [{ deployment: '', weight: 1, role: '' }],
  };
  return [first, blankSegment('fallback')];
}

export function segmentOfChild(child: Json): TargetSegment | null {
  if (typeof child === 'string') {
    return { key: nextSegmentKey(), strategy: 'single', targets: [{ deployment: child, weight: 1, role: '' }] };
  }
  if (!isRecord(child)) return null;
  const t = child.type ?? (typeof child.deployment === 'string' ? 'deployment' : undefined);
  if ((t === 'deployment' || (typeof child.deployment === 'string' && t === undefined)) && leafOf(child)) {
    const leaf = leafOf(child)!;
    return { key: nextSegmentKey(), strategy: 'single', targets: [leaf] };
  }
  const strat = strategyOf(child);
  if (
    strat !== 'other' &&
    plainTargets(child) &&
    (strat === 'weighted' ||
      strat === 'fallback' ||
      strat === 'least_busy' ||
      strat === 'least_latency' ||
      strat === 'single')
  ) {
    const targets = targetsOf(child);
    return {
      key: nextSegmentKey(),
      strategy: strat as SegmentStrategy,
      targets: targets.length > 0 ? targets : [{ deployment: '', weight: 1, role: '' }],
    };
  }
  return null;
}

/**
 * Reads a target as wizard segments, or null when a child uses settings the editor doesn't support.
 * Several segments mean a composite fallback chain; one segment is a plain strategy.
 */
export function segmentsFromTarget(node: Json): TargetSegment[] | null {
  if (node === undefined || node === null) return null;
  const solo = segmentOfChild(node);
  if (solo && strategyOf(node) !== 'fallback') return [solo];
  if (!isRecord(node) || node.type !== 'fallback' || !Array.isArray(node.children)) {
    return solo ? [solo] : null;
  }
  const children = node.children as Json[];
  if (children.length === 0) return null;
  if (plainTargets(node) && children.length > 0) {
    const targets = targetsOf(node);
    return [
      {
        key: nextSegmentKey(),
        strategy: 'fallback',
        targets: targets.length > 0 ? targets : [{ deployment: '', weight: 1, role: '' }],
      },
    ];
  }
  const segments: TargetSegment[] = [];
  for (const child of children) {
    const seg = segmentOfChild(child);
    if (!seg) return null;
    segments.push(seg);
  }
  return segments.length > 0 ? segments : null;
}

export function isCompositeTarget(node: Json): boolean {
  const segs = segmentsFromTarget(node);
  return segs !== null && segs.length > 1;
}

function child(t: Target, withWeight: boolean): Json {
  const role = t.role.trim();
  if (!role && !withWeight) return t.deployment;
  return {
    ...(role ? { id: role } : {}),
    deployment: t.deployment,
    ...(withWeight ? { weight: t.weight } : {}),
  };
}

/** One segment as a route-tree node (no outer policies). */
export function segmentToNode(seg: TargetSegment): Json {
  const t = seg.targets.filter((x) => x.deployment);
  switch (seg.strategy) {
    case 'single': {
      const first = t[0];
      if (!first) return '';
      if (!first.role.trim()) return first.deployment;
      return { type: 'deployment', deployment: first.deployment, id: first.role.trim() };
    }
    case 'weighted':
      return { type: 'weighted', children: t.map((x) => child(x, true)) };
    case 'fallback':
    case 'least_busy':
    case 'least_latency':
      return {
        type: seg.strategy,
        children: t.map((x) => child(x, seg.strategy === 'least_busy' && x.weight !== 1)),
      };
  }
}

export function segmentLabel(seg: TargetSegment): string {
  const names = seg.targets.filter((t) => t.deployment).map((t) => t.deployment);
  const list = (sep: string) => names.join(sep) || '…';
  switch (seg.strategy) {
    case 'single':
      return names[0] ?? '…';
    case 'weighted':
      return `weighted: ${names.map((n, i) => `${n} (${seg.targets[i]?.weight ?? 1})`).join(', ') || '…'}`;
    case 'fallback':
      return `try ${list(', then ')}`;
    case 'least_busy':
      return `least busy of ${list(' / ')}`;
    case 'least_latency':
      return `fastest of ${list(' / ')}`;
  }
}
