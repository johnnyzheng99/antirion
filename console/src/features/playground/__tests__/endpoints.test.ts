import { describe, expect, it } from 'vitest';

import type { ModelView } from '@/features/models/types';
import type { ModelResource } from '@/lib/api/types';

import {
  defaultModelForEndpoint,
  modelEligibleForDecisions,
  playgroundModelsForEndpoint,
} from '../endpoints';

const meta: ModelResource['metadata'] = {
  etag: '"1"',
  generation: 1,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  managed_by: 'api',
};

function view(partial: Partial<ModelView> & Pick<ModelView, 'name'>): ModelView {
  return {
    model: { name: partial.name, spec: { enabled: true }, metadata: meta },
    displayName: partial.name,
    enabled: true,
    lifecycle: 'ga',
    tier: null,
    leaves: [],
    providers: [],
    upstream: [],
    aliases: [],
    modality: 'other',
    context: null,
    ...partial,
  };
}

describe('Decisions playground models', () => {
  it('offers Cloudflare Clef, not local decision-route chat servers', () => {
    const clef = view({ name: 'clef-flash', providers: ['cloudflare'], upstream: ['@cf/cloudflare/clef-flash'] });
    const local = view({
      name: 'aiserver2decision/jev',
      providers: ['aiserver2decision'],
      upstream: ['jev'],
    });
    expect(modelEligibleForDecisions(clef)).toBe(true);
    expect(modelEligibleForDecisions(local)).toBe(false);
    expect(playgroundModelsForEndpoint([clef, local], 'decisions').map((m) => m.name)).toEqual(['clef-flash']);
  });

  it('defaults to clef-flash when switching away from a chat model', () => {
    const clef = view({ name: 'clef-flash', providers: ['cloudflare'] });
    const local = view({ name: 'aiserver2decision/jev', providers: ['aiserver2decision'] });
    expect(defaultModelForEndpoint([clef, local], 'decisions', 'aiserver2decision/jev')).toBe('clef-flash');
  });
});