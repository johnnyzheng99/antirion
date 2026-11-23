import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { emptySlot } from '@/lib/slot';
import { signInAs } from '@/test/utils';

import { RoutingTab } from '../components/routing-tab';
import { useCatalog } from '../store';
import type { ModelView } from '../types';

const meta = {
  etag: '"1"',
  generation: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  managed_by: 'api',
};

const view = (name: string, spec: Record<string, unknown>) =>
  ({ name, model: { name, spec, metadata: meta } }) as unknown as ModelView;

function setup(views: ModelView[]) {
  signInAs(['models:read', 'models:write']);
  useCatalog.setState({
    routes: {
      data: [{ name: 'smart', spec: { tree: 'gpt-4o' }, metadata: meta }],
      status: 'ready',
      error: null,
      at: Date.now(),
    },
    tiers: emptySlot(),
  });
  const onOpenModel = vi.fn();
  const onAddRoute = vi.fn();
  render(<RoutingTab views={views} onOpenModel={onOpenModel} onAddRoute={onAddRoute} />);
  return { onOpenModel, onAddRoute };
}

describe('Models › Routing', () => {
  it('lists the models on shared routes, each linked to its route in Routing policy', () => {
    const { onOpenModel } = setup([
      view('assistant', { route: 'smart' }),
      view('gpt-4o', { target: 'gpt-4o' }),
    ]);
    const table = screen.getByRole('table', { name: 'Models on shared routes' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (!row) throw new Error('no row');
    expect(row).toHaveTextContent('assistant');
    expect(row).toHaveTextContent('gpt-4o');
    expect(within(row).getByRole('link', { name: 'smart' })).toHaveAttribute(
      'href',
      expect.stringContaining('routing?route=smart') as string,
    );
    // The route has no rules, so there is no list here to go to: the name opens the route.
    expect(within(row).getByRole('link', { name: 'assistant' })).toHaveAttribute(
      'href',
      expect.stringContaining('routing?route=smart') as string,
    );
    expect(onOpenModel).not.toHaveBeenCalled();
  });

  it('goes to a model’s rule list below when its shared route has rules', async () => {
    signInAs(['models:read']);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    useCatalog.setState({
      routes: {
        data: [
          {
            name: 'global',
            spec: {
              tree: { type: 'conditional', rules: [{ name: 'eu', when: {}, target: 'a' }], default: 'b' },
            },
            metadata: meta,
          },
        ],
        status: 'ready',
        error: null,
        at: Date.now(),
      },
    });
    render(
      <RoutingTab
        views={[view('aligned', { route: 'global' })]}
        onOpenModel={vi.fn()}
        onAddRoute={vi.fn()}
      />,
    );
    const list = await screen.findByRole('table', { name: 'Rules of aligned' });
    const anchor = list.closest('[id^="routing-rules-"]');
    expect(anchor).not.toBeNull();
    const shared = screen.getByRole('table', { name: 'Models on shared routes' });
    await userEvent.click(within(shared).getByRole('button', { name: 'aligned' }));
    expect(anchor).toHaveFocus();
    expect(scrolled).toHaveBeenCalled();
  });

  it('offers Add route, and says what to do when there are no routes', async () => {
    const { onAddRoute } = setup([view('gpt-4o', { target: 'gpt-4o' })]);
    expect(screen.queryByRole('table', { name: 'Models on shared routes' })).not.toBeInTheDocument();
    expect(screen.getByText('No routes yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add route' }));
    expect(onAddRoute).toHaveBeenCalled();
  });
});
