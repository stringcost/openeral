import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OpenVikingConfig } from './types.js';

const DEFAULT_CONFIG: OpenVikingConfig = {
  enabled: false,
  endpoint: 'http://localhost:1933',
  timeoutMs: 15000,
  agentId: process.env.OPENERAL_AGENT === 'openclaw' ? 'openeral-openclaw' : 'openeral-claude',
  autoRecall: {
    enabled: true,
    limit: 6,
    scoreThreshold: 0.15,
    tokenBudget: 2000,
  },
  autoCapture: {
    enabled: true,
    mode: 'semantic',
    intervalMinutes: 10,
    timeoutMs: 30000,
  },
};

export function getConfigPath(homeDir?: string): string {
  return join(homeDir ?? homedir(), '.openeral', 'openviking.json');
}

export function loadOpenVikingConfig(homeDir?: string): OpenVikingConfig {
  const configPath = getConfigPath(homeDir);
  if (!existsSync(configPath)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<OpenVikingConfig>;
    return mergeConfig(DEFAULT_CONFIG, raw);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveOpenVikingConfig(config: Partial<OpenVikingConfig>, homeDir?: string): void {
  const configPath = getConfigPath(homeDir);
  mkdirSync(join(homeDir ?? homedir(), '.openeral'), { recursive: true });
  const existing = loadOpenVikingConfig(homeDir);
  writeFileSync(configPath, JSON.stringify(mergeConfig(existing, config), null, 2));
}

function mergeConfig(defaults: OpenVikingConfig, overrides: Partial<OpenVikingConfig>): OpenVikingConfig {
  return {
    ...defaults,
    ...overrides,
    autoRecall: { ...defaults.autoRecall, ...(overrides.autoRecall ?? {}) },
    autoCapture: { ...defaults.autoCapture, ...(overrides.autoCapture ?? {}) },
  };
}
