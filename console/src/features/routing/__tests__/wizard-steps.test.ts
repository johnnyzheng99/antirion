import { describe, expect, it } from 'vitest';

import { blockingStep } from '../components/rule-wizard';
import { blankDraft, describeDraft } from '../draft';
import { blankGroup } from '../groups';

describe('routing wizard', () => {
  it('never ends the live sentence with an ellipsis and a dot', () => {
    const sentence = describeDraft(blankDraft());
    expect(sentence).not.toMatch(/…\.$/);
    expect(sentence.endsWith('…')).toBe(true);
  });

  it('describes a multi-group rule without recursing on composite', () => {
    const draft = {
      ...blankDraft(),
      strategy: 'composite' as const,
      groups: [blankGroup('weighted'), blankGroup('fallback')],
    };
    expect(() => describeDraft(draft)).not.toThrow();
    expect(describeDraft(draft)).toContain('then');
  });

  it('stops Next on the first earlier step that has errors, and shows only those', () => {
    const errors = {
      name: 'Name the rule',
      targets: 'Choose at least one deployment',
      'limits.attempt': 'x',
    };
    expect(blockingStep(errors, 1)).toEqual({ step: 0, errors: { name: 'Name the rule' } });
    expect(blockingStep({ targets: errors.targets, 'limits.attempt': 'x' }, 3)).toEqual({
      step: 1,
      errors: { targets: errors.targets, 'limits.attempt': 'x' },
    });
    expect(blockingStep({ 'limits.attempt': 'x' }, 2)).toBeNull();
    expect(blockingStep({}, 2)).toBeNull();
  });
});
