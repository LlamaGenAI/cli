import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';

import {
  readConfig,
  removeCredential,
  resolveApiUrl,
  resolveCredential,
  resolveSiteUrl,
  tokenHint,
  writeCredential,
} from './config.js';
import { CliError } from './errors.js';
import { requestJson } from './http.js';
import { VERSION } from './version.js';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export async function runAuth(args, globals, env, io, runtime = {}) {
  const subcommand = args.shift();
  if (!subcommand || subcommand === 'help') {
    io.stdout.write(authHelpText());
    return 0;
  }
  if (subcommand === 'login') return authLogin(args, globals, env, io, runtime);
  if (subcommand === 'status') return authStatus(args, globals, env, io);
  if (subcommand === 'logout') return authLogout(args, env, io);
  throw new CliError(`Unknown auth command: ${subcommand}`, 2);
}

async function authLogin(args, globals, env, io, runtime) {
  const options = parseAuthOptions(args, new Set(['json', 'noBrowser', 'loginTimeoutMs']));
  const config = readConfig(env);
  const siteUrl = resolveSiteUrl(globals, env, config);
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
  const callback = await createCallbackServer(
    state,
    Number(options.loginTimeoutMs || LOGIN_TIMEOUT_MS),
  );

  try {
    const start = await requestJson({
      method: 'POST',
      url: `${siteUrl}/api/cli/auth/requests`,
      body: {
        redirectUri: callback.redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod: 'S256',
        cliVersion: VERSION,
      },
      headers: { 'user-agent': `llamagen-cli/${VERSION}` },
      timeoutMs: Number(globals.timeoutMs || 30000),
    });
    const authorizeUrl = normalizeAuthorizeUrl(start?.authorizeUrl, siteUrl);
    if (!authorizeUrl) {
      throw new CliError('LlamaGen did not return a browser authorization URL.', 1);
    }

    const progressOutput = options.json ? io.stderr : io.stdout;
    progressOutput.write(`Opening ${authorizeUrl}\n`);
    if (!options.noBrowser) {
      try {
        await (runtime.openBrowser || openBrowser)(authorizeUrl);
      } catch {
        io.stderr.write('Could not open the browser automatically. Open the URL above manually.\n');
      }
    } else {
      progressOutput.write('Browser opening is disabled; open the URL above on this computer.\n');
    }

    const callbackResult = await callback.completion;
    const exchange = await requestJson({
      method: 'POST',
      url: `${siteUrl}/api/cli/auth/exchange`,
      body: {
        code: callbackResult.code,
        verifier,
        redirectUri: callback.redirectUri,
      },
      headers: { 'user-agent': `llamagen-cli/${VERSION}` },
      timeoutMs: Number(globals.timeoutMs || 30000),
    });

    if (typeof exchange?.apiToken !== 'string' || exchange.apiToken.length < 12) {
      throw new CliError('LlamaGen returned an invalid Comic API credential.', 1);
    }
    const apiUrl = resolveApiUrl(globals, env, config, exchange.apiBaseUrl);
    let usage = null;
    let validationWarning = null;
    try {
      usage = await requestComicApi('GET', '/v1/comics/usage', undefined, {
        apiToken: exchange.apiToken,
        apiUrl,
        timeoutMs: Number(globals.timeoutMs || 30000),
      });
    } catch (error) {
      if (error instanceof CliError && [401, 403].includes(error.status)) {
        throw new CliError('The Comic API rejected the credential returned by LlamaGen.', 1);
      }
      validationWarning = error.message;
    }

    writeCredential({
      apiToken: exchange.apiToken,
      email: exchange.user?.email || null,
      name: exchange.user?.name || null,
      userId: exchange.user?.id || null,
      apiBaseUrl: apiUrl,
      siteUrl,
      authenticatedAt: new Date().toISOString(),
    }, env);

    if (options.json) {
      io.stdout.write(`${JSON.stringify({
        authenticated: true,
        account: exchange.user?.email || exchange.user?.name || null,
        siteUrl,
        apiUrl,
        apiReachable: !validationWarning,
        usage,
      }, null, 2)}\n`);
    } else {
      const account = exchange.user?.email || exchange.user?.name;
      io.stdout.write(`✓ Signed in${account ? ` as ${account}` : ''}\n`);
      io.stdout.write('✓ Comic API token saved locally\n');
      if (validationWarning) {
        io.stderr.write(`⚠ Token saved, but Comic API verification was unavailable: ${validationWarning}\n`);
      } else {
        io.stdout.write('✓ Comic API is ready\n');
      }
    }
    return 0;
  } finally {
    callback.close();
  }
}

async function authStatus(args, globals, env, io) {
  const options = parseAuthOptions(args, new Set(['json', 'offline']));
  const resolved = resolveCredential(globals, env);
  if (!resolved.apiToken) {
    const result = { authenticated: false, status: 'not_authenticated', source: 'none' };
    if (options.json) io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else io.stdout.write('Not signed in. Run `llamagen auth login`.\n');
    return 1;
  }

  const config = readConfig(env);
  const apiUrl = resolveApiUrl(globals, env, config, resolved.credential?.apiBaseUrl);
  const base = {
    authenticated: true,
    status: options.offline ? 'stored' : 'authenticated',
    source: resolved.source,
    tokenHint: tokenHint(resolved.apiToken),
    account: resolved.credential?.email || resolved.credential?.name || null,
    apiUrl,
  };
  if (options.offline) {
    printStatus(io, base, options.json);
    return 0;
  }

  try {
    const usage = await requestComicApi('GET', '/v1/comics/usage', undefined, {
      apiToken: resolved.apiToken,
      apiUrl,
      timeoutMs: Number(globals.timeoutMs || 30000),
    });
    printStatus(io, { ...base, usage, checkedAt: new Date().toISOString() }, options.json);
    return 0;
  } catch (error) {
    if (error instanceof CliError && [401, 403].includes(error.status)) {
      printStatus(io, { ...base, authenticated: false, status: 'invalid' }, options.json);
      return 1;
    }
    printStatus(io, { ...base, status: 'unreachable', error: error.message }, options.json);
    return 3;
  }
}

function authLogout(args, env, io) {
  const options = parseAuthOptions(args, new Set(['json']));
  const removed = removeCredential(env);
  const environmentStillActive = Boolean(env.LLAMAGEN_API_KEY);
  const result = {
    loggedOut: true,
    removedLocalCredential: removed,
    environmentCredentialActive: environmentStillActive,
  };
  if (options.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    io.stdout.write('✓ Signed out from LlamaGen CLI\n');
    io.stdout.write('Your browser session and server-side Comic API token remain active.\n');
    if (environmentStillActive) {
      io.stderr.write('⚠ LLAMAGEN_API_KEY is still set in this environment.\n');
    }
  }
  return 0;
}

export async function requestComicApi(method, apiPath, body, options) {
  return requestJson({
    method,
    url: `${options.apiUrl}${apiPath}`,
    body,
    headers: {
      authorization: `Bearer ${options.apiToken}`,
      'user-agent': `llamagen-cli/${VERSION}`,
    },
    timeoutMs: options.timeoutMs,
  });
}

function createCallbackServer(expectedState, timeoutMs) {
  let timeout;
  let settled = false;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) rejectCompletion(error);
    else resolveCompletion(value);
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('referrer-policy', 'no-referrer');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (state !== expectedState) {
      response.statusCode = 400;
      response.end(callbackHtml('Authorization failed', 'The login state did not match. Return to the terminal.'));
      finish(new CliError('CLI login callback state did not match.', 1));
      return;
    }
    if (error || !code) {
      response.statusCode = 400;
      response.end(callbackHtml('Authorization cancelled', 'No credential was shared. You can close this window.'));
      finish(new CliError(error === 'access_denied' ? 'CLI authorization was cancelled.' : 'CLI authorization failed.', 1));
      return;
    }
    response.end(callbackHtml('LlamaGen CLI is ready', 'Authorization completed. You can close this window and return to the terminal.'));
    finish(null, { code });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      timeout = setTimeout(() => {
        finish(new CliError('Timed out waiting for browser authorization.', 1));
        server.close();
      }, timeoutMs);
      timeout.unref?.();
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}/callback`,
        completion,
        close: () => {
          clearTimeout(timeout);
          server.close();
        },
      });
    });
  });
}

function callbackHtml(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${title}</title></head><body style="font-family:system-ui;background:#f5f5f7;color:#17181c;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:520px;background:white;border-radius:24px;padding:40px;box-shadow:0 20px 60px rgba(0,0,0,.12)"><h1>${title}</h1><p style="line-height:1.6;color:#666">${message}</p></main></body></html>`;
}

function openBrowser(url) {
  const command = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function parseAuthOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let key;
    if (arg === '--json') key = 'json';
    else if (arg === '--offline') key = 'offline';
    else if (arg === '--no-browser') key = 'noBrowser';
    else if (arg === '--login-timeout-ms') key = 'loginTimeoutMs';
    else throw new CliError(`Unknown auth option: ${arg}`, 2);
    if (!allowed.has(key)) throw new CliError(`Unsupported option for this auth command: ${arg}`, 2);
    if (key === 'loginTimeoutMs') {
      const value = args[++index];
      options[key] = positiveInteger(value, arg);
    } else {
      options[key] = true;
    }
  }
  return options;
}

function normalizeAuthorizeUrl(value, siteUrl) {
  if (typeof value !== 'string') return null;
  try {
    const authorizeUrl = new URL(value);
    if (authorizeUrl.origin !== new URL(siteUrl).origin) return null;
    return authorizeUrl.toString();
  } catch {
    return null;
  }
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!value || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`${flag} requires a positive integer.`, 2);
  }
  return parsed;
}

function printStatus(io, result, json) {
  if (json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  io.stdout.write(`Signed in:       ${result.authenticated ? 'Yes' : 'No'}\n`);
  if (result.account) io.stdout.write(`Account:         ${result.account}\n`);
  io.stdout.write(`Credential:      ${result.source}\n`);
  io.stdout.write(`Token:           ${result.tokenHint}\n`);
  io.stdout.write(`Comic API:       ${result.status}\n`);
  const credits = result.usage?.creditBalance ?? result.usage?.credits ?? result.usage?.remaining;
  if (credits !== undefined) io.stdout.write(`Credits:         ${credits}\n`);
  if (result.error) io.stderr.write(`${result.error}\n`);
}

function authHelpText() {
  return `Usage:\n  llamagen auth login [--no-browser] [--json]\n  llamagen auth status [--offline] [--json]\n  llamagen auth logout [--json]\n`;
}
