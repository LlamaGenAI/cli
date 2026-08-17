import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { CliError } from './errors.js';

export const DEFAULT_SITE_URL = 'https://llamagen.ai';
export const DEFAULT_API_URL = 'https://api.llamagen.ai';

export function configHome(env = process.env) {
  return env.LLAMAGEN_CONFIG_HOME || path.join(os.homedir(), '.llamagen');
}

export function configPath(env = process.env) {
  return path.join(configHome(env), 'config.json');
}

export function credentialsPath(env = process.env) {
  return path.join(configHome(env), 'credentials.json');
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new CliError(`${label} is not valid JSON: ${file}`, 1);
    }
    throw error;
  }
}

function atomicWriteJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function readConfig(env = process.env) {
  return readJson(configPath(env), 'LlamaGen config') || {};
}

export function writeConfig(config, env = process.env) {
  atomicWriteJson(configPath(env), config);
}

export function readCredential(env = process.env, { migrateLegacy = true } = {}) {
  const credential = readJson(credentialsPath(env), 'LlamaGen credentials');
  if (credential?.apiToken) return credential;
  if (!migrateLegacy) return null;

  const config = readConfig(env);
  if (!config.apiKey) return null;
  const migrated = {
    apiToken: config.apiKey,
    email: null,
    userId: null,
    apiBaseUrl: config.apiUrl || config.baseUrl || DEFAULT_API_URL,
    siteUrl: config.siteUrl || DEFAULT_SITE_URL,
    authenticatedAt: new Date().toISOString(),
    migratedFrom: 'config.apiKey',
  };
  writeCredential(migrated, env);
  delete config.apiKey;
  writeConfig(config, env);
  return migrated;
}

export function writeCredential(credential, env = process.env) {
  if (!credential?.apiToken || typeof credential.apiToken !== 'string') {
    throw new CliError('Cannot save an empty LlamaGen API token.', 1);
  }
  atomicWriteJson(credentialsPath(env), credential);
}

export function removeCredential(env = process.env) {
  let removed = false;
  try {
    fs.unlinkSync(credentialsPath(env));
    removed = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const config = readConfig(env);
  if (config.apiKey) {
    delete config.apiKey;
    writeConfig(config, env);
    removed = true;
  }
  return removed;
}

function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === 'localhost';
}

export function normalizeServiceUrl(value, label) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
      throw new CliError(`${label} must use HTTPS unless it is a loopback address.`, 2);
    }
    if (url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Invalid ${label}: ${value}`, 2);
  }
}

export function resolveSiteUrl(globals, env, config = readConfig(env)) {
  return normalizeServiceUrl(
    globals.siteUrl || env.LLAMAGEN_SITE_URL || config.siteUrl || DEFAULT_SITE_URL,
    'site URL',
  );
}

export function resolveApiUrl(globals, env, config = readConfig(env), fallback) {
  return normalizeServiceUrl(
    globals.apiUrl ||
      globals.baseUrl ||
      env.LLAMAGEN_API_URL ||
      env.LLAMAGEN_BASE_URL ||
      config.apiUrl ||
      config.baseUrl ||
      fallback ||
      DEFAULT_API_URL,
    'API URL',
  );
}

export function resolveCredential(globals, env) {
  if (globals.apiKey) {
    return { apiToken: globals.apiKey, source: 'flag', credential: null };
  }
  if (env.LLAMAGEN_API_KEY) {
    return { apiToken: env.LLAMAGEN_API_KEY, source: 'environment', credential: null };
  }
  const credential = readCredential(env);
  if (credential?.apiToken) {
    return { apiToken: credential.apiToken, source: 'credentials-file', credential };
  }
  return { apiToken: null, source: 'none', credential: null };
}

export function tokenHint(token) {
  if (!token) return null;
  const suffix = token.slice(-4);
  const prefix = token.startsWith('sk-') ? 'sk-' : '';
  return `${prefix}••••••••${suffix}`;
}
