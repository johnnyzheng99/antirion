'use client';

import { type KeyboardEvent } from 'react';

import { Button, IconButton } from '@/components/ui/button';
import { Switch } from '@/components/ui/choice';
import { Field, NumberInput, Segmented, Textarea } from '@/components/ui/form';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/cn';

import { endpointUsesChatForm } from '../body';
import type { Composer, Role, Turn } from '../body';

type Errors = Partial<Record<keyof Composer, string>>;

const ROLE_LABEL: Record<Role, string> = { user: 'User', assistant: 'Assistant' };

/** One message of the conversation: its role, its text, and remove. */
function TurnField({
  turn,
  index,
  onChange,
  onRemove,
  onSubmit,
}: {
  turn: Turn;
  index: number;
  onChange: (turn: Turn) => void;
  onRemove: (() => void) | null;
  onSubmit: () => void;
}) {
  const id = `turn-${index}`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Segmented
          label={`Role of message ${index + 1}`}
          value={turn.role}
          onChange={(role) => onChange({ ...turn, role })}
          options={(['user', 'assistant'] as const).map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
        />
        {onRemove ? (
          <IconButton icon="x" label={`Remove message ${index + 1}`} onClick={onRemove} size={14} />
        ) : null}
      </div>
      <Textarea
        id={id}
        aria-label={`${ROLE_LABEL[turn.role]} message ${index + 1}`}
        rows={turn.role === 'user' ? 4 : 3}
        value={turn.text}
        placeholder={turn.role === 'user' ? 'Write a message' : 'What the assistant said'}
        onChange={(e) => onChange({ ...turn, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}

/** The form for a chat, Responses, Messages or embeddings request. */
export function ComposerForm({
  value,
  onChange,
  errors,
  onSubmit,
}: {
  value: Composer;
  onChange: (next: Composer) => void;
  errors: Errors;
  onSubmit: () => void;
}) {
  const set = <K extends keyof Composer>(key: K, v: Composer[K]) => onChange({ ...value, [key]: v });
  const submitOnModEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    }
  };
  if (value.endpoint === 'embeddings') {
    return (
      <Field label="Input" hint="One text per line; each gets its own vector." error={errors.input}>
        <Textarea
          rows={6}
          value={value.input}
          placeholder="Text to embed"
          onChange={(e) => set('input', e.target.value)}
          onKeyDown={submitOnModEnter}
        />
      </Field>
    );
  }
  if (value.endpoint === 'speech') {
    return (
      <div className="flex flex-col gap-4">
        <Field label="Text to speak" error={errors.speechInput}>
          <Textarea
            rows={4}
            value={value.speechInput}
            placeholder="Write the line you want synthesised"
            onChange={(e) => set('speechInput', e.target.value)}
            onKeyDown={submitOnModEnter}
          />
        </Field>
        <Field label="Voice" hint="Provider voice id (e.g. alloy)." error={errors.voice}>
          <input
            className="mono w-full rounded-control border border-line bg-surface px-3 py-2 text-ui text-fg"
            value={value.voice}
            onChange={(e) => set('voice', e.target.value)}
          />
        </Field>
      </div>
    );
  }
  if (value.endpoint === 'transcriptions') {
    return (
      <Field
        label="Audio file"
        hint="Sent as multipart/form-data through the gateway."
        error={errors.audioFileBase64}
      >
        <div>
          <input
            type="file"
            accept="audio/*,video/*"
            className="text-ui text-fg file:mr-3 file:rounded-control file:border-0 file:bg-raised file:px-3 file:py-1.5 file:text-ui"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) {
                set('audioFileName', '');
                set('audioFileBase64', '');
                return;
              }
              const reader = new FileReader();
              reader.onload = () => {
                const raw = typeof reader.result === 'string' ? reader.result : '';
                const base64 = raw.includes(',') ? (raw.split(',')[1] ?? '') : raw;
                onChange({ ...value, audioFileName: file.name, audioFileBase64: base64 });
              };
              reader.readAsDataURL(file);
            }}
          />
          {value.audioFileName ? (
            <p className="mt-1.5 text-caption text-muted">
              Selected <span className="mono text-fg">{value.audioFileName}</span>
            </p>
          ) : null}
        </div>
      </Field>
    );
  }
  if (value.endpoint === 'rerank') {
    return (
      <div className="flex flex-col gap-4">
        <Field label="Query" error={errors.rerankQuery}>
          <Textarea
            rows={2}
            value={value.rerankQuery}
            placeholder="What should the documents be ranked against?"
            onChange={(e) => set('rerankQuery', e.target.value)}
            onKeyDown={submitOnModEnter}
          />
        </Field>
        <Field label="Documents" hint="One passage per line." error={errors.rerankDocuments}>
          <Textarea
            rows={6}
            value={value.rerankDocuments}
            placeholder="First document&#10;Second document"
            onChange={(e) => set('rerankDocuments', e.target.value)}
          />
        </Field>
        <Field label="Top N" optional hint="How many hits to return.">
          <NumberInput value={value.rerankTopN} onChange={(v) => set('rerankTopN', v)} min={1} step={1} />
        </Field>
      </div>
    );
  }
  if (value.endpoint === 'decisions') {
    return (
      <div className="flex flex-col gap-4">
        <Field
          label="State"
          hint="Plain text or JSON — the situation to evaluate (Clef / System One)."
          error={errors.decisionState}
        >
          <Textarea
            rows={4}
            value={value.decisionState}
            onChange={(e) => set('decisionState', e.target.value)}
            onKeyDown={submitOnModEnter}
          />
        </Field>
        <Field label="Questions" hint="JSON map of question ids to typed questions." error={errors.decisionQuestions}>
          <Textarea rows={10} mono value={value.decisionQuestions} onChange={(e) => set('decisionQuestions', e.target.value)} />
        </Field>
        <p className="text-caption text-muted">
          Use deployment model <span className="mono text-fg">@cf/cloudflare/clef-flash</span> (or similar); the body
          sends <span className="mono text-fg">clef-flash</span> as the selector when needed.
        </p>
      </div>
    );
  }
  const turns = value.turns;
  return (
    <div className="flex flex-col gap-4">
      <Field label="System instructions" optional>
        <Textarea
          rows={2}
          value={value.system}
          placeholder="How the model should answer"
          onChange={(e) => set('system', e.target.value)}
        />
      </Field>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1.5 text-ui font-medium text-fg">Conversation</legend>
        {turns.map((turn, i) => (
          <TurnField
            key={i}
            turn={turn}
            index={i}
            onSubmit={onSubmit}
            onChange={(t) =>
              set(
                'turns',
                turns.map((x, j) => (j === i ? t : x)),
              )
            }
            onRemove={
              turns.length > 1
                ? () =>
                    set(
                      'turns',
                      turns.filter((_, j) => j !== i),
                    )
                : null
            }
          />
        ))}
        {errors.turns ? (
          <p role="alert" className="flex items-start gap-1.5 text-caption text-error">
            <Icon name="alertCircle" size={14} className="mt-px shrink-0" />
            {errors.turns}
          </p>
        ) : null}
        <div>
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            onClick={() =>
              set('turns', [
                ...turns,
                { role: turns.at(-1)?.role === 'user' ? 'assistant' : 'user', text: '' },
              ])
            }
          >
            Add message
          </Button>
        </div>
      </fieldset>
    </div>
  );
}

/** Temperature, top P, the answer's cap, stop sequences and streaming. */
export function Parameters({
  value,
  onChange,
  errors,
}: {
  value: Composer;
  onChange: (next: Composer) => void;
  errors: Errors;
}) {
  const set = <K extends keyof Composer>(key: K, v: Composer[K]) => onChange({ ...value, [key]: v });
  if (!endpointUsesChatForm(value.endpoint)) return null;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Temperature" optional error={errors.temperature} hint="0 to 2">
          <NumberInput
            value={value.temperature}
            onChange={(v) => set('temperature', v)}
            min={0}
            max={2}
            step={0.1}
          />
        </Field>
        <Field label="Top P" optional error={errors.topP} hint="0 to 1">
          <NumberInput value={value.topP} onChange={(v) => set('topP', v)} min={0} max={1} step={0.05} />
        </Field>
        <Field
          label="Max output tokens"
          optional={value.endpoint !== 'messages'}
          required={value.endpoint === 'messages'}
          error={errors.maxTokens}
        >
          <NumberInput value={value.maxTokens} onChange={(v) => set('maxTokens', v)} min={1} step={64} />
        </Field>
      </div>
      {value.endpoint !== 'responses' ? (
        <Field label="Stop sequences" optional hint="One per line, up to four." error={errors.stop}>
          <Textarea
            rows={2}
            mono
            value={value.stop}
            onChange={(e) => set('stop', e.target.value)}
            className="min-h-14"
          />
        </Field>
      ) : null}
      <div
        className={cn('flex items-center justify-between gap-3 rounded-control border border-line px-3 py-2')}
      >
        <div className="min-w-0">
          <p className="text-ui font-medium text-fg">Stream the answer</p>
          <p className="text-caption text-muted">Words show as the model writes them.</p>
        </div>
        <Switch
          checked={value.stream}
          onChange={(v) => set('stream', v)}
          label="Stream the answer"
          hideLabel
        />
      </div>
    </div>
  );
}
