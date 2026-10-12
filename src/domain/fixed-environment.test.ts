import { describe, expect, it } from 'vitest';

import { FIXED_ENVIRONMENT_NAME_MESSAGE, isFixedEnvironmentName } from './fixed-environment';

describe('isFixedEnvironmentName', () => {
  it.each([
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'CI',
    'XDG_',
    'XDG_CONFIG_HOME',
    'XDG_RUNTIME_DIR',
  ])('reports %s as fixed', (name) => {
    expect(isFixedEnvironmentName(name)).toBe(true);
  });

  it.each([
    'path',
    'Path',
    'PATH_EXTRA',
    'MY_PATH',
    'LC_CTYPE',
    'CI_JOB',
    'XDG',
    'xdg_config_home',
    'MY_XDG_DIR',
    'SHELL',
    '',
  ])('reports %j as not fixed', (name) => {
    expect(isFixedEnvironmentName(name)).toBe(false);
  });
});

describe('FIXED_ENVIRONMENT_NAME_MESSAGE', () => {
  it('names the exact variables and the XDG_ prefix in one sentence', () => {
    expect(FIXED_ENVIRONMENT_NAME_MESSAGE).toBe(
      'PATH, HOME, TMPDIR, LANG, LC_ALL, CI, and XDG_* names are fixed by the isolation contract',
    );
  });
});
