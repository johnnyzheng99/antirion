/** Rule target groups: each group is one strategy; several groups form a fallback chain. */

import {
  canaryOf,
  isRecord,
  type Json,
  leafOf,
  mirrorOf,
  plainTargets,
  sharePercent,
  type Strategy,
  strategyOf,
  type Target,
  targetsOf,
} from './types';

export type GroupStrategy = Exclude<Strategy, 'composite'>;
type StickyKind = '' | 'session' | 'end_user' | 'key' | 'header' | 'metadata';
type TierStrategy = 'least_cost' | 'least_latency' | 'weighted' | 'fallback';

export interface RuleGroupDraft {
  key: string;
  strategy: GroupStrategy;
  targets: Target[];
  block: { status: 400 | 403 | 451; message: string; category: string };
  canary: {
    steps: { weight: string; after: string }[];
    budget: boolean;
    maxErrorRate: string;
    window: string;
    action: 'rollback' | 'hold';
  };
  shadow: { target: string; percent: string; sampleBy: 'request' | 'session' };
  adaptive: { experiment: string; metric: string; minSamples: string; stop: boolean; delta: string };
  tier: { tier: string; strategy: TierStrategy; includePreview: boolean };
  pool: {
    picker: 'builtin' | 'external';
    url: string;
    timeout: string;
    onError: 'reject' | 'builtin';
    lora: boolean;
  };
  costQuality: {
    strong: string;
    weak: string;
    by: 'threshold' | 'fraction';
    percent: string;
    scorer: 'matrix_factorization' | 'kept';
    modelFile: string;
    embeddingModel: string;
    strongName: string;
    weakName: string;
    onError: 'strong' | 'weak' | 'reject';
  };
  sticky: { kind: StickyKind; name: string };
  providerModel: { provider: string; upstreamModel: string };
  routeRef: string;
  original?: Json;
}

const blankCostQuality = (): RuleGroupDraft['costQuality'] => ({
  strong: '',
  weak: '',
  by: 'threshold',
  percent: '50',
  scorer: 'matrix_factorization',
  modelFile: '',
  embeddingModel: '',
  strongName: '',
  weakName: '',
  onError: 'strong',
});

let counter = 0;
export const nextGroupKey = () => `g${(counter += 1)}`;

export function blankGroup(strategy: GroupStrategy = 'weighted'): RuleGroupDraft {
  return {
    key: nextGroupKey(),
    strategy,
    targets: [{ deployment: '', weight: 1, role: '' }],
    block: { status: 403, message: 'Request blocked by routing policy.', category: 'custom' },
    canary: {
      steps: [
        { weight: '5', after: '0s' },
        { weight: '25', after: '1h' },
        { weight: '50', after: '6h' },
        { weight: '100', after: '24h' },
      ],
      budget: true,
      maxErrorRate: '2',
      window: '5m',
      action: 'rollback',
    },
    shadow: { target: '', percent: '10', sampleBy: 'request' },
    adaptive: { experiment: '', metric: '', minSamples: '10', stop: false, delta: '5' },
    tier: { tier: 'fast', strategy: 'least_cost', includePreview: false },
    pool: { picker: 'builtin', url: '', timeout: '', onError: 'reject', lora: false },
    costQuality: blankCostQuality(),
    sticky: { kind: '', name: '' },
    providerModel: { provider: '', upstreamModel: '' },
    routeRef: '',
  };
}

function stickyOf(node: Json): RuleGroupDraft['sticky'] {
  if (!isRecord(node) || typeof node.sticky_by !== 'string') return { kind: '', name: '' };
  const [kind = '', ...rest] = node.sticky_by.split(':');
  return { kind: kind as StickyKind, name: rest.join(':') };
}

function adaptiveOf(node: Record<string, Json>): RuleGroupDraft['adaptive'] {
  const stop = isRecord(node.stop_after) ? node.stop_after : null;
  return {
    experiment: typeof node.experiment === 'string' ? node.experiment : '',
    metric: typeof node.metric === 'string' ? node.metric : '',
    minSamples: typeof node.min_samples_per_arm === 'number' ? String(node.min_samples_per_arm) : '10',
    stop: stop !== null,
    delta: stop && typeof stop.delta === 'number' ? sharePercent(stop.delta).replace('%', '') : '5',
  };
}

function poolOf(node: Record<string, Json>): RuleGroupDraft['pool'] {
  const svc = isRecord(node.picker_service) ? node.picker_service : {};
  return {
    picker: node.picker === 'external' ? 'external' : 'builtin',
    url: typeof svc.url === 'string' ? svc.url : '',
    timeout: typeof svc.timeout === 'string' ? svc.timeout : '',
    onError: node.picker_on_error === 'builtin' ? 'builtin' : 'reject',
    lora: isRecord(node.scheduler) && node.scheduler.lora === true,
  };
}

function costQualityOf(node: Record<string, Json>): RuleGroupDraft['costQuality'] {
  const blank = blankCostQuality();
  const scorer = isRecord(node.scorer) ? node.scorer : {};
  const mf = scorer.kind === 'matrix_factorization';
  const pair = isRecord(scorer.models) ? scorer.models : {};
  const fraction = typeof node.strong_fraction === 'number';
  const ratio = fraction ? node.strong_fraction : node.threshold;
  return {
    strong: leafOf(node.strong)?.deployment ?? '',
    weak: leafOf(node.weak)?.deployment ?? '',
    by: fraction ? 'fraction' : 'threshold',
    percent: typeof ratio === 'number' ? sharePercent(ratio).replace('%', '') : blank.percent,
    scorer: mf || !isRecord(node.scorer) ? 'matrix_factorization' : 'kept',
    modelFile: mf && typeof scorer.model_file === 'string' ? scorer.model_file : '',
    embeddingModel: mf && typeof scorer.embedding_model === 'string' ? scorer.embedding_model : '',
    strongName: typeof pair.strong === 'string' ? pair.strong : '',
    weakName: typeof pair.weak === 'string' ? pair.weak : '',
    onError: node.on_error === 'weak' || node.on_error === 'reject' ? node.on_error : 'strong',
  };
}

/** Reads one route-tree node into a group, or null when the wizard can't build it. */
export function groupFromNode(node: Json): RuleGroupDraft | null {
  if (strategyOf(node) === 'other') return null;
  const blank = blankGroup();
  const strategy = strategyOf(node);
  if (strategy === 'composite' || strategy === 'other') return null;
  const target = isRecord(node) ? node : {};
  const canary = canaryOf(node);
  const mirror = mirrorOf(node);
  const targets = targetsOf(node);
  return {
    ...blank,
    key: nextGroupKey(),
    strategy,
    targets: targets.length > 0 ? targets : blank.targets,
    block: {
      status: target.status === 400 || target.status === 451 ? target.status : 403,
      message: typeof target.message === 'string' ? target.message : blank.block.message,
      category: typeof target.category === 'string' ? target.category : 'custom',
    },
    canary: canary
      ? {
          steps: canary.steps.map((s) => ({ weight: String(s.weight), after: s.after })),
          budget: canary.budget !== null,
          maxErrorRate: canary.budget ? sharePercent(canary.budget.max_error_rate).replace('%', '') : '2',
          window: canary.budget?.window ?? '5m',
          action: canary.budget?.action ?? 'rollback',
        }
      : blank.canary,
    shadow: mirror
      ? {
          target: mirror.target,
          percent: sharePercent(mirror.fraction).replace('%', ''),
          sampleBy: mirror.sampleBy,
        }
      : blank.shadow,
    tier:
      strategy === 'tier'
        ? {
            tier: typeof target.tier === 'string' ? target.tier : 'fast',
            strategy: (typeof target.strategy === 'string' ? target.strategy : 'least_cost') as TierStrategy,
            includePreview: target.include_preview === true,
          }
        : blank.tier,
    adaptive: strategy === 'adaptive' ? adaptiveOf(target) : blank.adaptive,
    pool: strategy === 'pool' ? poolOf(target) : blank.pool,
    costQuality: strategy === 'cost_quality' ? costQualityOf(target) : blank.costQuality,
    sticky: stickyOf(node),
    providerModel: {
      provider: typeof target.provider === 'string' ? target.provider : '',
      upstreamModel: typeof target.upstream_model === 'string' ? target.upstream_model : '',
    },
    routeRef: typeof target.route === 'string' ? target.route : '',
    original: node,
  };
}

/** Parses a rule target into editable groups, or null when a part is unsupported. */
export function groupsFromTarget(node: Json): RuleGroupDraft[] | null {
  if (node === undefined || node === null) return null;
  if (!isRecord(node) || node.type !== 'fallback' || !Array.isArray(node.children)) {
    const one = groupFromNode(node);
    return one ? [one] : null;
  }
  const children = node.children as Json[];
  if (children.length === 0) return null;
  if (plainTargets(node)) {
    const one = groupFromNode(node);
    return one ? [one] : null;
  }
  const groups: RuleGroupDraft[] = [];
  for (const child of children) {
    const g = groupFromNode(child);
    if (!g) return null;
    groups.push(g);
  }
  return groups.length > 0 ? groups : null;
}

export function isMultiGroupTarget(node: Json): boolean {
  const g = groupsFromTarget(node);
  return g !== null && g.length > 1;
}