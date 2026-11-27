import type { ModelView } from '@/features/models/types';

/** Playground endpoint ids and their data-plane paths (kept in sync with `crates/antirion-admin/src/playground.rs`). */
export type Endpoint =
  | 'chat_completions'
  | 'responses'
  | 'messages'
  | 'embeddings'
  | 'speech'
  | 'transcriptions'
  | 'rerank'
  | 'decisions';

export const ENDPOINTS: { value: Endpoint; label: string; path: string }[] = [
  { value: 'chat_completions', label: 'Chat', path: '/v1/chat/completions' },
  { value: 'responses', label: 'Responses', path: '/v1/responses' },
  { value: 'messages', label: 'Messages', path: '/v1/messages' },
  { value: 'embeddings', label: 'Embeddings', path: '/v1/embeddings' },
  { value: 'speech', label: 'Text-to-speech', path: '/v1/audio/speech' },
  { value: 'transcriptions', label: 'Speech-to-text', path: '/v1/audio/transcriptions' },
  { value: 'rerank', label: 'Rerank', path: '/v1/rerank' },
  { value: 'decisions', label: 'Decisions', path: '/v1/decisions' },
];

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

/** Whether a catalog model can answer `POST /v1/decisions` via Clef, System One, or a capable deployment. */
export function modelEligibleForDecisions(view: ModelView): boolean {
  if (/clef|systemone/i.test(view.name)) return true;
  if (view.upstream.some((u) => /clef|systemone/i.test(u))) return true;
  return view.providers.includes('cloudflare');
}

/** Models offered for the active endpoint (Decisions is not chat — local LLM routes lack `/v1/decisions`). */
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