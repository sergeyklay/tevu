import { describe, expect, it } from 'vitest';

import { describePath } from './describe-path';

describe('describePath', () => {
  it('renders an empty path as the root', () => {
    expect(describePath([])).toBe('(root)');
  });

  it.each([
    { path: ['cases'], expected: 'cases' },
    { path: ['cases', 0, 'metrics'], expected: 'cases.0.metrics' },
    { path: ['a.b', ''], expected: 'a.b.' },
    { path: [Symbol('key'), 2], expected: 'Symbol(key).2' },
  ])('joins the segments of $path with dots', ({ path, expected }) => {
    expect(describePath(path)).toBe(expected);
  });
});
