'use client';

import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, useSwitchChanges } from '@/components/ui/confirm';
import { Checkbox, Field, Input, Switch } from '@/components/ui/form';
import { useCan } from '@/components/ui/gate';
import { MenuButton } from '@/components/ui/menu';
import { CancelButton, Dialog } from '@/components/ui/overlay';
import { InlineError } from '@/components/ui/states';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { useEdited } from '@/lib/hooks';
import type { FieldErrors } from '@/lib/validation';
import { notify } from '@/stores/ui';

import { detailErrors, NAME_RE } from '../form-errors';
import { useGatewaySettings } from '../store';
import { Card } from './parts';

/** One entry of `api.custom_endpoints`. */
export interface CustomEndpoint {
  path?: string;
  upstream_path?: string;
  methods?: string[];
  enabled?: boolean;
  description?: string;
}

export const CUSTOM_METHODS = ['POST', 'PUT', 'PATCH'] as const;

const PATH_RE = /^(\/[A-Za-z0-9._~:@!$&'()*+,;=-]+)+$/;

/** First path segments the gateway keeps for itself, or that a provider-style prefix takes. */
const RESERVED = [
  '-',
  'mcp',
  'a2a',
  '.well-known',
  'model',
  'antirion',
  'admin',
  'openai',
  'anthropic',
  'gemini',
  'bedrock',
];

/** The operation path an endpoint at `path` is sent to when it names none: the path without `/v1`. */
export function defaultUpstream(path: string): string {
  return path.startsWith('/v1/') ? path.slice(3) : path;
}

export interface CustomValues {
  name: string;
  path: string;
  upstreamPath: string;
  methods: string[];
  description: string;
}

export function fromCustom(name: string, e: CustomEndpoint | undefined): CustomValues {
  return {
    name,
    path: e?.path ?? '',
    upstreamPath: e?.upstream_path ?? '',
    methods: e?.methods ?? ['POST'],
    description: e?.description ?? '',
  };
}

/**
 * The merge patch of the entry for the values: each field the form leaves at its default is
 * removed (`null`), so it falls back to that default; `enabled` is kept as it was.
 */
export function toCustomPatch(v: CustomValues): Record<string, unknown> {
  const postOnly = v.methods.length === 1 && v.methods[0] === 'POST';
  return {
    path: v.path.trim(),
    upstream_path: v.upstreamPath.trim() || null,
    methods: postOnly ? null : v.methods,
    description: v.description.trim() || null,
  };
}

/** What the form can tell before the gateway checks the path against its own endpoints. */
export function customErrors(
  v: CustomValues,
  creating: boolean,
  others: Record<string, CustomEndpoint>,
): FieldErrors {
  const e: FieldErrors = {};
  if (creating) {
    if (!NAME_RE.test(v.name)) e.name = 'Use letters, digits, . _ and -; start with a letter or digit';
    else if (v.name in others) e.name = 'Another custom endpoint has this name';
  }
  const path = v.path.trim();
  const first = path.split('/')[1] ?? '';
  if (!PATH_RE.test(path) || path.split('/').some((s) => s === '.' || s === '..'))
    e.path = 'Enter a path such as /v1/music/generate, without a trailing slash';
  else if (RESERVED.includes(first)) e.path = `Paths under /${first} are kept by the gateway`;
  else if (Object.entries(others).some(([n, o]) => n !== v.name && o.path === path))
    e.path = 'Another custom endpoint has this path';
  const up = v.upstreamPath.trim();
  if (up && (!PATH_RE.test(up) || up.split('/').some((s) => s === '.' || s === '..')))
    e.upstreamPath = 'Enter a path such as /music/generate';
  if (v.methods.length === 0) e.methods = 'Choose at least one method';
  return e;
}

function CustomEndpointDialog({
  name,
  endpoints,
  onClose,
}: {
  name: string | null;
  endpoints: Record<string, CustomEndpoint>;
  onClose: () => void;
}) {
  const saveApi = useGatewaySettings((s) => s.saveApi);
  const [values, setValues] = useState<CustomValues>(() =>
    fromCustom(name ?? '', name ? endpoints[name] : undefined),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const edited = useEdited(values);
  const set = <K extends keyof CustomValues>(key: K, value: CustomValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));
  async function submit() {
    const found = customErrors(values, name === null, endpoints);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await saveApi({ custom_endpoints: { [values.name]: toCustomPatch(values) } });
      notify('success', name ? 'Endpoint saved' : 'Endpoint added', values.path.trim());
      onClose();
    } catch (e) {
      setError(e);
      const at = `api.custom_endpoints.${values.name}`;
      setErrors(
        detailErrors(e, {
          [`${at}.path`]: 'path',
          [`${at}.upstream_path`]: 'upstreamPath',
          [`${at}.methods`]: 'methods',
        }),
      );
    } finally {
      setBusy(false);
    }
  }
  const shownUpstream = values.upstreamPath.trim() || defaultUpstream(values.path.trim() || '/v1/…');
  return (
    <Dialog
      open
      dirty={edited}
      onClose={onClose}
      title={name ? `Endpoint ${name}` : 'Add endpoint'}
      description="A path apps call with a JSON body that names its model. The gateway routes it like any other endpoint and sends the body, as it is, to the same operation on the deployment's provider."
      footer={
        <>
          <CancelButton />
          <Button variant="primary" busy={busy} onClick={() => void submit()}>
            {name ? 'Save endpoint' : 'Add endpoint'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <InlineError error={error} />
        {name ? null : (
          <Field
            label="Name"
            required
            error={errors.name}
            hint="How the configuration and the request log name it."
          >
            <Input
              mono
              data-autofocus
              value={values.name}
              placeholder="music"
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
        )}
        <Field label="Path" required error={errors.path} hint="Matched exactly.">
          <Input
            mono
            value={values.path}
            placeholder="/v1/music/generate"
            onChange={(e) => set('path', e.target.value)}
          />
        </Field>
        <Field
          label="Provider path"
          optional
          error={errors.upstreamPath}
          hint={`Below the provider's base URL. Empty sends ${shownUpstream}.`}
        >
          <Input
            mono
            value={values.upstreamPath}
            placeholder={defaultUpstream(values.path.trim() || '/v1/music/generate')}
            onChange={(e) => set('upstreamPath', e.target.value)}
          />
        </Field>
        <Field label="Methods" error={errors.methods}>
          <div className="flex gap-4">
            {CUSTOM_METHODS.map((m) => (
              <Checkbox
                key={m}
                label={m}
                checked={values.methods.includes(m)}
                onChange={(on) =>
                  set(
                    'methods',
                    CUSTOM_METHODS.filter((x) => (x === m ? on : values.methods.includes(x))),
                  )
                }
              />
            ))}
          </div>
        </Field>
        <Field label="Description" optional>
          <Input value={values.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** The operator's own endpoints (`api.custom_endpoints`), with the button to add one. */
export function CustomEndpointsCard({ endpoints }: { endpoints: Record<string, CustomEndpoint> }) {
  const saveApi = useGatewaySettings((s) => s.saveApi);
  const canEdit = useCan('patchApiSettings');
  const { change, dialog } = useSwitchChanges();
  const [editing, setEditing] = useState<{ name: string | null; key: number } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const reason = canEdit ? undefined : "Your role can't change endpoints";
  const entries = Object.entries(endpoints).sort(([a], [b]) => a.localeCompare(b));
  const setEnabled = (name: string, enabled: boolean) =>
    saveApi({ custom_endpoints: { [name]: { enabled: enabled ? null : false } } });
  return (
    <Card
      title="Custom endpoints"
      description="Paths you add for APIs the gateway has no built-in endpoint for. Each request names its model and is routed, limited and logged like any other, then sent unchanged to the deployment's provider."
      actions={
        <Button
          size="sm"
          icon="plus"
          disabled={!canEdit}
          disabledReason={reason}
          onClick={() => setEditing({ name: null, key: Date.now() })}
        >
          Add endpoint
        </Button>
      }
    >
      {entries.length === 0 ? (
        <p className="text-ui text-muted">
          No custom endpoints. Add one for a path such as /v1/music/generate on an OpenAI-compatible server.
        </p>
      ) : (
        <Table label="Custom endpoints">
          <thead>
            <tr>
              <Th>Endpoint</Th>
              <Th>Path</Th>
              <Th>Provider path</Th>
              <Th>
                <span className="sr-only">On</span>
              </Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([name, e]) => {
              const on = e.enabled !== false;
              const methods = e.methods ?? ['POST'];
              const paths = `${methods.join(', ')} ${e.path ?? ''}`;
              return (
                <Tr key={name}>
                  <Td>
                    <span className="mono">{name}</span>
                    {e.description ? (
                      <span className="block text-caption text-muted">{e.description}</span>
                    ) : null}
                  </Td>
                  <Td mono muted>
                    {paths}
                  </Td>
                  <Td mono muted>
                    {e.upstream_path ?? defaultUpstream(e.path ?? '')}
                    {e.upstream_path ? null : (
                      <Badge tone="neutral" className="ml-2">
                        default
                      </Badge>
                    )}
                  </Td>
                  <Td className="w-12 text-right">
                    <Switch
                      label={`${name} endpoint`}
                      hideLabel
                      checked={on}
                      disabled={!canEdit}
                      disabledReason={reason}
                      onChange={(next) =>
                        change({
                          name,
                          apply: () => setEnabled(name, next),
                          undo: () => setEnabled(name, !next),
                          done: `${name} turned ${next ? 'on' : 'off'}`,
                          undone: `${name} turned ${next ? 'off' : 'on'}`,
                          ask: next
                            ? undefined
                            : {
                                title: `Turn off ${name}?`,
                                effect: `Apps calling ${paths} get 404 until it is turned back on.`,
                                confirmLabel: 'Turn off',
                              },
                        })
                      }
                    />
                  </Td>
                  <Td>
                    <span className="flex justify-end">
                      <MenuButton
                        label={`More for ${name}`}
                        iconOnly
                        variant="ghost"
                        size="sm"
                        items={[
                          {
                            label: 'Edit',
                            icon: 'edit',
                            disabled: !canEdit,
                            disabledReason: reason,
                            onSelect: () => setEditing({ name, key: Date.now() }),
                          },
                          {
                            label: 'Remove',
                            icon: 'trash',
                            danger: true,
                            disabled: !canEdit,
                            disabledReason: reason,
                            onSelect: () => setRemoving(name),
                          },
                        ]}
                      />
                    </span>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {editing ? (
        <CustomEndpointDialog
          key={editing.key}
          name={editing.name}
          endpoints={endpoints}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove endpoint ${removing ?? ''}?`}
        objectName={removing ?? undefined}
        confirmLabel="Remove endpoint"
        effect="Apps calling its path get 404."
        onConfirm={async (r) => {
          if (!removing) return;
          await saveApi({ custom_endpoints: { [removing]: null } }, r);
          notify('success', 'Endpoint removed', removing);
        }}
      />
      {dialog}
    </Card>
  );
}
