import type { ModelView } from '@/features/models/types';
import type { ProviderResource } from '@/lib/api/types';

/** Playground endpoint ids and their data-plane paths (kept in sync with `crates/antirion-admin/src/playground.rs`). */
export type Endpoint =
  | 'chat_completions'
  | 'responses'
  | 'messages'
  | 'embeddings'
  | 'speech'
  | 'transcriptions'
  | 'rerank'
  | 'decisions'
  | 'systemone';

export const ENDPOINTS: { value: Endpoint; label: string; path: string }[] = [
  { value: 'chat_completions', label: 'Chat', path: '/v1/chat/completions' },
  { value: 'responses', label: 'Responses', path: '/v1/responses' },
  { value: 'messages', label: 'Messages', path: '/v1/messages' },
  { value: 'embeddings', label: 'Embeddings', path: '/v1/embeddings' },
  { value: 'speech', label: 'Text-to-speech', path: '/v1/audio/speech' },
  { value: 'transcriptions', label: 'Speech-to-text', path: '/v1/audio/transcriptions' },
  { value: 'rerank', label: 'Rerank', path: '/v1/rerank' },
  { value: 'decisions', label: 'Decisions', path: '/v1/decisions' },
  { value: 'systemone', label: 'System One', path: '/v1/systemone' },
];

/** Segmented control in the playground (System One is reached via Decisions + model provider). */
export const PLAYGROUND_ENDPOINTS = ENDPOINTS.filter((e) => e.value !== 'systemone');

export function isEndpoint(value: unknown): value is Endpoint {
  return ENDPOINTS.some((e) => e.value === value);
}

export function endpointOfPath(path: string | null | undefined): Endpoint | null {
  return ENDPOINTS.find((e) => e.path === path)?.value ?? null;
}

/** Endpoints that use the chat-style form (system, turns, parameters). */
export function endpointUsesChatForm(endpoint: Endpoint): boolean {
  return endpoint === 'chat_completions' || endpoint === 'responses' || endpoint === 'messages';
}

/** Whether the playground offers streaming for this endpoint. */
export function endpointAllowsStream(endpoint: Endpoint): boolean {
  return endpointUsesChatForm(endpoint);
}

/** Whether a catalog model belongs in the Decisions form. */
export function modelEligibleForDecisions(view: ModelView): boolean {
  if (/clef|systemone|jev|decision/i.test(view.name)) return true;
  if (view.upstream.some((u) => /clef|systemone|jev/i.test(u))) return true;
  if (view.providers.some((p) => /decision/i.test(p)) || view.providers.includes('cloudflare')) return true;
  return false;
}

/** Models offered for the Decisions tab. */
export function playgroundModelsForEndpoint(views: ModelView[], endpoint: Endpoint): ModelView[] {
  if (endpoint !== 'decisions') return views;
  const eligible = views.filter(modelEligibleForDecisions);
  return eligible.length > 0 ? eligible : views;
}

/** Keeps the current model when it fits the endpoint; otherwise prefers `clef-flash`. */
export function defaultModelForEndpoint(views: ModelView[], endpoint: Endpoint, current: string): string {
  const list = playgroundModelsForEndpoint(views, endpoint);
  const names = new Set(list.map((v) => v.name));
  if (current && names.has(current)) return current;
  const pick =
    list.find((v) => v.enabled && v.name === 'clef-flash') ??
    list.find((v) => v.enabled) ??
    list[0];
  return pick?.name ?? current;
}

/**
 * Data-plane path for a Decisions-tab send: Cloudflare Clef and OpenAI-family providers use
 * `/v1/decisions` (the gateway maps Cloudflare to Workers AI `/run/...`); everything else uses
 * TypeSafe `/v1/systemone`.
 */
export function decisionDataPlaneEndpoint(
  view: ModelView,
  providers: Map<string, ProviderResource>,
): 'decisions' | 'systemone' {
  if (view.providers.includes('cloudflare')) return 'decisions';
  for (const name of view.providers) {
    const t = providers.get(name)?.spec.type;
    if (t === 'openai' || t === 'azure_openai') return 'decisions';
  }
  return 'systemone';
}

/** Resolves the admin `endpoint` field for a playground send. */
export function playgroundSendEndpoint(
  formEndpoint: Endpoint,
  view: ModelView | undefined,
  providers: Map<string, ProviderResource>,
): Endpoint {
  if (formEndpoint !== 'decisions' || !view) return formEndpoint;
  return decisionDataPlaneEndpoint(view, providers);
}

/** Drops streaming flags on bodies for endpoints that never stream. */
export function sanitizePlaygroundBody(
  endpoint: Endpoint,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (endpointAllowsStream(endpoint)) return body;
  const out = { ...body };
  delete out.stream;
  delete out.stream_options;
  return out;
}