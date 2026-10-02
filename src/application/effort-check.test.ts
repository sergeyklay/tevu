import { describe, expect, it } from 'vitest';

import {
  buildEffortConfig,
  buildEffortTask,
  buildListedModels,
} from './__fixtures__/effort.fixtures';
import { checkEfforts, checkRoleEffort } from './effort-check';

import type { ModelVariantEvidence } from './effort-check';
import type { EffortCheck, TevuConfig } from '@/domain/types';

const MODEL = 'prov/model-a';
const VARIANTS_CLAUSE = '"opencode models --verbose" reports for "prov/model-a" (high, low)';

type Inputs = Parameters<typeof checkEfforts>[0];

function check(config: TevuConfig, overrides: Partial<Inputs> = {}) {
  return checkEfforts({
    config,
    listings: new Map([['opencode', buildListedModels([MODEL], { [MODEL]: ['high', 'low'] })]]),
    repositoryConfigurationEntries: new Map([
      ['opencode', ['.opencode', 'opencode.json', 'opencode.jsonc']],
    ]),
    rootEntries: new Map([
      ['task-a', ['README.md']],
      ['task-b', ['README.md']],
    ]),
    ...overrides,
  });
}

function checkRoles(config: TevuConfig, overrides: Partial<Inputs> = {}) {
  const result = check(config, overrides);
  return {
    checks: result.checks,
    findings: result.findings.filter((finding) => finding.identifier.startsWith('roles.')),
  };
}

function entryConfig(effort: string): TevuConfig {
  return buildEffortConfig({ models: [{ id: 'known', model: MODEL, effort }] });
}

function roleConfig(
  role: 'criteria' | 'grader' | 'summary',
  effort: string,
  graded = false,
): TevuConfig {
  return buildEffortConfig({
    roles: { [role]: { model: MODEL, effort } },
    tasks: [buildEffortTask('task-a', { graded }), buildEffortTask('task-b')],
  });
}

function listedEvidence(variants: readonly string[] | null): ModelVariantEvidence {
  return { kind: 'listed', variants };
}

function checkRole(
  evidence: ModelVariantEvidence,
  overrides: { role?: 'criteria' | 'grader' | 'summary'; effort?: string; command?: string } = {},
): EffortCheck {
  return checkRoleEffort({
    role: overrides.role ?? 'criteria',
    agent: 'opencode',
    command: overrides.command ?? 'opencode',
    model: MODEL,
    effort: overrides.effort ?? 'hihg',
    evidence,
  });
}

describe('checkEfforts for a model entry', () => {
  it('leaves the effort unverified without a finding when the agent produced no listing (C1)', () => {
    const { checks, findings } = check(entryConfig('high'), { listings: new Map() });

    expect(checks.models['known']).toEqual({
      status: 'unverified',
      reason: `the variants of "${MODEL}" were not read because agent "opencode" produced no model listing`,
    });
    expect(findings).toEqual([]);
  });

  it('leaves the effort unverified without a finding when the listing lacks the model (C2)', () => {
    const { checks, findings } = check(entryConfig('high'), {
      listings: new Map([['opencode', buildListedModels(['prov/other'])]]),
    });

    expect(checks.models['known']).toEqual({
      status: 'unverified',
      reason: `the variants of "${MODEL}" were not read because agent "opencode" does not list "${MODEL}"`,
    });
    expect(findings).toEqual([]);
  });

  it('warns when the model is listed without variant data (C3)', () => {
    const { checks, findings } = check(entryConfig('high'), {
      listings: new Map([['opencode', buildListedModels([MODEL])]]),
    });

    const reason = `"opencode models --verbose" reports no variant data for "${MODEL}", so effort "high" is used as requested without verification; "opencode" applies no variant options when "${MODEL}" has no variant of that name`;
    expect(checks.models['known']).toEqual({ status: 'unverified', reason });
    expect(findings).toEqual([
      { severity: 'warning', identifier: 'models.known.effort', message: reason },
    ]);
  });

  it('verifies an effort that is among the reported variants (C4)', () => {
    const { checks, findings } = check(entryConfig('low'));

    expect(checks.models['known']).toEqual({ status: 'verified' });
    expect(findings).toEqual([]);
  });

  it('refuses an effort outside the reported variants when no task has agent configuration (C5)', () => {
    const { checks, findings } = check(entryConfig('hihg'));

    const reason = `"hihg" is not among the variants ${VARIANTS_CLAUSE}, and these tasks have no agent configuration at the root of their base commit: task-a, task-b; their cases would run "${MODEL}" with its default options`;
    expect(checks.models['known']).toEqual({ status: 'unsupported', reason });
    expect(findings).toEqual([
      { severity: 'error', identifier: 'models.known.effort', message: reason },
    ]);
  });

  it('names only the tasks without agent configuration when others have some (C5)', () => {
    const { checks, findings } = check(entryConfig('hihg'), {
      rootEntries: new Map([
        ['task-a', ['README.md', 'opencode.json']],
        ['task-b', ['README.md']],
      ]),
    });

    const reason = `"hihg" is not among the variants ${VARIANTS_CLAUSE}, and these tasks have no agent configuration at the root of their base commit: task-b; their cases would run "${MODEL}" with its default options`;
    expect(checks.models['known']).toEqual({ status: 'unsupported', reason });
    expect(findings).toEqual([
      { severity: 'error', identifier: 'models.known.effort', message: reason },
    ]);
  });

  it('only warns when the model reports no variants at all (C5)', () => {
    const { checks, findings } = check(entryConfig('hihg'), {
      listings: new Map([['opencode', buildListedModels([MODEL], { [MODEL]: [] })]]),
    });

    const reason = `"opencode models --verbose" reports no variants for "${MODEL}", so effort "hihg" selects none, and these tasks have no agent configuration at the root of their base commit: task-a, task-b; their cases run "${MODEL}" with its default options`;
    expect(checks.models['known']).toEqual({ status: 'unsupported', reason });
    expect(findings).toEqual([
      { severity: 'warning', identifier: 'models.known.effort', message: reason },
    ]);
  });

  it('only warns when every task may define the variant in its repository (C6)', () => {
    const { checks, findings } = check(entryConfig('hihg'), {
      rootEntries: new Map([
        ['task-a', ['README.md', 'opencode.json']],
        ['task-b', ['opencode.jsonc', '.opencode']],
      ]),
    });

    const reason = `"hihg" is not among the variants ${VARIANTS_CLAUSE} without a task repository, and the repository of each task may define it: task-a (opencode.json), task-b (.opencode, opencode.jsonc); it is used as requested without verification, and "opencode" applies no variant options when "${MODEL}" has no variant of that name`;
    expect(checks.models['known']).toEqual({ status: 'unverified', reason });
    expect(findings).toEqual([
      { severity: 'warning', identifier: 'models.known.effort', message: reason },
    ]);
  });

  it('words the may-define reason for an empty variant list without the variants clause (C6)', () => {
    const { checks } = check(entryConfig('hihg'), {
      listings: new Map([['opencode', buildListedModels([MODEL], { [MODEL]: [] })]]),
      rootEntries: new Map([
        ['task-a', ['opencode.json']],
        ['task-b', ['opencode.json']],
      ]),
    });

    expect(checks.models['known']).toEqual({
      status: 'unverified',
      reason: `"opencode models --verbose" reports no variants for "${MODEL}", so effort "hihg" selects none without a task repository, and the repository of each task may define it: task-a (opencode.json), task-b (opencode.json); it is used as requested without verification, and "opencode" applies no variant options when "${MODEL}" has no variant of that name`,
    });
  });

  it('puts a task without a root entries key in the may-define list as not inspected (C6)', () => {
    const { checks } = check(entryConfig('hihg'), {
      rootEntries: new Map([['task-a', ['opencode.json']]]),
    });

    expect(checks.models['known']).toMatchObject({
      status: 'unverified',
      reason: expect.stringContaining(
        'may define it: task-a (opencode.json), task-b (base commit not inspected);',
      ) as string,
    });
  });

  it('keeps an inspected task without agent configuration in the refused list beside a task not inspected (C5)', () => {
    const { checks } = check(entryConfig('hihg'), {
      rootEntries: new Map([['task-a', ['README.md']]]),
    });

    expect(checks.models['known']).toMatchObject({
      status: 'unsupported',
      reason: expect.stringContaining(
        'at the root of their base commit: task-a; their cases would run',
      ) as string,
    });
  });

  it('treats every task as not inspected when no base commit was inspected (C6)', () => {
    const { checks, findings } = check(entryConfig('hihg'), { rootEntries: new Map() });

    expect(checks.models['known']).toMatchObject({
      status: 'unverified',
      reason: expect.stringContaining(
        'task-a (base commit not inspected), task-b (base commit not inspected);',
      ) as string,
    });
    expect(findings.map((finding) => finding.severity)).toEqual(['warning']);
  });

  it('compares the effort verbatim, without trimming or case folding', () => {
    const upper = check(entryConfig('High'));
    const padded = check(entryConfig(' high'));

    expect(upper.checks.models['known']?.status).toBe('unsupported');
    expect(padded.checks.models['known']?.status).toBe('unsupported');
  });

  it('names the agent command, not the agent name, in every listing command', () => {
    const config = buildEffortConfig({
      agents: { opencode: { command: '/opt/bin/oc' } },
    });

    const { checks } = check(config, {
      listings: new Map([['opencode', buildListedModels([MODEL])]]),
    });

    expect(checks.models['known']).toMatchObject({
      reason: expect.stringContaining(
        `"/opt/bin/oc models --verbose" reports no variant data for "${MODEL}"`,
      ) as string,
    });
    expect(checks.models['known']).toMatchObject({
      reason: expect.stringContaining(`"/opt/bin/oc" applies no variant options`) as string,
    });
  });

  it('records exactly one check per model entry, in configuration order, and none for undeclared roles', () => {
    const config = buildEffortConfig({
      models: [
        { id: 'zeta', model: MODEL, effort: 'high' },
        { id: 'alpha', model: MODEL, effort: 'low' },
      ],
    });

    const { checks } = check(config);

    expect(Object.keys(checks.models)).toEqual(['zeta', 'alpha']);
    expect(checks.roles).toEqual({});
  });
});

describe('checkEfforts and the sources of a variant', () => {
  it('accepts a built-in variant without any finding', () => {
    const { findings } = check(entryConfig('high'));

    expect(findings).toEqual([]);
  });

  it('accepts a variant the listing reports only because a copied provider defines it', () => {
    const config = entryConfig('turbo');

    const { checks, findings } = check(config, {
      listings: new Map([['opencode', buildListedModels([MODEL], { [MODEL]: ['high', 'turbo'] })]]),
    });

    expect(checks.models['known']).toEqual({ status: 'verified' });
    expect(findings).toEqual([]);
  });

  it('leaves a variant only a task repository can define without an error', () => {
    const { findings } = check(entryConfig('repo-defined'), {
      rootEntries: new Map([
        ['task-a', ['opencode.json']],
        ['task-b', ['opencode.json']],
      ]),
    });

    expect(findings.map((finding) => finding.severity)).toEqual(['warning']);
  });
});

describe('checkRoleEffort', () => {
  it('leaves the effort unverified when no listing was produced (R1)', () => {
    const result = checkRole({ kind: 'no-listing' });

    expect(result).toEqual({
      status: 'unverified',
      reason: `the variants of "${MODEL}" were not read because agent "opencode" produced no model listing`,
    });
  });

  it('leaves the effort unverified when the model is not listed (R2)', () => {
    const result = checkRole({ kind: 'not-listed' });

    expect(result).toEqual({
      status: 'unverified',
      reason: `the variants of "${MODEL}" were not read because agent "opencode" does not list "${MODEL}"`,
    });
  });

  it('leaves the effort unverified when the model has no variant data (R3)', () => {
    const result = checkRole(listedEvidence(null), { effort: 'high' });

    expect(result).toEqual({
      status: 'unverified',
      reason: `"opencode models --verbose" reports no variant data for "${MODEL}", so effort "high" is used as requested without verification; "opencode" applies no variant options when "${MODEL}" has no variant of that name`,
    });
  });

  it('verifies an effort among the reported variants (R4)', () => {
    const result = checkRole(listedEvidence(['high', 'low']), { effort: 'low' });

    expect(result).toEqual({ status: 'verified' });
  });

  it('marks an effort outside the reported variants unsupported and names the call (R5)', () => {
    const result = checkRole(listedEvidence(['high', 'low']), { role: 'grader' });

    expect(result).toEqual({
      status: 'unsupported',
      reason: `"hihg" is not among the variants ${VARIANTS_CLAUSE}, so a grader call would run "${MODEL}" with its default options`,
    });
  });

  it('names a summary call when the summary effort is outside the reported variants (R5)', () => {
    const result = checkRole(listedEvidence(['high', 'low']), { role: 'summary' });

    expect(result).toEqual({
      status: 'unsupported',
      reason: `"hihg" is not among the variants ${VARIANTS_CLAUSE}, so a summary call would run "${MODEL}" with its default options`,
    });
  });

  it('words the unsupported reason for a model without variants in the present tense (R5)', () => {
    const result = checkRole(listedEvidence([]), { role: 'criteria' });

    expect(result).toEqual({
      status: 'unsupported',
      reason: `"opencode models --verbose" reports no variants for "${MODEL}", so effort "hihg" selects none, so a criteria call runs "${MODEL}" with its default options`,
    });
  });

  it('compares the effort verbatim', () => {
    const result = checkRole(listedEvidence(['high']), { effort: 'HIGH' });

    expect(result.status).toBe('unsupported');
  });
});

describe('checkEfforts for a role', () => {
  it('warns for a criteria effort outside the reported variants even when a task has a graded check', () => {
    const { checks, findings } = checkRoles(roleConfig('criteria', 'hihg', true));

    expect(checks.roles.criteria?.status).toBe('unsupported');
    expect(findings).toEqual([
      {
        severity: 'warning',
        identifier: 'roles.criteria.effort',
        message: `"hihg" is not among the variants ${VARIANTS_CLAUSE}, so a criteria call would run "${MODEL}" with its default options`,
      },
    ]);
  });

  it('refuses a grader effort outside the reported variants when a task declares a graded check', () => {
    const { checks, findings } = checkRoles(roleConfig('grader', 'hihg', true));

    expect(checks.roles.grader?.status).toBe('unsupported');
    expect(findings).toEqual([
      {
        severity: 'error',
        identifier: 'roles.grader.effort',
        message: `"hihg" is not among the variants ${VARIANTS_CLAUSE}, so a grader call would run "${MODEL}" with its default options`,
      },
    ]);
  });

  it('only warns for a grader effort outside the reported variants when no task has a graded check', () => {
    const { findings } = checkRoles(roleConfig('grader', 'hihg', false));

    expect(findings.map((finding) => finding.severity)).toEqual(['warning']);
  });

  it('only warns for a grader effort when the model reports no variants, even with a graded check', () => {
    const { checks, findings } = checkRoles(roleConfig('grader', 'hihg', true), {
      listings: new Map([['opencode', buildListedModels([MODEL], { [MODEL]: [] })]]),
    });

    expect(checks.roles.grader?.status).toBe('unsupported');
    expect(findings.map((finding) => finding.severity)).toEqual(['warning']);
  });

  it('warns for a role on a model without variant data (R3)', () => {
    const { findings } = checkRoles(roleConfig('grader', 'high', true), {
      listings: new Map([['opencode', buildListedModels([MODEL])]]),
    });

    expect(findings).toEqual([
      expect.objectContaining({ severity: 'warning', identifier: 'roles.grader.effort' }),
    ]);
  });

  it('raises no role finding when the listing failed or lacks the model (R1, R2)', () => {
    const unlisted = checkRoles(roleConfig('grader', 'high', true), {
      listings: new Map([['opencode', buildListedModels(['prov/other'])]]),
    });
    const failed = checkRoles(roleConfig('grader', 'high', true), { listings: new Map() });

    expect(unlisted.findings).toEqual([]);
    expect(failed.findings).toEqual([]);
    expect(unlisted.checks.roles.grader?.status).toBe('unverified');
    expect(failed.checks.roles.grader?.status).toBe('unverified');
  });

  it('verifies a role effort among the reported variants (R4)', () => {
    const { checks, findings } = checkRoles(roleConfig('grader', 'low', true));

    expect(checks.roles).toEqual({ grader: { status: 'verified' } });
    expect(findings).toEqual([]);
  });

  it('only warns for a summary effort outside the reported variants, even when a task has a graded check', () => {
    const { checks, findings } = checkRoles(roleConfig('summary', 'hihg', true));

    expect(checks.roles.summary?.status).toBe('unsupported');
    expect(findings).toEqual([
      {
        severity: 'warning',
        identifier: 'roles.summary.effort',
        message: `"hihg" is not among the variants ${VARIANTS_CLAUSE}, so a summary call would run "${MODEL}" with its default options`,
      },
    ]);
  });

  it('warns for a summary effort on a model without variant data (R3)', () => {
    const { findings } = checkRoles(roleConfig('summary', 'high'), {
      listings: new Map([['opencode', buildListedModels([MODEL])]]),
    });

    expect(findings).toEqual([
      expect.objectContaining({ severity: 'warning', identifier: 'roles.summary.effort' }),
    ]);
  });

  it('raises no summary finding when the listing failed or lacks the model (R1, R2)', () => {
    const unlisted = checkRoles(roleConfig('summary', 'high'), {
      listings: new Map([['opencode', buildListedModels(['prov/other'])]]),
    });
    const failed = checkRoles(roleConfig('summary', 'high'), { listings: new Map() });

    expect(unlisted.findings).toEqual([]);
    expect(failed.findings).toEqual([]);
    expect(unlisted.checks.roles.summary?.status).toBe('unverified');
    expect(failed.checks.roles.summary?.status).toBe('unverified');
  });

  it('verifies a summary effort among the reported variants (R4)', () => {
    const { checks, findings } = checkRoles(roleConfig('summary', 'low'));

    expect(checks.roles).toEqual({ summary: { status: 'verified' } });
    expect(findings).toEqual([]);
  });

  it('checks only the declared roles', () => {
    const { checks } = check(roleConfig('criteria', 'high'));

    expect(Object.keys(checks.roles)).toEqual(['criteria']);
  });
});

describe('checkEfforts findings order', () => {
  it('lists model entries in configuration order, then criteria, then grader', () => {
    const config = buildEffortConfig({
      models: [
        { id: 'zeta', model: MODEL, effort: 'hihg' },
        { id: 'alpha', model: MODEL, effort: 'hihg' },
      ],
      roles: {
        grader: { model: MODEL, effort: 'hihg' },
        criteria: { model: MODEL, effort: 'hihg' },
      },
      tasks: [buildEffortTask('task-a', { graded: true }), buildEffortTask('task-b')],
    });

    const { findings } = check(config);

    expect(findings.map((finding) => finding.identifier)).toEqual([
      'models.zeta.effort',
      'models.alpha.effort',
      'roles.criteria.effort',
      'roles.grader.effort',
    ]);
  });

  it('lists the summary finding after the criteria and grader findings whatever the configuration order', () => {
    const config = buildEffortConfig({
      roles: {
        summary: { model: MODEL, effort: 'hihg' },
        grader: { model: MODEL, effort: 'hihg' },
        criteria: { model: MODEL, effort: 'hihg' },
      },
    });

    const { findings } = checkRoles(config);

    expect(findings.map((finding) => finding.identifier)).toEqual([
      'roles.criteria.effort',
      'roles.grader.effort',
      'roles.summary.effort',
    ]);
  });
});
