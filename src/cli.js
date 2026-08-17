import {
  readConfig,
  readCredential,
  removeCredential,
  resolveApiUrl,
  resolveCredential,
  writeConfig,
  writeCredential,
  normalizeServiceUrl,
} from './config.js';
import { runAuth, requestComicApi } from './auth.js';
import { CliError } from './errors.js';
import { VERSION } from './version.js';

export { VERSION } from './version.js';

const SUPPORTED_COMIC_SIZES = new Set([
  '1024x1024',
  '512x768',
  '512x1024',
  '576x1024',
  '768x1024',
  '1024x768',
  '768x512',
  '1024x576',
  '1024x512',
]);

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  io = process,
  runtime = {},
) {
  try {
    const { args, globals } = parseGlobals(argv);
    const command = args.shift();
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      io.stdout.write(helpText());
      return 0;
    }
    if (command === 'version' || command === '--version' || command === '-v') {
      io.stdout.write(`llamagen ${VERSION}\n`);
      return 0;
    }
    if (command === 'auth') return await runAuth(args, globals, env, io, runtime);
    if (command === 'config') return runConfig(args, env, io);
    if (command === 'comic') return await runComic(args, globals, env, io);
    if (command === 'animation') return await runAnimation(args, globals, env, io);
    throw new CliError(`Unknown command: ${command}`, 2);
  } catch (error) {
    const code = error instanceof CliError ? error.code : 1;
    io.stderr.write(`${error.message}\n`);
    return code;
  }
}

async function runComic(args, globals, env, io) {
  const subcommand = args.shift();
  if (!subcommand || subcommand === 'help') {
    io.stdout.write(comicHelpText());
    return 0;
  }
  if (subcommand === 'create') {
    const options = parseOptions(args);
    assertAllowedOptions(options, [
      'prompt', 'promptUrl', 'size', 'preset', 'style', 'language', 'fixPanelNum', 'wait',
    ], 'comic create');
    requireOption(options, 'prompt');
    const size = options.size || '1024x1024';
    if (!SUPPORTED_COMIC_SIZES.has(size)) {
      throw new CliError(`Unsupported comic size: ${size}`, 2);
    }
    const body = compact({
      prompt: options.prompt,
      promptUrl: options.promptUrl,
      size,
      preset: options.preset || 'neutral',
      style: options.style,
      language: options.language,
      fixPanelNum: integerOption(options.fixPanelNum, '--fix-panel-num', 1, 20),
    });
    const job = await apiRequest('POST', '/v1/comics/generations', body, globals, env);
    if (options.wait) {
      if (typeof job.id !== 'string' || !job.id) {
        throw new CliError('Comic API did not return a generation ID.', 1);
      }
      const completed = await waitForComic(job.id, globals, env);
      writeJson(io, completed);
      if (isFailureStatus(completed.status)) {
        io.stderr.write(`Comic generation ${job.id} ended with status ${completed.status}.\n`);
        return 1;
      }
    } else writeJson(io, job);
    return 0;
  }
  if (subcommand === 'get') {
    const id = args.shift();
    if (!id) throw new CliError('Usage: llamagen comic get <generation_id>', 2);
    const options = parseOptions(args);
    assertAllowedOptions(options, ['page', 'panel'], 'comic get');
    const query = new URLSearchParams();
    const page = integerOption(options.page, '--page', 0);
    const panel = integerOption(options.panel, '--panel', 0);
    if (page !== undefined) query.set('page', String(page));
    if (panel !== undefined) query.set('panel', String(panel));
    const suffix = query.size ? `?${query.toString()}` : '';
    writeJson(io, await apiRequest('GET', `/v1/comics/generations/${encodeURIComponent(id)}${suffix}`, undefined, globals, env));
    return 0;
  }
  if (subcommand === 'continue') {
    const id = args.shift();
    if (!id) throw new CliError('Usage: llamagen comic continue <generation_id> --prompt <prompt>', 2);
    const options = parseOptions(args);
    assertAllowedOptions(options, ['prompt', 'fixPanelNum'], 'comic continue');
    requireOption(options, 'prompt');
    writeJson(io, await apiRequest('PATCH', `/v1/comics/generations/${encodeURIComponent(id)}`, compact({
      prompt: options.prompt,
      fixPanelNum: integerOption(options.fixPanelNum, '--fix-panel-num', 1, 20),
      action: 'continueWrite',
    }), globals, env));
    return 0;
  }
  if (subcommand === 'update-panel') {
    const id = args.shift();
    if (!id) throw new CliError('Usage: llamagen comic update-panel <generation_id> --page <n> --panel <n> --prompt <prompt>', 2);
    const options = parseOptions(args);
    assertAllowedOptions(options, ['page', 'panel', 'prompt', 'panelPrompt'], 'comic update-panel');
    const panel = integerOption(options.panel, '--panel', 0);
    if (panel === undefined) throw new CliError('Missing required option --panel', 2);
    if (!hasNonEmptyString(options.prompt) && !hasNonEmptyString(options.panelPrompt)) {
      throw new CliError('Missing required option --prompt or --panel-prompt', 2);
    }
    const body = compact({
      page: integerOption(options.page, '--page', 0),
      panel,
      prompt: options.prompt,
      panelPrompt: options.panelPrompt,
      action: 'regeneratePanel',
    });
    writeJson(io, await apiRequest('PATCH', `/v1/comics/generations/${encodeURIComponent(id)}`, body, globals, env));
    return 0;
  }
  if (subcommand === 'usage') {
    writeJson(io, await apiRequest('GET', '/v1/comics/usage', undefined, globals, env));
    return 0;
  }
  throw new CliError(`Unknown comic command: ${subcommand}`, 2);
}

async function runAnimation(args, globals, env, io) {
  const subcommand = args.shift();
  if (!subcommand || subcommand === 'help') {
    io.stdout.write(animationHelpText());
    return 0;
  }
  if (subcommand === 'create') {
    const options = parseOptions(args);
    assertAllowedOptions(options, ['prompt'], 'animation create');
    requireOption(options, 'prompt');
    writeJson(io, await apiRequest('POST', '/v1/artworks/generations', { prompt: options.prompt }, globals, env));
    return 0;
  }
  if (subcommand === 'get') {
    const id = args.shift();
    if (!id) throw new CliError('Usage: llamagen animation get <generation_id>', 2);
    writeJson(io, await apiRequest('GET', `/v1/artworks/generations/${encodeURIComponent(id)}`, undefined, globals, env));
    return 0;
  }
  throw new CliError(`Unknown animation command: ${subcommand}`, 2);
}

function runConfig(args, env, io) {
  const subcommand = args.shift();
  if (!subcommand || subcommand === 'help') {
    io.stdout.write(configHelpText());
    return 0;
  }
  const key = args.shift();
  const normalizedKey = key === 'base-url' ? 'api-url' : key;
  if (!['api-key', 'site-url', 'api-url'].includes(normalizedKey)) {
    throw new CliError('Config key must be api-key, site-url, or api-url.', 2);
  }

  const config = readConfig(env);
  if (subcommand === 'set') {
    const value = args.shift();
    if (!value || args.length) throw new CliError(`Usage: llamagen config set ${key} <value>`, 2);
    if (normalizedKey === 'api-key') {
      const existing = readCredential(env, { migrateLegacy: false }) || {};
      writeCredential({
        ...existing,
        apiToken: value,
        apiBaseUrl: existing.apiBaseUrl || config.apiUrl || 'https://api.llamagen.ai',
        siteUrl: existing.siteUrl || config.siteUrl || 'https://llamagen.ai',
        authenticatedAt: new Date().toISOString(),
        source: 'manual',
      }, env);
      io.stdout.write('Saved api-key securely. Prefer `llamagen auth login` for interactive use.\n');
      return 0;
    }
    const property = normalizedKey === 'site-url' ? 'siteUrl' : 'apiUrl';
    config[property] = normalizeServiceUrl(
      value,
      normalizedKey === 'site-url' ? 'site URL' : 'API URL',
    );
    writeConfig(config, env);
    io.stdout.write(`Saved ${normalizedKey}: ${config[property]}\n`);
    return 0;
  }

  if (subcommand === 'get') {
    if (normalizedKey === 'api-key') {
      io.stdout.write(`${readCredential(env) ? 'api-key is set' : 'api-key is not set'}\n`);
      return 0;
    }
    const property = normalizedKey === 'site-url' ? 'siteUrl' : 'apiUrl';
    io.stdout.write(`${config[property] || `${normalizedKey} is not set`}\n`);
    return 0;
  }

  if (subcommand === 'unset') {
    if (normalizedKey === 'api-key') removeCredential(env);
    else delete config[normalizedKey === 'site-url' ? 'siteUrl' : 'apiUrl'];
    if (normalizedKey !== 'api-key') writeConfig(config, env);
    io.stdout.write(`Removed ${normalizedKey}\n`);
    return 0;
  }

  throw new CliError(`Unknown config command: ${subcommand}`, 2);
}

async function waitForComic(id, globals, env) {
  const timeoutMs = Number(globals.timeoutMs ?? 300000);
  const intervalMs = Number(globals.pollIntervalMs ?? 2000);
  const start = Date.now();
  while (true) {
    const job = await apiRequest('GET', `/v1/comics/generations/${encodeURIComponent(id)}`, undefined, globals, env);
    if (
      ['processed', 'completed', 'succeeded', 'failed', 'canceled', 'cancelled'].includes(
        String(job.status).toLowerCase(),
      )
    ) return job;
    if (Date.now() - start >= timeoutMs) {
      throw new CliError(`Timed out waiting for comic generation ${id}`, 1);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function apiRequest(method, apiPath, body, globals, env) {
  const resolved = resolveCredential(globals, env);
  if (!resolved.apiToken) {
    throw new CliError('Missing API credential. Run `llamagen auth login` or set LLAMAGEN_API_KEY.', 2);
  }
  const config = readConfig(env);
  const apiUrl = resolveApiUrl(globals, env, config, resolved.credential?.apiBaseUrl);
  return requestComicApi(method, apiPath, body, {
    apiToken: resolved.apiToken,
    apiUrl,
    timeoutMs: Number(globals.timeoutMs ?? 120000),
  });
}

function parseGlobals(argv) {
  const args = [];
  const globals = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--api-key') globals.apiKey = requiredGlobalValue(argv, ++index, arg);
    else if (arg === '--site-url') globals.siteUrl = requiredGlobalValue(argv, ++index, arg);
    else if (arg === '--api-url') globals.apiUrl = requiredGlobalValue(argv, ++index, arg);
    else if (arg === '--base-url') globals.baseUrl = requiredGlobalValue(argv, ++index, arg);
    else if (arg === '--timeout-ms') globals.timeoutMs = integerOption(requiredGlobalValue(argv, ++index, arg), arg, 1);
    else if (arg === '--poll-interval-ms') globals.pollIntervalMs = integerOption(requiredGlobalValue(argv, ++index, arg), arg, 1);
    else args.push(arg);
  }
  return { args, globals };
}

function requiredGlobalValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new CliError(`${flag} requires a value.`, 2);
  return value;
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new CliError(`Unexpected argument: ${arg}`, 2);
    const key = camelCase(arg.slice(2));
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function requireOption(options, key) {
  if (!options[key] || options[key] === true) {
    throw new CliError(`Missing required option --${kebabCase(key)}`, 2);
  }
}

function integerOption(value, flag, min, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return undefined;
  if (value === true) {
    throw new CliError(`${flag} requires a value.`, 2);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `${min} or greater` : `${min} to ${max}`;
    throw new CliError(`${flag} must be an integer from ${range}.`, 2);
  }
  return parsed;
}

function assertAllowedOptions(options, allowed, command) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(options).find((key) => !allowedSet.has(key));
  if (unknown) {
    throw new CliError(`Unknown option for ${command}: --${kebabCase(unknown)}`, 2);
  }
}

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFailureStatus(status) {
  return ['failed', 'canceled', 'cancelled'].includes(String(status).toLowerCase());
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== false),
  );
}

function writeJson(io, value) {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function kebabCase(value) {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function helpText() {
  return `LlamaGen CLI ${VERSION}\n\nUsage:\n  llamagen [global flags] <command> [args]\n\nCommands:\n  auth        Sign in, inspect status, or sign out\n  comic       Work with the Comic API\n  animation   Work with the Animation API\n  config      Manage local CLI configuration\n  version     Print version\n\nGlobal flags:\n  --api-key <key>          Override LLAMAGEN_API_KEY\n  --site-url <url>         Authentication site (default: https://llamagen.ai)\n  --api-url <url>          Comic API URL (default: https://api.llamagen.ai)\n  --base-url <url>         Backward-compatible alias for --api-url\n  --timeout-ms <ms>        Request timeout\n  --poll-interval-ms <ms>  Wait polling interval\n`;
}

function comicHelpText() {
  return `Usage:\n  llamagen comic create --prompt <prompt> [--prompt-url <url>] [--size 1024x1024] [--fix-panel-num <1-20>] [--wait]\n  llamagen comic get <generation_id> [--page <n>] [--panel <n>]\n  llamagen comic continue <generation_id> --prompt <prompt> [--fix-panel-num <1-20>]\n  llamagen comic update-panel <generation_id> [--page <n>] --panel <n> (--prompt <prompt> | --panel-prompt <prompt>)\n  llamagen comic usage\n`;
}

function animationHelpText() {
  return `Usage:\n  llamagen animation create --prompt <prompt>\n  llamagen animation get <generation_id>\n`;
}

function configHelpText() {
  return `Usage:\n  llamagen config set site-url <url>\n  llamagen config set api-url <url>\n  llamagen config set api-key <key>\n  llamagen config get <site-url|api-url|api-key>\n  llamagen config unset <site-url|api-url|api-key>\n`;
}
