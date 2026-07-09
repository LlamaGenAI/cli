#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = '0.1.0';
const DEFAULT_BASE_URL = 'https://api.llamagen.ai';

export async function main(argv = process.argv.slice(2), env = process.env, io = process) {
  try {
    const { args, globals } = parseGlobals(argv);
    const command = args.shift();
    if (!command || command === 'help' || command === '--help' || command === '-h') { io.stdout.write(helpText()); return 0; }
    if (command === 'version' || command === '--version' || command === '-v') { io.stdout.write(`llamagen ${VERSION}\n`); return 0; }
    if (command === 'config') return runConfig(args, env, io);
    if (command === 'comic') return runComic(args, globals, env, io);
    if (command === 'animation') return runAnimation(args, globals, env, io);
    throw new CliError(`Unknown command: ${command}`, 2);
  } catch (error) {
    const code = error instanceof CliError ? error.code : 1;
    io.stderr.write(`${error.message}\n`);
    return code;
  }
}

async function runComic(args, globals, env, io) {
  const subcommand = args.shift();
  if (!subcommand || subcommand === 'help') { io.stdout.write(comicHelpText()); return 0; }
  if (subcommand === 'create') {
    const options = parseOptions(args);
    requireOption(options, 'prompt');
    const body = compact({ prompt: options.prompt, promptUrl: options.promptUrl, size: options.size, preset: options.preset, style: options.style, language: options.language, fixPanelNum: numberOption(options.fixPanelNum) });
    const job = await requestJson('POST', '/v1/comics/generations', body, globals, env);
    if (options.wait) writeJson(io, await waitForComic(job.id, globals, env));
    else writeJson(io, job);
    return 0;
  }
  if (subcommand === 'get') {
    const id = args.shift();
    if (!id) throw new CliError('Usage: llamagen comic get <generation_id>', 2);
    writeJson(io, await requestJson('GET', `/v1/comics/generations/${encodeURIComponent(id)}`, undefined, globals, env));
    return 0;
  }
  if (subcommand === 'continue') {
    const id = args.shift();
    if (!id) throw new CliError('Usage: llamagen comic continue <generation_id> --prompt <prompt>', 2);
    const options = parseOptions(args);
    requireOption(options, 'prompt');
    writeJson(io, await requestJson('PATCH', `/v1/comics/generations/${encodeURIComponent(id)}`, { prompt: options.prompt, action: 'continueWrite' }, globals, env));
    return 0;
  }
  if (subcommand === 'update-panel') {
    const id = args.shift();
    if (!id) throw new CliError('Usage: llamagen comic update-panel <generation_id> --page <n> --panel <n> --prompt <prompt>', 2);
    const options = parseOptions(args);
    const body = compact({ page: numberOption(options.page), panel: numberOption(options.panel), prompt: options.prompt, panelPrompt: options.panelPrompt, action: 'regeneratePanel' });
    writeJson(io, await requestJson('PATCH', `/v1/comics/generations/${encodeURIComponent(id)}`, body, globals, env));
    return 0;
  }
  if (subcommand === 'usage') { writeJson(io, await requestJson('GET', '/v1/comics/usage', undefined, globals, env)); return 0; }
  throw new CliError(`Unknown comic command: ${subcommand}`, 2);
}

async function runAnimation(args, globals, env, io) {
  const subcommand = args.shift();
  if (!subcommand || subcommand === 'help') { io.stdout.write(animationHelpText()); return 0; }
  if (subcommand === 'create') {
    const options = parseOptions(args);
    requireOption(options, 'prompt');
    writeJson(io, await requestJson('POST', '/v1/artworks/generations', { prompt: options.prompt }, globals, env));
    return 0;
  }
  if (subcommand === 'get') {
    const id = args.shift();
    if (!id) throw new CliError('Usage: llamagen animation get <generation_id>', 2);
    writeJson(io, await requestJson('GET', `/v1/artworks/generations/${encodeURIComponent(id)}`, undefined, globals, env));
    return 0;
  }
  throw new CliError(`Unknown animation command: ${subcommand}`, 2);
}

function runConfig(args, env, io) {
  const subcommand = args.shift();
  if (!subcommand || subcommand === 'help') { io.stdout.write(configHelpText()); return 0; }
  const config = readConfig(env);
  if (subcommand === 'set') {
    const key = args.shift();
    const value = args.shift();
    if (key !== 'api-key' || !value) throw new CliError('Usage: llamagen config set api-key <key>', 2);
    writeConfig({ ...config, apiKey: value }, env);
    io.stdout.write('Saved api-key\n');
    return 0;
  }
  if (subcommand === 'get') {
    const key = args.shift();
    if (key !== 'api-key') throw new CliError('Usage: llamagen config get api-key', 2);
    io.stdout.write(`${config.apiKey ? 'api-key is set' : 'api-key is not set'}\n`);
    return 0;
  }
  if (subcommand === 'unset') {
    const key = args.shift();
    if (key !== 'api-key') throw new CliError('Usage: llamagen config unset api-key', 2);
    delete config.apiKey;
    writeConfig(config, env);
    io.stdout.write('Removed api-key\n');
    return 0;
  }
  throw new CliError(`Unknown config command: ${subcommand}`, 2);
}

async function waitForComic(id, globals, env) {
  const timeoutMs = Number(globals.timeoutMs ?? 300000);
  const intervalMs = Number(globals.pollIntervalMs ?? 2000);
  const start = Date.now();
  while (true) {
    const job = await requestJson('GET', `/v1/comics/generations/${encodeURIComponent(id)}`, undefined, globals, env);
    if (['completed', 'succeeded', 'failed', 'canceled', 'COMPLETED', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(String(job.status))) return job;
    if (Date.now() - start >= timeoutMs) throw new CliError(`Timed out waiting for comic generation ${id}`, 1);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function requestJson(method, apiPath, body, globals, env) {
  const baseUrl = String(globals.baseUrl ?? env.LLAMAGEN_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const apiKey = globals.apiKey ?? env.LLAMAGEN_API_KEY ?? readConfig(env).apiKey;
  if (!apiKey) throw new CliError('Missing API key. Set LLAMAGEN_API_KEY or run `llamagen config set api-key <key>`.', 2);
  const url = new URL(`${baseUrl}${apiPath}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const response = await fetchWithTimeout(url, { method, headers: compact({ accept: 'application/json', authorization: `Bearer ${apiKey}`, 'content-type': payload ? 'application/json' : undefined, 'user-agent': `llamagen-cli/${VERSION}` }), body: payload }, Number(globals.timeoutMs ?? 120000));
  const text = await response.text();
  const parsed = text ? parseJson(text) : {};
  if (!response.ok) throw new CliError(`LlamaGen API request failed with status ${response.status}: ${JSON.stringify(parsed)}`, 1);
  return parsed;
}

function fetchWithTimeout(url, options, timeoutMs) {
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, text: async () => Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    if (options.body) request.write(options.body);
    request.end();
  });
}

function parseGlobals(argv) {
  const args = [];
  const globals = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--api-key') globals.apiKey = argv[++index];
    else if (arg === '--base-url') globals.baseUrl = argv[++index];
    else if (arg === '--timeout-ms') globals.timeoutMs = argv[++index];
    else if (arg === '--poll-interval-ms') globals.pollIntervalMs = argv[++index];
    else args.push(arg);
  }
  return { args, globals };
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new CliError(`Unexpected argument: ${arg}`, 2);
    const key = camelCase(arg.slice(2));
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return options;
}

function requireOption(options, key) { if (!options[key] || options[key] === true) throw new CliError(`Missing required option --${kebabCase(key)}`, 2); }
function numberOption(value) { if (value === undefined || value === true) return undefined; const parsed = Number(value); if (!Number.isFinite(parsed)) throw new CliError(`Expected numeric value, got ${value}`, 2); return parsed; }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== false)); }
function parseJson(text) { try { return JSON.parse(text); } catch { return { raw: text }; } }
function writeJson(io, value) { io.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function camelCase(value) { return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase()); }
function kebabCase(value) { return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`); }
function configPath(env) { const home = env.LLAMAGEN_CONFIG_HOME || path.join(os.homedir(), '.llamagen'); return path.join(home, 'config.json'); }
function readConfig(env) { try { return JSON.parse(fs.readFileSync(configPath(env), 'utf8')); } catch { return {}; } }
function writeConfig(config, env) { const file = configPath(env); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); }

function helpText() { return `LlamaGen CLI ${VERSION}\n\nUsage:\n  llamagen [global flags] <command> [args]\n\nCommands:\n  comic       Work with the Comic API\n  animation   Work with the Animation API\n  config      Manage local CLI config\n  version     Print version\n\nGlobal flags:\n  --api-key <key>          Override LLAMAGEN_API_KEY\n  --base-url <url>         Override API base URL\n  --timeout-ms <ms>        Request timeout\n  --poll-interval-ms <ms>  Wait polling interval\n`; }
function comicHelpText() { return `Usage:\n  llamagen comic create --prompt <prompt> [--prompt-url <url>] [--size 1024x1024] [--wait]\n  llamagen comic get <generation_id>\n  llamagen comic continue <generation_id> --prompt <prompt>\n  llamagen comic update-panel <generation_id> --page <n> --panel <n> --prompt <prompt>\n  llamagen comic usage\n`; }
function animationHelpText() { return `Usage:\n  llamagen animation create --prompt <prompt>\n  llamagen animation get <generation_id>\n`; }
function configHelpText() { return `Usage:\n  llamagen config set api-key <key>\n  llamagen config get api-key\n  llamagen config unset api-key\n`; }

class CliError extends Error { constructor(message, code = 1) { super(message); this.code = code; } }

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) { const code = await main(); process.exit(code); }
