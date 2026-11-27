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