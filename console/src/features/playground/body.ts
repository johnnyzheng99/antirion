/**
 * The playground's request bodies and answers: a composed request as the body each endpoint's
 * dialect takes, a body read back into the form, and the text, finish reason and usage of an answer,
 * whether it came whole or as events.
 */

import {
  ENDPOINTS,
  endpointAllowsStream,
  endpointOfPath,
  endpointUsesChatForm,
  isEndpoint,
  type Endpoint,
} from './endpoints';

export type { Endpoint };
export { ENDPOINTS, endpointAllowsStream, endpointOfPath, endpointUsesChatForm, isEndpoint };

/** The admin API attaches this for speech-to-text; the gateway turns it into multipart. */
export const PLAYGROUND_FILE = '_playground_file';

export type Role = 'user' | 'assistant';

export interface Turn {
  role: Role;
  text: string;
}

/** The form: what the composer edits. Numbers are kept as typed ('' when unset). */
export interface Composer {
  endpoint: Endpoint;
  model: string;
  system: string;
  turns: Turn[];
  /** The embeddings input, one text per line. */
  input: string;
  /** Text-to-speech */
  speechInput: string;
  voice: string;
  /** Rerank */
  rerankQuery: string;
  rerankDocuments: string;
  rerankTopN: string;
  /** Speech-to-text (uploaded file, base64 without a data-URL prefix) */
  audioFileName: string;
  audioFileBase64: string;
  /** Text-to-speech reference clip for voice-cloning style models (optional, base64). */
  speechRefFileName: string;
  speechRefFileBase64: string;
  /** Decisions / System One (Clef, Jev, …) */
  decisionState: string;
  decisionQuestions: string;
  temperature: string;
  topP: string;
  maxTokens: string;
  /** Stop sequences, one per line (at most four). */
  stop: string;
  stream: boolean;
}

/** Messages needs a cap on the answer; the form starts with this one. */
export const DEFAULT_MAX_TOKENS = '1024';

export function emptyComposer(endpoint: Endpoint = 'chat_completions', model = ''): Composer {
  return {
    endpoint,
    model,
    system: '',
    turns: [{ role: 'user', text: '' }],
    input: '',
    speechInput: '',
    voice: 'alloy',
    rerankQuery: '',
    rerankDocuments: '',
    rerankTopN: '',
    audioFileName: '',
    audioFileBase64: '',
    speechRefFileName: '',
    speechRefFileBase64: '',
    decisionState: 'Describe the situation to decide on.',
    decisionQuestions: JSON.stringify(
      {
        urgent: { type: 'noul', instructions: 'Is this urgent?' },
      },
      null,
      2,
    ),
    temperature: '',
    topP: '',
    maxTokens: endpoint === 'messages' ? DEFAULT_MAX_TOKENS : '',
    stop: '',
    stream: endpointAllowsStream(endpoint),
  };
}

type Json = Record<string, unknown>;

const DEFAULT_CLEF_MODEL = 'clef-flash';

function decisionModelSelector(model: string): string {
  const m = model.trim();
  if (!m) return DEFAULT_CLEF_MODEL;
  if (m === 'clef-flash' || m === 'clef') return m;
  if (m.includes('clef-flash')) return 'clef-flash';
  if (m.endsWith('/clef')) return 'clef';
  return m;
}

function parseJsonOrText(text: string): string | Json {
  const t = text.trim();
  if (!t) return '';
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t) as Json;
    } catch {
      return t;
    }
  }
  return t;
}

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(text: string): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** A form value out of range, by field, or nothing when the form can be sent. */
export function composerErrors(c: Composer): Partial<Record<keyof Composer, string>> {
  const errors: Partial<Record<keyof Composer, string>> = {};
  if (!c.model) errors.model = 'Choose a model.';
  switch (c.endpoint) {
    case 'embeddings':
      if (lines(c.input).length === 0) errors.input = 'Enter the text to embed.';
      return errors;
    case 'speech':
      if (!c.speechInput.trim()) errors.speechInput = 'Enter the text to speak.';
      if (!c.voice.trim()) errors.voice = 'Enter a voice id.';
      return errors;
    case 'transcriptions':
      if (!c.audioFileBase64) errors.audioFileBase64 = 'Choose an audio file to transcribe.';
      return errors;
    case 'rerank':
      if (!c.rerankQuery.trim()) errors.rerankQuery = 'Enter a query.';
      if (lines(c.rerankDocuments).length === 0) errors.rerankDocuments = 'Enter at least one document.';
      return errors;
    case 'decisions': {
      if (!c.decisionState.trim()) errors.decisionState = 'Enter a state to evaluate.';
      if (!c.decisionQuestions.trim()) errors.decisionQuestions = 'Enter the questions JSON.';
      else {
        try {
          const q = JSON.parse(c.decisionQuestions) as unknown;
          if (typeof q !== 'object' || q === null || Array.isArray(q))
            errors.decisionQuestions = 'Questions must be a JSON object.';
        } catch {
          errors.decisionQuestions = 'Questions must be valid JSON.';
        }
      }
      return errors;
    }
    default:
      break;
  }
  const t = num(c.temperature);
  if (c.temperature.trim() && (t === null || t < 0 || t > 2))
    errors.temperature = 'Enter a number from 0 to 2.';
  const p = num(c.topP);
  if (c.topP.trim() && (p === null || p < 0 || p > 1)) errors.topP = 'Enter a number from 0 to 1.';
  const m = num(c.maxTokens);
  if (c.maxTokens.trim() && (m === null || m < 1 || !Number.isInteger(m)))
    errors.maxTokens = 'Enter a whole number of tokens.';
  if (c.endpoint === 'messages' && !c.maxTokens.trim()) errors.maxTokens = 'Messages needs a maximum.';
  if (lines(c.stop).length > 4) errors.stop = 'Up to four stop sequences.';
  if (!c.turns.some((t) => t.text.trim())) errors.turns = 'Write a message to send.';
  return errors;
}

/** The body the form sends to its endpoint, in that endpoint's dialect. `stream` is sent beside it. */
export function buildBody(c: Composer): Json {
  if (c.endpoint === 'embeddings') {
    const inputs = lines(c.input);
    return { model: c.model, input: inputs.length === 1 ? inputs[0] : inputs };
  }
  if (c.endpoint === 'speech') {
    const body: Json = { model: c.model, input: c.speechInput.trim(), voice: c.voice.trim() };
    if (c.speechRefFileBase64) {
      body.reference_audio = {
        filename: c.speechRefFileName.trim() || 'reference.wav',
        data: c.speechRefFileBase64,
      };
    }
    return body;
  }
  if (c.endpoint === 'transcriptions') {
    return {
      model: c.model,
      [PLAYGROUND_FILE]: {
        field: 'file',
        filename: c.audioFileName.trim() || 'audio.wav',
        data: c.audioFileBase64,
      },
    };
  }
  if (c.endpoint === 'rerank') {
    const docs = lines(c.rerankDocuments);
    const top = num(c.rerankTopN);
    return {
      model: c.model,
      query: c.rerankQuery.trim(),
      documents: docs,
      ...(top !== null ? { top_n: top } : {}),
    };
  }
  if (c.endpoint === 'decisions') {
    return {
      model: decisionModelSelector(c.model),
      state: parseJsonOrText(c.decisionState),
      questions: JSON.parse(c.decisionQuestions) as Json,
    };
  }
  const turns = c.turns.filter((t) => t.text.trim()).map((t) => ({ role: t.role, content: t.text }));
  const system = c.system.trim() ? c.system : null;
  const body: Json = { model: c.model };
  const temperature = num(c.temperature);
  const topP = num(c.topP);
  const max = num(c.maxTokens);
  const stop = lines(c.stop);
  if (c.endpoint === 'chat_completions') {
    body.messages = [...(system ? [{ role: 'system', content: system }] : []), ...turns];
    if (max !== null) body.max_tokens = max;
    if (stop.length) body.stop = stop;
  } else if (c.endpoint === 'messages') {
    if (system) body.system = system;
    body.messages = turns;
    body.max_tokens = max ?? Number(DEFAULT_MAX_TOKENS);
    if (stop.length) body.stop_sequences = stop;
  } else {
    if (system) body.instructions = system;
    body.input = turns.length === 1 && turns[0]?.role === 'user' ? turns[0].content : turns;
    if (max !== null) body.max_output_tokens = max;
  }
  if (temperature !== null) body.temperature = temperature;
  if (topP !== null) body.top_p = topP;
  return body;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const p of value) {
    if (!isObject(p)) return null;
    if (
      (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') &&
      typeof p.text === 'string'
    )
      parts.push(p.text);
    else return null;
  }
  return parts.join('');
}

function numberText(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

/**
 * Reads a body back into the form. `exact` says whether the form says all of it: when it does not
 * (tools, images, other members), the playground keeps the body as JSON so nothing is lost.
 */
export function parseBody(endpoint: Endpoint, body: unknown): { composer: Composer; exact: boolean } {
  const c = emptyComposer(endpoint, isObject(body) && typeof body.model === 'string' ? body.model : '');
  if (!isObject(body)) return { composer: c, exact: false };
  if (endpoint === 'embeddings') {
    const input = body.input;
    if (typeof input === 'string') c.input = input;
    else if (Array.isArray(input) && input.every((i) => typeof i === 'string')) c.input = input.join('\n');
  } else if (endpoint === 'speech') {
    if (typeof body.input === 'string') c.speechInput = body.input;
    if (typeof body.voice === 'string') c.voice = body.voice;
    const ref = body.reference_audio;
    if (isObject(ref)) {
      if (typeof ref.filename === 'string') c.speechRefFileName = ref.filename;
      if (typeof ref.data === 'string') c.speechRefFileBase64 = ref.data;
    }
  } else if (endpoint === 'transcriptions') {
    const f = body[PLAYGROUND_FILE];
    if (isObject(f)) {
      if (typeof f.filename === 'string') c.audioFileName = f.filename;
      if (typeof f.data === 'string') c.audioFileBase64 = f.data;
    }
  } else if (endpoint === 'rerank') {
    if (typeof body.query === 'string') c.rerankQuery = body.query;
    const docs = body.documents;
    if (Array.isArray(docs) && docs.every((d) => typeof d === 'string')) c.rerankDocuments = docs.join('\n');
    c.rerankTopN = numberText(body.top_n);
  } else if (endpoint === 'decisions') {
    const state = body.state;
    if (typeof state === 'string') c.decisionState = state;
    else if (state !== undefined) c.decisionState = JSON.stringify(state, null, 2);
    if (body.questions !== undefined) c.decisionQuestions = JSON.stringify(body.questions, null, 2);
  } else {
    const turns: Turn[] = [];
    let ok = true;
    const take = (role: unknown, content: unknown) => {
      const t = text(content);
      if (t === null) ok = false;
      if (role === 'system' || role === 'developer') c.system = t ?? '';
      else if (role === 'user' || role === 'assistant') turns.push({ role, text: t ?? '' });
      else ok = false;
    };
    if (endpoint === 'responses') {
      if (typeof body.instructions === 'string') c.system = body.instructions;
      if (typeof body.input === 'string') turns.push({ role: 'user', text: body.input });
      else if (Array.isArray(body.input))
        for (const item of body.input) {
          if (isObject(item) && (item.type === undefined || item.type === 'message'))
            take(item.role, item.content);
          else ok = false;
        }
      c.maxTokens = numberText(body.max_output_tokens);
    } else {
      if (endpoint === 'messages') {
        const system = text(body.system);
        if (body.system !== undefined && system === null) ok = false;
        c.system = system ?? '';
      }
      if (Array.isArray(body.messages))
        for (const m of body.messages) {
          if (isObject(m) && m.tool_calls === undefined) take(m.role, m.content);
          else ok = false;
        }
      c.maxTokens = numberText(body.max_tokens ?? body.max_completion_tokens);
      const stop = endpoint === 'messages' ? body.stop_sequences : body.stop;
      if (typeof stop === 'string') c.stop = stop;
      else if (Array.isArray(stop)) c.stop = stop.filter((s) => typeof s === 'string').join('\n');
    }
    if (turns.length) c.turns = turns;
    c.temperature = numberText(body.temperature);
    c.topP = numberText(body.top_p);
    if (typeof body.stream === 'boolean') c.stream = body.stream;
    if (!ok) return { composer: c, exact: false };
  }
  const rest: Json = { ...body };
  delete rest.stream;
  delete rest.stream_options;
  delete rest[PLAYGROUND_FILE];
  return { composer: c, exact: sameJson(buildBody(c), rest) };
}

/** Whether two JSON values are equal, member order aside. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameJson(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && sameJson(a[k], b[k]));
  }
  return a === b;
}

/** A JSON object typed into the raw editor, or the reason it cannot be sent. */
export function parseObject(textValue: string): { body: Json } | { error: string } {
  try {
    const v: unknown = JSON.parse(textValue);
    return isObject(v) ? { body: v } : { error: 'The body must be a JSON object.' };
  } catch (e) {
    return { error: `This isn't valid JSON: ${e instanceof Error ? e.message : 'it does not parse'}.` };
  }
}

/** One server-sent event as the gateway relays it. */
export interface StreamEvent {
  event?: string;
  data: unknown;
}

export interface Usage {
  input: number | null;
  output: number | null;
}

/** An answer assembled so far: its text, why it stopped, the usage it reported, or its error. */
export interface Assembled {
  text: string;
  finish: string | null;
  usage: Usage;
  error: string | null;
  /** Embeddings: how many vectors and their length. */
  vectors: { count: number; dimensions: number; sample: number[] } | null;
  /** Rerank: hit count */
  rerankHits: number | null;
}

export function emptyAssembled(): Assembled {
  return {
    text: '',
    finish: null,
    usage: { input: null, output: null },
    error: null,
    vectors: null,
    rerankHits: null,
  };
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function usageOf(u: unknown): Usage | null {
  if (!isObject(u)) return null;
  return {
    input: int(u.prompt_tokens) ?? int(u.input_tokens),
    output: int(u.completion_tokens) ?? int(u.output_tokens),
  };
}

function mergeUsage(into: Usage, u: Usage | null): void {
  if (!u) return;
  if (u.input !== null) into.input = u.input;
  if (u.output !== null) into.output = u.output;
}

function errorText(v: unknown): string | null {
  if (!isObject(v)) return null;
  const e = isObject(v.error) ? v.error : null;
  if (!e) return null;
  return typeof e.message === 'string' ? e.message : JSON.stringify(e);
}

/** Adds one event of any dialect's stream to an answer. */
export function addEvent(a: Assembled, e: StreamEvent): Assembled {
  const d = e.data;
  if (!isObject(d)) return a;
  const next: Assembled = { ...a, usage: { ...a.usage } };
  const err = errorText(d);
  if (err) next.error = err;
  if (Array.isArray(d.choices)) {
    for (const choice of d.choices) {
      if (!isObject(choice)) continue;
      const delta = isObject(choice.delta) ? choice.delta : null;
      if (delta && typeof delta.content === 'string') next.text += delta.content;
      if (typeof choice.finish_reason === 'string') next.finish = choice.finish_reason;
    }
    mergeUsage(next.usage, usageOf(d.usage));
    return next;
  }
  switch (d.type) {
    case 'message_start':
      mergeUsage(next.usage, isObject(d.message) ? usageOf(d.message.usage) : null);
      break;
    case 'content_block_delta':
      if (isObject(d.delta) && typeof d.delta.text === 'string') next.text += d.delta.text;
      break;
    case 'message_delta':
      if (isObject(d.delta) && typeof d.delta.stop_reason === 'string') next.finish = d.delta.stop_reason;
      mergeUsage(next.usage, { input: null, output: isObject(d.usage) ? int(d.usage.output_tokens) : null });
      break;
    case 'response.output_text.delta':
      if (typeof d.delta === 'string') next.text += d.delta;
      break;
    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed':
      if (isObject(d.response)) {
        mergeUsage(next.usage, usageOf(d.response.usage));
        if (typeof d.response.status === 'string') next.finish = d.response.status;
        const fail = errorText(d.response);
        if (fail) next.error = fail;
      }
      break;
    default:
      break;
  }
  return next;
}

/** An answer that came whole: chat, Messages or Responses text, embeddings, or an error envelope. */
export function assembleBody(body: unknown, answerText: (body: unknown) => string): Assembled {
  const a = emptyAssembled();
  if (!isObject(body)) {
    if (typeof body === 'string') a.text = body;
    return a;
  }
  a.error = errorText(body);
  mergeUsage(a.usage, usageOf(body.usage));
  if (Array.isArray(body.data) && body.data.every((d) => isObject(d) && Array.isArray(d.embedding))) {
    const first = (body.data[0] as Json | undefined)?.embedding as unknown[] | undefined;
    a.vectors = {
      count: body.data.length,
      dimensions: first?.length ?? 0,
      sample: (first ?? []).slice(0, 6).filter((v): v is number => typeof v === 'number'),
    };
    return a;
  }
  if (isObject(body.answers)) {
    a.text = JSON.stringify(body.answers, null, 2);
    return a;
  }
  if (Array.isArray(body.results)) a.rerankHits = body.results.length;
  else if (Array.isArray(body.data)) a.rerankHits = body.data.length;
  if (typeof body.text === 'string' && !a.text) a.text = body.text;
  if (!a.error) a.text = answerText(body);
  if (Array.isArray(body.choices)) {
    const c: unknown = body.choices[0];
    if (isObject(c) && typeof c.finish_reason === 'string') a.finish = c.finish_reason;
  } else if (typeof body.stop_reason === 'string') a.finish = body.stop_reason;
  else if (typeof body.status === 'string') a.finish = body.status;
  return a;
}

/**
 * Splits text read from an event stream into complete events, returning them and the unfinished
 * tail to keep for the next read.
 */
export function splitEvents(buffer: string): { events: StreamEvent[]; rest: string } {
  const normalised = buffer.replace(/\r\n/g, '\n');
  const blocks = normalised.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: StreamEvent[] = [];
  for (const block of blocks) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length === 0) continue;
    const joined = data.join('\n');
    let parsed: unknown = joined;
    try {
      parsed = JSON.parse(joined);
    } catch {
      parsed = joined;
    }
    events.push(event === undefined ? { data: parsed } : { event, data: parsed });
  }
  return { events, rest };
}
