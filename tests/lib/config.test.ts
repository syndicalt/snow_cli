import { vi, describe, it, expect, beforeEach } from 'vitest';

// ─── Hoist shared state so it's available in the mock factories ───────────────
const mockFiles = vi.hoisted(() => new Map<string, string>());

vi.mock('os', () => ({
  homedir: vi.fn(() => '/fake-home'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn((p: unknown) => mockFiles.has(String(p))),
  readFileSync: vi.fn((p: unknown) => {
    const content = mockFiles.get(String(p));
    if (content === undefined) {
      const err = Object.assign(new Error(`ENOENT: ${String(p)}`), { code: 'ENOENT' });
      throw err;
    }
    return content;
  }),
  writeFileSync: vi.fn((p: unknown, data: unknown) => {
    mockFiles.set(String(p), String(data));
  }),
  mkdirSync: vi.fn(),
}));

import { join } from 'path';
import {
  loadConfig,
  saveConfig,
  addInstance,
  removeInstance,
  setActiveInstance,
  listInstances,
  getAIConfig,
  setProviderConfig,
  removeProviderConfig,
  setActiveProvider,
  getActiveProvider,
} from '../../src/lib/config.js';
import type { Instance } from '../../src/types/index.js';

// Must match what config.ts computes: join(homedir(), '.snow', 'config.json')
const CONFIG_FILE = join('/fake-home', '.snow', 'config.json');

const basicInstance: Instance = {
  alias: 'dev',
  url: 'https://dev.service-now.com',
  auth: { type: 'basic', username: 'admin', password: 'pass' },
};

const prodInstance: Instance = {
  alias: 'prod',
  url: 'https://prod.service-now.com',
  auth: { type: 'basic', username: 'admin', password: 'prod-pass' },
};

beforeEach(() => {
  mockFiles.clear();
});

// ─── loadConfig ───────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('returns empty config when config file does not exist', () => {
    const config = loadConfig();
    expect(config).toEqual({ instances: {} });
  });

  it('parses and returns config when file exists', () => {
    const stored = { activeInstance: 'dev', instances: { dev: basicInstance } };
    mockFiles.set(CONFIG_FILE, JSON.stringify(stored));
    const config = loadConfig();
    expect(config.activeInstance).toBe('dev');
    expect(config.instances['dev']).toEqual(basicInstance);
  });

  it('returns empty config when file contains invalid JSON', () => {
    mockFiles.set(CONFIG_FILE, 'not-json{{{{');
    const config = loadConfig();
    expect(config).toEqual({ instances: {} });
  });
});

// ─── saveConfig ──────────────────────────────────────────────────────────────

describe('saveConfig', () => {
  it('serializes config to the config file path', () => {
    const config = { instances: { dev: basicInstance }, activeInstance: 'dev' };
    saveConfig(config);
    const written = mockFiles.get(CONFIG_FILE);
    expect(written).toBeDefined();
    expect(JSON.parse(written!)).toEqual(config);
  });
});

// ─── addInstance ─────────────────────────────────────────────────────────────

describe('addInstance', () => {
  it('adds a new instance and makes it active when no active exists', () => {
    addInstance(basicInstance);
    const config = loadConfig();
    expect(config.instances['dev']).toEqual(basicInstance);
    expect(config.activeInstance).toBe('dev');
  });

  it('keeps existing active instance when adding a second instance', () => {
    addInstance(basicInstance);
    addInstance(prodInstance);
    const config = loadConfig();
    expect(config.activeInstance).toBe('dev');
    expect(config.instances['prod']).toEqual(prodInstance);
  });
});

// ─── removeInstance ──────────────────────────────────────────────────────────

describe('removeInstance', () => {
  it('returns false for an unknown alias', () => {
    addInstance(basicInstance);
    expect(removeInstance('unknown')).toBe(false);
  });

  it('removes the instance and updates activeInstance', () => {
    addInstance(basicInstance);
    addInstance(prodInstance);
    const removed = removeInstance('dev');
    expect(removed).toBe(true);
    const config = loadConfig();
    expect(config.instances['dev']).toBeUndefined();
    // activeInstance switches to the remaining one
    expect(config.activeInstance).toBe('prod');
  });
});

// ─── setActiveInstance ───────────────────────────────────────────────────────

describe('setActiveInstance', () => {
  it('returns false when alias does not exist', () => {
    expect(setActiveInstance('nonexistent')).toBe(false);
  });

  it('updates activeInstance and returns true', () => {
    addInstance(basicInstance);
    addInstance(prodInstance);
    const result = setActiveInstance('prod');
    expect(result).toBe(true);
    const config = loadConfig();
    expect(config.activeInstance).toBe('prod');
  });
});

// ─── listInstances ───────────────────────────────────────────────────────────

describe('listInstances', () => {
  it('returns an empty array when no instances exist', () => {
    expect(listInstances()).toEqual([]);
  });

  it('marks the active instance correctly', () => {
    addInstance(basicInstance);
    addInstance(prodInstance);
    setActiveInstance('prod');
    const list = listInstances();
    const devEntry = list.find((e) => e.instance.alias === 'dev')!;
    const prodEntry = list.find((e) => e.instance.alias === 'prod')!;
    expect(devEntry.active).toBe(false);
    expect(prodEntry.active).toBe(true);
  });
});

// ─── getAIConfig ─────────────────────────────────────────────────────────────

describe('getAIConfig', () => {
  it('returns empty providers when no AI config exists', () => {
    const ai = getAIConfig();
    expect(ai).toEqual({ providers: {} });
  });

  it('returns stored AI config', () => {
    const stored = {
      instances: {},
      ai: { activeProvider: 'openai', providers: { openai: { model: 'gpt-4o', apiKey: 'sk-x' } } },
    };
    mockFiles.set(CONFIG_FILE, JSON.stringify(stored));
    const ai = getAIConfig();
    expect(ai.activeProvider).toBe('openai');
  });
});

// ─── setProviderConfig ───────────────────────────────────────────────────────

describe('setProviderConfig', () => {
  it('saves provider and auto-sets it as active when none exists', () => {
    setProviderConfig('openai', { model: 'gpt-4o', apiKey: 'sk-key' });
    const ai = getAIConfig();
    expect(ai.providers['openai']).toEqual({ model: 'gpt-4o', apiKey: 'sk-key' });
    expect(ai.activeProvider).toBe('openai');
  });

  it('does not override existing activeProvider when adding a second provider', () => {
    setProviderConfig('openai', { model: 'gpt-4o', apiKey: 'sk-1' });
    setProviderConfig('anthropic', { model: 'claude-sonnet-4-6', apiKey: 'sk-ant' });
    const ai = getAIConfig();
    expect(ai.activeProvider).toBe('openai');
    expect(ai.providers['anthropic']).toBeDefined();
  });
});

// ─── removeProviderConfig ────────────────────────────────────────────────────

describe('removeProviderConfig', () => {
  it('returns false when provider does not exist', () => {
    expect(removeProviderConfig('openai')).toBe(false);
  });

  it('removes provider and updates activeProvider to remaining', () => {
    setProviderConfig('openai', { model: 'gpt-4o', apiKey: 'sk-1' });
    setProviderConfig('anthropic', { model: 'claude-sonnet-4-6', apiKey: 'sk-ant' });
    setActiveProvider('openai');
    const result = removeProviderConfig('openai');
    expect(result).toBe(true);
    const ai = getAIConfig();
    expect(ai.providers['openai']).toBeUndefined();
    expect(ai.activeProvider).toBe('anthropic');
  });
});

// ─── setActiveProvider ───────────────────────────────────────────────────────

describe('setActiveProvider', () => {
  it('returns false when provider is not configured', () => {
    expect(setActiveProvider('anthropic')).toBe(false);
  });

  it('sets the active provider and returns true', () => {
    setProviderConfig('openai', { model: 'gpt-4o', apiKey: 'sk-1' });
    setProviderConfig('anthropic', { model: 'claude-opus-4-6', apiKey: 'sk-ant' });
    expect(setActiveProvider('anthropic')).toBe(true);
    const ai = getAIConfig();
    expect(ai.activeProvider).toBe('anthropic');
  });
});

// ─── getActiveProvider ───────────────────────────────────────────────────────

describe('getActiveProvider', () => {
  it('returns null when no providers are configured', () => {
    expect(getActiveProvider()).toBeNull();
  });

  it('returns the active provider name and config', () => {
    setProviderConfig('openai', { model: 'gpt-4o', apiKey: 'sk-key' });
    const active = getActiveProvider();
    expect(active).not.toBeNull();
    expect(active!.name).toBe('openai');
    expect(active!.config.model).toBe('gpt-4o');
  });
});
