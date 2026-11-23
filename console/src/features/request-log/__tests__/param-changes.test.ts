import { describe, expect, it } from 'vitest';

import { paramChanges, paramValue } from '../types';

describe('Request parameters changed', () => {
  it('reads the changes of a record, in order, and ignores what is not one', () => {
    const changes = paramChanges({
      params_applied: {
        overrides: ['/temperature'],
        removed: ['/user'],
        changes: [
          { source: 'provider', action: 'removed', pointer: '/user', previous: 'alice' },
          { source: 'deployment', action: 'override', pointer: '/temperature', value: 0.2, previous: 0.9 },
          'not a change',
        ],
      },
    });
    expect(changes.map((c) => [c.action, c.pointer])).toEqual([
      ['removed', '/user'],
      ['override', '/temperature'],
    ]);
    expect(paramChanges({ params_applied: { overrides: [], removed: [] } })).toEqual([]);
    expect(paramChanges({ params_applied: null })).toEqual([]);
  });

  it('words a value: JSON, "not set" for an absent member, a dash when not logged', () => {
    expect(paramValue(0.2)).toBe('0.2');
    expect(paramValue({ team: 's' })).toBe('{"team":"s"}');
    expect(paramValue(null)).toBe('not set');
    expect(paramValue(undefined)).toBe('—');
  });
});
