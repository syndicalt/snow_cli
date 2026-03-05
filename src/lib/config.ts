import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Config, Instance, AIConfig, LLMProviderName, LLMProviderConfig } from '../types/index.js';

const CONFIG_DIR = join(homedir(), '.snow');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadConfig(): Config {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    return { instances: {} };
  }
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as Config;
  } catch {
    return { instances: {} };
  }
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getActiveInstance(): Instance | null {
  const config = loadConfig();
  if (!config.activeInstance) return null;
  return config.instances[config.activeInstance] ?? null;
}

export function requireActiveInstance(): Instance {
  const instance = getActiveInstance();
  if (!instance) {
    console.error(
      'No active instance configured. Run `snow instance add` to add one.'
    );
    process.exit(1);
  }
  return instance;
}

export function addInstance(instance: Instance): void {
  const config = loadConfig();
  config.instances[instance.alias] = instance;
  if (!config.activeInstance) {
    config.activeInstance = instance.alias;
  }
  saveConfig(config);
}

export function removeInstance(alias: string): boolean {
  const config = loadConfig();
  if (!config.instances[alias]) return false;
  delete config.instances[alias];
  if (config.activeInstance === alias) {
    const remaining = Object.keys(config.instances);
    config.activeInstance = remaining[0];
  }
  saveConfig(config);
  return true;
}

export function setActiveInstance(alias: string): boolean {
  const config = loadConfig();
  if (!config.instances[alias]) return false;
  config.activeInstance = alias;
  saveConfig(config);
  return true;
}

export function listInstances(): { instance: Instance; active: boolean }[] {
  const config = loadConfig();
  return Object.values(config.instances).map((instance) => ({
    instance,
    active: config.activeInstance === instance.alias,
  }));
}

// AI / LLM provider config helpers
export function getAIConfig(): AIConfig {
  const config = loadConfig();
  return config.ai ?? { providers: {} };
}

export function setProviderConfig(
  name: LLMProviderName,
  providerConfig: LLMProviderConfig
): void {
  const config = loadConfig();
  config.ai ??= { providers: {} };
  config.ai.providers[name] = providerConfig;
  if (!config.ai.activeProvider) config.ai.activeProvider = name;
  saveConfig(config);
}

export function removeProviderConfig(name: LLMProviderName): boolean {
  const config = loadConfig();
  if (!config.ai?.providers[name]) return false;
  delete config.ai.providers[name];
  if (config.ai.activeProvider === name) {
    const remaining = Object.keys(config.ai.providers) as LLMProviderName[];
    config.ai.activeProvider = remaining[0];
  }
  saveConfig(config);
  return true;
}

export function setActiveProvider(name: LLMProviderName): boolean {
  const config = loadConfig();
  if (!config.ai?.providers[name]) return false;
  config.ai.activeProvider = name;
  saveConfig(config);
  return true;
}

export function getActiveProvider(): { name: LLMProviderName; config: LLMProviderConfig } | null {
  const ai = getAIConfig();
  if (!ai.activeProvider) return null;
  const providerConfig = ai.providers[ai.activeProvider];
  if (!providerConfig) return null;
  return { name: ai.activeProvider, config: providerConfig };
}
