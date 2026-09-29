// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  inspectOpenCodeProvider,
  operatorOpenCodeDirectory,
  readOpenCodeProviders,
} from './opencode-providers';

import type { OpenCodeAdapterDependencies, OpenCodeAdapterSettings } from './opencode';
import type { AgentProviderSetting } from '@/domain/types';

type OperatorDirectories = OpenCodeAdapterDependencies['operatorDirectories'];

function buildSettings(overrides: Partial<OpenCodeAdapterSettings> = {}): OpenCodeAdapterSettings {
  return {
    agent: 'opencode',
    executable: 'unused-executable',
    providers: [],
    declaredVariables: { secrets: [], env: [] },
    ...overrides,
  };
}

function buildProviders(...providers: AgentProviderSetting[]): AgentProviderSetting[] {
  return providers;
}

describe('operatorOpenCodeDirectory', () => {
  it('prefers an absolute, non-empty XDG_CONFIG_HOME over HOME', () => {
    expect(
      operatorOpenCodeDirectory({ home: '/home/operator', xdgConfigHome: '/xdg/config' }),
    ).toBe(join('/xdg/config', 'opencode'));
  });

  it('falls back to HOME/.config when XDG_CONFIG_HOME is unset', () => {
    expect(operatorOpenCodeDirectory({ home: '/home/operator', xdgConfigHome: undefined })).toBe(
      join('/home/operator', '.config', 'opencode'),
    );
  });

  it.each([
    { home: undefined, xdgConfigHome: '' },
    { home: undefined, xdgConfigHome: 'relative/xdg' },
    { home: '', xdgConfigHome: undefined },
    { home: 'relative/home', xdgConfigHome: undefined },
    { home: undefined, xdgConfigHome: undefined },
  ])(
    'falls back past an unset, empty, or relative XDG_CONFIG_HOME ($xdgConfigHome) to HOME ($home)',
    ({ home, xdgConfigHome }) => {
      const result = operatorOpenCodeDirectory({ home, xdgConfigHome });

      if (home !== undefined && home.length > 0 && home.startsWith('/')) {
        expect(result).toBe(join(home, '.config', 'opencode'));
      } else {
        expect(result).toBeUndefined();
      }
    },
  );
});

function useOperatorConfigDirectory(): {
  operatorRoot: () => string;
  operatorDirectories: () => OperatorDirectories;
  writeConfigFile: (fileName: string, text: string) => Promise<void>;
  writeOpencodeJson: (document: unknown) => Promise<void>;
} {
  let operatorRoot = '';

  beforeEach(async () => {
    operatorRoot = await mkdtemp(join(tmpdir(), 'tevu-opencode-providers-'));
  });

  afterEach(async () => {
    await rm(operatorRoot, { recursive: true, force: true });
  });

  async function writeConfigFile(fileName: string, text: string): Promise<void> {
    const directory = join(operatorRoot, 'opencode');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, fileName), text);
  }

  return {
    operatorRoot: () => operatorRoot,
    operatorDirectories: () => ({ home: undefined, xdgConfigHome: operatorRoot }),
    writeConfigFile,
    writeOpencodeJson: (document) =>
      writeConfigFile('opencode.json', JSON.stringify(document, null, 2)),
  };
}

describe('readOpenCodeProviders', () => {
  const { operatorRoot, operatorDirectories, writeConfigFile, writeOpencodeJson } =
    useOperatorConfigDirectory();

  it('never reads a host file and writes no configuration file when the block names no provider', async () => {
    const settings = buildSettings({ providers: [] });

    const result = await readOpenCodeProviders(settings, {
      home: undefined,
      xdgConfigHome: undefined,
    });

    expect(result).toEqual({
      ok: true,
      value: { agent: 'opencode', configurationFiles: [], findings: [] },
    });
  });

  it('writes exactly the named provider, excluding a sibling provider and every other top-level key', async () => {
    await writeOpencodeJson({
      provider: {
        acme: { baseURL: 'https://acme.example.test' },
        other: { baseURL: 'https://other.example.test' },
      },
      instructions: ['do not copy me'],
      mcp: { server: {} },
      permission: {},
      plugin: [],
      agent: {},
      command: {},
    });
    const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

    const result = await readOpenCodeProviders(settings, operatorDirectories());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.configurationFiles).toHaveLength(1);
    const file = result.value.configurationFiles[0];
    expect(file?.relativePath).toBe('opencode/opencode.json');
    const written = JSON.parse(file?.text ?? '{}') as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(['provider']);
    expect(written.provider).toEqual({ acme: { baseURL: 'https://acme.example.test' } });
    expect(file?.text.endsWith('\n')).toBe(true);
  });

  it('merges a provider definition across config.json, opencode.json, and opencode.jsonc in that order, later files winning', async () => {
    await writeConfigFile(
      'config.json',
      JSON.stringify({
        provider: { acme: { baseURL: 'https://from-config-json.example.test', models: ['a'] } },
      }),
    );
    await writeConfigFile(
      'opencode.json',
      JSON.stringify({ provider: { acme: { name: 'Acme (opencode.json)' } } }),
    );
    await writeConfigFile(
      'opencode.jsonc',
      JSON.stringify({
        provider: { acme: { baseURL: 'https://from-opencode-jsonc.example.test' } },
      }),
    );
    const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

    const result = await readOpenCodeProviders(settings, operatorDirectories());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = JSON.parse(result.value.configurationFiles[0]?.text ?? '{}') as {
      provider: Record<string, unknown>;
    };
    expect(written.provider.acme).toEqual({
      baseURL: 'https://from-opencode-jsonc.example.test',
      models: ['a'],
      name: 'Acme (opencode.json)',
    });
  });

  it('replaces a literal options.apiKey with the configured api_key reference and never writes the literal', async () => {
    const sentinel = 'sk-host-sentinel-should-never-appear-471';
    await writeOpencodeJson({ provider: { acme: { options: { apiKey: sentinel } } } });
    const settings = buildSettings({
      providers: buildProviders({ id: 'acme', api_key: 'ACME_KEY' }),
      declaredVariables: { secrets: ['ACME_KEY'], env: [] },
    });

    const result = await readOpenCodeProviders(settings, operatorDirectories());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = result.value.configurationFiles[0]?.text ?? '';
    expect(text).toContain('"apiKey": "{env:ACME_KEY}"');
    expect(text).not.toContain(sentinel);
  });

  it('rejects a literal options.apiKey with no api_key configured, and writes no file', async () => {
    const sentinel = 'sk-host-sentinel-should-never-appear-472';
    await writeOpencodeJson({ provider: { acme: { options: { apiKey: sentinel } } } });
    const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

    const result = await readOpenCodeProviders(settings, operatorDirectories());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: 'ConfigValidationError',
      findings: [
        {
          severity: 'error',
          identifier: 'agents.opencode.providers.acme',
          message:
            'options.apiKey of provider "acme" is not a {env:NAME} reference; tevu copies no ' +
            'credential value into a case: set api_key to a variable listed in agents.opencode.secrets',
        },
      ],
    });
    expect(JSON.stringify(result.error.findings)).not.toContain(sentinel);
  });

  it('excludes content reachable only through a __proto__ key from the written file and every finding', async () => {
    const sentinel = 'PROTO-LEAK-SENTINEL-042';
    await writeConfigFile(
      'opencode.json',
      `{
  "provider": {
    "acme": {
      "baseURL": "https://acme.example.test",
      "__proto__": { "leakedField": "${sentinel}" }
    }
  }
}`,
    );
    const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

    const result = await readOpenCodeProviders(settings, operatorDirectories());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = result.value.configurationFiles[0]?.text ?? '';
    expect(text).not.toContain(sentinel);
    expect(JSON.stringify(result.value.findings)).not.toContain(sentinel);
    expect(JSON.parse(text)).toEqual({
      provider: { acme: { baseURL: 'https://acme.example.test' } },
    });
  });

  describe('finding labels', () => {
    it('draws P-DIR when neither XDG_CONFIG_HOME nor HOME is usable', async () => {
      const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

      const result = await readOpenCodeProviders(settings, {
        home: undefined,
        xdgConfigHome: undefined,
      });

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ConfigValidationError',
          findings: [
            {
              severity: 'error',
              identifier: 'agents.opencode.providers',
              message:
                'no OpenCode configuration directory to copy providers from: XDG_CONFIG_HOME and ' +
                'HOME are both unset, empty, or relative',
            },
          ],
        },
      });
    });

    it('draws P-READ when a candidate file cannot be read for a reason other than ENOENT', async () => {
      await mkdir(join(operatorRoot(), 'opencode', 'config.json'), { recursive: true });
      const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.findings).toHaveLength(1);
      expect(result.error.findings[0]).toMatchObject({
        severity: 'error',
        identifier: 'agents.opencode.providers',
      });
      expect(result.error.findings[0]?.message).toContain(
        join(operatorRoot(), 'opencode', 'config.json'),
      );
      expect(result.error.findings[0]?.message).toContain('EISDIR');
    });

    it('draws P-PARSE for the first syntax error, naming the file and a line and column', async () => {
      await writeConfigFile('opencode.json', '{ "provider": ');
      const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.findings).toHaveLength(1);
      const [finding] = result.error.findings;
      expect(finding?.identifier).toBe('agents.opencode.providers');
      expect(finding?.message).toMatch(
        /^".*opencode\.json" is not valid JSON with comments: .+ at line \d+, column \d+$/,
      );
    });

    it('draws P-SHAPE when the top level of a candidate file is not an object', async () => {
      await writeConfigFile('opencode.json', '[]');
      const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.findings).toHaveLength(1);
      expect(result.error.findings[0]?.message).toContain('is not an object');
      expect(result.error.findings[0]?.identifier).toBe('agents.opencode.providers');
    });

    it('draws P-SHAPE when "provider" itself is not an object', async () => {
      await writeOpencodeJson({ provider: 'not-an-object' });
      const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.findings[0]?.message).toContain('provider is not an object');
    });

    it('draws P-MISSING when no candidate file defines the named provider', async () => {
      await writeOpencodeJson({ provider: {} });
      const settings = buildSettings({ providers: buildProviders({ id: 'ghost' }) });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.findings).toEqual([
        {
          severity: 'error',
          identifier: 'agents.opencode.providers.ghost',
          message:
            `provider "ghost" is not defined in config.json, opencode.json, or opencode.jsonc ` +
            `under "${join(operatorRoot(), 'opencode')}"`,
        },
      ]);
    });

    it('draws P-SHAPE-DEF when the provider definition itself is not an object', async () => {
      await writeOpencodeJson({ provider: { acme: 'just-a-string' } });
      const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.findings).toEqual([
        {
          severity: 'error',
          identifier: 'agents.opencode.providers.acme',
          message: 'the definition of provider "acme" is not an object',
        },
      ]);
    });

    it('draws P-SHAPE-DEF when options is not an object and api_key is set', async () => {
      await writeOpencodeJson({ provider: { acme: { options: 'not-an-object' } } });
      const settings = buildSettings({
        providers: buildProviders({ id: 'acme', api_key: 'ACME_KEY' }),
        declaredVariables: { secrets: ['ACME_KEY'], env: [] },
      });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.findings).toEqual([
        {
          severity: 'error',
          identifier: 'agents.opencode.providers.acme',
          message: 'the options of provider "acme" is not an object',
        },
      ]);
    });

    it('draws P-APIKEY when a credential-shaped key holds a literal string outside options.apiKey', async () => {
      const sentinel = 'literal-session-token-should-not-appear';
      await writeOpencodeJson({ provider: { acme: { options: { sessionToken: sentinel } } } });
      const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.findings).toEqual([
        {
          severity: 'error',
          identifier: 'agents.opencode.providers.acme',
          message:
            'options.sessionToken of provider "acme" is not a {env:NAME} reference; tevu copies ' +
            'no credential value into a case: reference such a variable there',
        },
      ]);
      expect(JSON.stringify(result.error.findings)).not.toContain(sentinel);
    });

    it('draws P-APIKEY when options.apiKey references a name absent from secrets', async () => {
      await writeOpencodeJson({ provider: { acme: { options: { apiKey: '{env:GHOST_KEY}' } } } });
      const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.findings).toEqual([
        {
          severity: 'error',
          identifier: 'agents.opencode.providers.acme',
          message:
            'options.apiKey of provider "acme" references GHOST_KEY, which is not listed in ' +
            'agents.opencode.secrets',
        },
      ]);
    });

    it('draws P-HEADER when a non-credential header holds no {env:NAME} reference', async () => {
      const sentinel = 'literal-header-value-should-not-appear';
      await writeOpencodeJson({
        provider: { acme: { options: { headers: { 'X-Custom': sentinel } } } },
      });
      const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.findings).toEqual([
        {
          severity: 'error',
          identifier: 'agents.opencode.providers.acme',
          message:
            'options.headers.X-Custom of provider "acme" holds no {env:NAME} reference; tevu ' +
            'copies no literal header value into a case: reference a variable listed in ' +
            'agents.opencode.secrets or agents.opencode.env',
        },
      ]);
      expect(JSON.stringify(result.error.findings)).not.toContain(sentinel);
    });

    it('draws P-FILE when a value outside a credential path holds a {file:} reference', async () => {
      await writeOpencodeJson({
        provider: { acme: { baseURL: '{file:/etc/some-secret-file}' } },
      });
      const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.findings).toEqual([
        {
          severity: 'error',
          identifier: 'agents.opencode.providers.acme',
          message:
            'baseURL of provider "acme" holds a {file:...} reference; tevu copies no host file into a case',
        },
      ]);
    });

    it('draws P-ENV when a generic string references a name declared in neither secrets nor env', async () => {
      await writeOpencodeJson({
        provider: { acme: { baseURL: 'https://acme.example.test/{env:GHOST_NAME}' } },
      });
      const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.findings).toEqual([
        {
          severity: 'error',
          identifier: 'agents.opencode.providers.acme',
          message:
            'baseURL of provider "acme" references GHOST_NAME, which is listed in neither ' +
            'agents.opencode.secrets nor agents.opencode.env, so a case would receive an empty value',
        },
      ]);
    });
  });

  describe('credential and reference rules (V12)', () => {
    it('draws P-APIKEY for a literal at a credential-shaped key, P-SECRET for a credential header referencing an ordinary variable, nothing for an ordinary header referencing the same variable, and P-SECRET for that name in the root env array', async () => {
      await writeOpencodeJson({
        provider: {
          acme: {
            options: {
              sessionToken: 'literal-session-token-value',
              headers: {
                'X-Api-Key': 'Bearer {env:SHARED_NAME}',
                'X-Title': 'App {env:SHARED_NAME}',
              },
            },
            env: ['SHARED_NAME'],
          },
        },
      });
      const settings = buildSettings({
        providers: buildProviders({ id: 'acme' }),
        declaredVariables: { secrets: [], env: ['SHARED_NAME'] },
      });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.findings).toEqual([
        {
          severity: 'error',
          identifier: 'agents.opencode.providers.acme',
          message:
            'options.sessionToken of provider "acme" is not a {env:NAME} reference; tevu copies ' +
            'no credential value into a case: reference such a variable there',
        },
        {
          severity: 'error',
          identifier: 'agents.opencode.providers.acme',
          message:
            'options.headers.X-Api-Key of provider "acme" references SHARED_NAME, which is not ' +
            'listed in agents.opencode.secrets; a credential header takes only a secret variable',
        },
        {
          severity: 'error',
          identifier: 'agents.opencode.providers.acme',
          message:
            'env entry SHARED_NAME of provider "acme" is listed in agents.opencode.env, and ' +
            "OpenCode reads the provider's key from it: list it in agents.opencode.secrets instead",
        },
      ]);
      expect(result.error.findings.some((finding) => finding.message.includes('X-Title'))).toBe(
        false,
      );
    });
  });

  describe('P-NOKEY (V13)', () => {
    it('draws exactly one P-NOKEY warning, and still writes the file, when the definition names no secret', async () => {
      await writeOpencodeJson({ provider: { acme: { baseURL: 'https://acme.example.test' } } });
      const settings = buildSettings({ providers: buildProviders({ id: 'acme' }) });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.configurationFiles).toHaveLength(1);
      expect(result.value.findings).toEqual([
        {
          severity: 'warning',
          identifier: 'agents.opencode.providers.acme',
          message:
            'provider "acme" names no variable listed in agents.opencode.secrets, so a case ' +
            'receives it without a credential; if its key is in the OpenCode login store, set api_key',
        },
      ]);
    });

    it('draws no P-NOKEY warning when api_key is set', async () => {
      await writeOpencodeJson({ provider: { acme: { baseURL: 'https://acme.example.test' } } });
      const settings = buildSettings({
        providers: buildProviders({ id: 'acme', api_key: 'ACME_KEY' }),
        declaredVariables: { secrets: ['ACME_KEY'], env: [] },
      });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.findings).toEqual([]);
    });

    it('draws no P-NOKEY warning when a root env array names a secrets variable', async () => {
      await writeOpencodeJson({
        provider: { acme: { baseURL: 'https://acme.example.test', env: ['ACME_KEY'] } },
      });
      const settings = buildSettings({
        providers: buildProviders({ id: 'acme' }),
        declaredVariables: { secrets: ['ACME_KEY'], env: [] },
      });

      const result = await readOpenCodeProviders(settings, operatorDirectories());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.findings).toEqual([]);
    });
  });
});

describe('inspectOpenCodeProvider', () => {
  const { operatorRoot, operatorDirectories, writeConfigFile, writeOpencodeJson } =
    useOperatorConfigDirectory();

  it('reports the provider as undefined when no file defines it', async () => {
    await writeOpencodeJson({ provider: { other: { baseURL: 'https://other.example.test' } } });

    const result = await inspectOpenCodeProvider('opencode', 'acme', operatorDirectories());

    expect(result).toEqual({ ok: true, value: { defined: false } });
  });

  it('reports the provider as undefined when the configuration directory holds no file', async () => {
    const result = await inspectOpenCodeProvider('opencode', 'acme', operatorDirectories());

    expect(result).toEqual({ ok: true, value: { defined: false } });
  });

  it('reads a whole reference at options.apiKey as a key variable', async () => {
    await writeOpencodeJson({ provider: { acme: { options: { apiKey: '{env:ACME_KEY}' } } } });

    const result = await inspectOpenCodeProvider('opencode', 'acme', operatorDirectories());

    expect(result).toEqual({
      ok: true,
      value: { defined: true, keyVariables: ['ACME_KEY'], otherVariables: [], apiKey: 'reference' },
    });
  });

  it('reads a baseURL reference as another variable and options.apiKey as absent', async () => {
    await writeOpencodeJson({
      provider: { acme: { options: { baseURL: '{env:ACME_BASE}/v1' } } },
    });

    const result = await inspectOpenCodeProvider('opencode', 'acme', operatorDirectories());

    expect(result).toEqual({
      ok: true,
      value: { defined: true, keyVariables: [], otherVariables: ['ACME_BASE'], apiKey: 'absent' },
    });
  });

  it('sorts a credential header, a credential-named option, and the root env list as key variables and an ordinary header as another variable', async () => {
    await writeOpencodeJson({
      provider: {
        acme: {
          env: ['ACME_ROOT_KEY'],
          options: {
            clientSecret: '{env:ACME_SECRET}',
            headers: {
              Authorization: 'Bearer {env:ACME_TOKEN}',
              'X-Team': '{env:ACME_TEAM}',
            },
          },
        },
      },
    });

    const result = await inspectOpenCodeProvider('opencode', 'acme', operatorDirectories());

    expect(result).toEqual({
      ok: true,
      value: {
        defined: true,
        keyVariables: ['ACME_SECRET', 'ACME_TOKEN', 'ACME_ROOT_KEY'],
        otherVariables: ['ACME_TEAM'],
        apiKey: 'absent',
      },
    });
  });

  it('treats an apiKey that mixes a reference with other text as a value and its variable as another variable', async () => {
    await writeOpencodeJson({
      provider: { acme: { options: { apiKey: 'prefix-{env:ACME_KEY}' } } },
    });

    const result = await inspectOpenCodeProvider('opencode', 'acme', operatorDirectories());

    expect(result).toEqual({
      ok: true,
      value: { defined: true, keyVariables: [], otherVariables: ['ACME_KEY'], apiKey: 'value' },
    });
  });

  it('returns a literal apiKey as a value state and leaks the literal into neither the result nor a finding', async () => {
    await writeOpencodeJson({ provider: { acme: { options: { apiKey: 'sk-test-literal' } } } });

    const result = await inspectOpenCodeProvider('opencode', 'acme', operatorDirectories());

    expect(result).toEqual({
      ok: true,
      value: { defined: true, keyVariables: [], otherVariables: [], apiKey: 'value' },
    });
    expect(JSON.stringify(result)).not.toContain('sk-test-literal');
  });

  it('leaks no host value into the finding for a definition that is not an object', async () => {
    await writeOpencodeJson({ provider: { acme: 'sk-test-literal' } });

    const result = await inspectOpenCodeProvider('opencode', 'acme', operatorDirectories());

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'ConfigValidationError',
        findings: [
          {
            severity: 'error',
            identifier: 'agents.opencode.providers.acme',
            message: 'the definition of provider "acme" is not an object',
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('sk-test-literal');
  });

  it('lets a later file win when merging the definition across the three files', async () => {
    await writeConfigFile(
      'config.json',
      JSON.stringify({
        provider: { acme: { options: { apiKey: '{env:FIRST_KEY}', baseURL: '{env:FIRST_BASE}' } } },
      }),
    );
    await writeConfigFile(
      'opencode.json',
      JSON.stringify({ provider: { acme: { options: { apiKey: '{env:SECOND_KEY}' } } } }),
    );
    await writeConfigFile(
      'opencode.jsonc',
      '{ "provider": { "acme": { "options": { "apiKey": "{env:THIRD_KEY}" } } } } // trailing',
    );

    const result = await inspectOpenCodeProvider('opencode', 'acme', operatorDirectories());

    expect(result).toEqual({
      ok: true,
      value: {
        defined: true,
        keyVariables: ['THIRD_KEY'],
        otherVariables: ['FIRST_BASE'],
        apiKey: 'reference',
      },
    });
  });

  it('lists variables in first-seen order without repeats and keeps a name out of both lists', async () => {
    await writeOpencodeJson({
      provider: {
        acme: {
          options: {
            baseURL: '{env:B}/{env:A}/{env:B}',
            apiKey: '{env:A}',
            headers: { 'X-One': '{env:C}', 'X-Two': '{env:C}{env:B}' },
          },
          env: ['A', 'D'],
        },
      },
    });

    const result = await inspectOpenCodeProvider('opencode', 'acme', operatorDirectories());

    expect(result).toEqual({
      ok: true,
      value: {
        defined: true,
        keyVariables: ['A', 'D'],
        otherVariables: ['B', 'C'],
        apiKey: 'reference',
      },
    });
  });

  describe('findings shared with readOpenCodeProviders', () => {
    it.each([
      { name: 'both bases unset', directories: { home: undefined, xdgConfigHome: undefined } },
      { name: 'an empty base', directories: { home: '', xdgConfigHome: '' } },
      {
        name: 'relative bases',
        directories: { home: 'relative/home', xdgConfigHome: 'relative/xdg' },
      },
    ])('reports the same finding as the copy read for $name', async ({ directories }) => {
      const copied = await readOpenCodeProviders(
        buildSettings({ providers: buildProviders({ id: 'acme' }) }),
        directories,
      );

      const inspected = await inspectOpenCodeProvider('opencode', 'acme', directories);

      expect(copied.ok).toBe(false);
      expect(inspected).toEqual(copied);
    });

    it('reports the same finding as the copy read for an invalid file', async () => {
      await writeConfigFile('opencode.json', '{ "provider": ');
      const copied = await readOpenCodeProviders(
        buildSettings({ providers: buildProviders({ id: 'acme' }) }),
        operatorDirectories(),
      );

      const inspected = await inspectOpenCodeProvider('opencode', 'acme', operatorDirectories());

      expect(copied.ok).toBe(false);
      expect(inspected).toEqual(copied);
    });

    it('reports the same finding as the copy read for an unreadable file', async () => {
      await mkdir(join(operatorRoot(), 'opencode', 'config.json'), { recursive: true });
      const copied = await readOpenCodeProviders(
        buildSettings({ providers: buildProviders({ id: 'acme' }) }),
        operatorDirectories(),
      );

      const inspected = await inspectOpenCodeProvider('opencode', 'acme', operatorDirectories());

      expect(copied.ok).toBe(false);
      expect(inspected).toEqual(copied);
    });
  });
});
