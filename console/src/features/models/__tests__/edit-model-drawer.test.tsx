import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ModelResource } from '@/lib/api/types';
import { emptySlot } from '@/lib/slot';
import { signInAs } from '@/test/utils';

import { EditModelDrawer } from '../components/edit-model-drawer';
import { useCatalog, useModels } from '../store';

const meta = {
  etag: '"1"',
  generation: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  managed_by: 'api',
};

function open(spec: Record<string, unknown>) {
  signInAs(['models:read', 'models:write']);
  useCatalog.setState({
    deployments: {
      data: [{ name: 'gpt-4o', spec: { provider: 'openai', model: 'gpt-4o' }, metadata: meta }],
      status: 'ready',
      error: null,
      at: Date.now(),
    },
    routes: {
      data: [{ name: 'smart', spec: { tree: 'gpt-4o' }, metadata: meta }],
      status: 'ready',
      error: null,
      at: Date.now(),
    },
    tiers: emptySlot(),
  });
  useModels.setState({ items: [], status: 'ready', error: null, loadedAt: Date.now() });
  const model = {
    name: 'm',
    spec: { tier: 'balanced', ...spec },
    metadata: meta,
  } as unknown as ModelResource;
  render(<EditModelDrawer model={model} onClose={() => undefined} />);
  return screen.getByRole('dialog', { name: 'Edit m' });
}

describe('Edit model › serves from', () => {
  it('keeps a Model on its own deployments, with no shared route to switch to', () => {
    const drawer = open({ target: 'gpt-4o' });
    expect(within(drawer).queryByRole('radio', { name: /A shared route/ })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('combobox', { name: /^Shared route/ })).not.toBeInTheDocument();
    expect(within(drawer).getByText(/Change the order from the model’s fallback chain/)).toBeInTheDocument();
  });

  it('lets a Model on a shared route change its route', () => {
    const drawer = open({ route: 'smart' });
    expect(within(drawer).queryByRole('radio', { name: /Its own deployments/ })).not.toBeInTheDocument();
    expect(within(drawer).getByRole('combobox', { name: /^Shared route/ })).toBeInTheDocument();
  });
});
