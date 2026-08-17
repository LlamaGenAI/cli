import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main, VERSION } from '../bin/llamagen.js';

function capture() {
  let stdout = '';
  let stderr = '';
  return { io: { stdout: { write: (value) => { stdout += value; } }, stderr: { write: (value) => { stderr += value; } } }, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function startServer(responder) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const record = { method: request.method, url: request.url, body: body ? JSON.parse(body) : undefined, headers: request.headers };
    requests.push(record);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(responder(record)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, requests, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('CLI version matches package metadata', () => {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(VERSION, packageJson.version);
});

test('npm-style symlinked executable runs the CLI entrypoint', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'llamagen-cli-bin-'));
  const executable = path.join(directory, 'llamagen');
  symlinkSync(path.join(process.cwd(), 'bin', 'llamagen.js'), executable);
  const result = spawnSync(executable, ['version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `llamagen ${VERSION}`);
});

test('comic create sends promptUrl to latest endpoint', async () => {
  const { server, requests, baseUrl } = await startServer(() => ({ id: 'gen_123', status: 'COMPLETED' }));
  try {
    const output = capture();
    const code = await main(['--api-key', 'test', '--base-url', baseUrl, 'comic', 'create', '--prompt', 'hero', '--prompt-url', 'https://s.llamagen.ai/yourteam/uploads/script-brief.pdf', '--size', '1024x1024'], {}, output.io);
    assert.equal(code, 0);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/v1/comics/generations');
    assert.equal(requests[0].body.promptUrl, 'https://s.llamagen.ai/yourteam/uploads/script-brief.pdf');
    assert.equal(requests[0].body.preset, 'neutral');
    assert.match(output.stdout, /gen_123/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('comic get and panel update match the official zero-based Comic SDK contract', async () => {
  const { server, requests, baseUrl } = await startServer(() => ({ id: 'gen_123', status: 'PROCESSED' }));
  try {
    const getOutput = capture();
    assert.equal(await main([
      '--api-key', 'test', '--api-url', baseUrl,
      'comic', 'get', 'gen_123', '--page', '0', '--panel', '2',
    ], {}, getOutput.io), 0);

    const updateOutput = capture();
    assert.equal(await main([
      '--api-key', 'test', '--api-url', baseUrl,
      'comic', 'update-panel', 'gen_123', '--page', '0', '--panel', '2',
      '--panel-prompt', 'Keep the hero consistent',
    ], {}, updateOutput.io), 0);

    assert.equal(requests[0].url, '/v1/comics/generations/gen_123?page=0&panel=2');
    assert.equal(requests[1].method, 'PATCH');
    assert.deepEqual(requests[1].body, {
      page: 0,
      panel: 2,
      panelPrompt: 'Keep the hero consistent',
      action: 'regeneratePanel',
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('comic commands reject invalid ranges, missing panel updates, and unknown options locally', async () => {
  const invalidPanelCount = capture();
  assert.equal(await main([
    '--api-key', 'test', 'comic', 'create', '--prompt', 'hero', '--fix-panel-num', '0',
  ], {}, invalidPanelCount.io), 2);
  assert.match(invalidPanelCount.stderr, /--fix-panel-num must be an integer from 1 to 20/);

  const missingPanel = capture();
  assert.equal(await main([
    '--api-key', 'test', 'comic', 'update-panel', 'gen_123', '--prompt', 'closer shot',
  ], {}, missingPanel.io), 2);
  assert.match(missingPanel.stderr, /Missing required option --panel/);

  const missingPanelValue = capture();
  assert.equal(await main([
    '--api-key', 'test', 'comic', 'get', 'gen_123', '--panel',
  ], {}, missingPanelValue.io), 2);
  assert.match(missingPanelValue.stderr, /--panel requires a value/);

  const unknownOption = capture();
  assert.equal(await main([
    '--api-key', 'test', 'comic', 'create', '--prompt', 'hero', '--typo', 'value',
  ], {}, unknownOption.io), 2);
  assert.match(unknownOption.stderr, /Unknown option for comic create: --typo/);
});

test('config stores api key in isolated config home', async () => {
  const output = capture();
  const env = { LLAMAGEN_CONFIG_HOME: mkdtempSync(path.join(tmpdir(), 'llamagen-cli-')) };
  assert.equal(await main(['config', 'set', 'api-key', 'llg_test'], env, output.io), 0);
  assert.match(output.stdout, /Saved api-key securely/);
  const credentials = JSON.parse(readFileSync(path.join(env.LLAMAGEN_CONFIG_HOME, 'credentials.json'), 'utf8'));
  assert.equal(credentials.apiToken, 'llg_test');
  if (process.platform !== 'win32') {
    assert.equal(statSync(path.join(env.LLAMAGEN_CONFIG_HOME, 'credentials.json')).mode & 0o777, 0o600);
  }
});

test('auth login reuses browser handoff, verifies Comic API, and supports custom domains', async () => {
  let startBody;
  let exchanged = false;
  const { server, requests, baseUrl } = await startServer((request) => {
    if (request.url === '/api/cli/auth/requests') {
      startBody = request.body;
      return { authorizeUrl: `${baseUrl}/authorize?request_id=req_test`, expiresIn: 300 };
    }
    if (request.url === '/api/cli/auth/exchange') {
      exchanged = true;
      assert.equal(request.body.redirectUri, startBody.redirectUri);
      assert.equal(
        createHash('sha256').update(request.body.verifier).digest('base64url'),
        startBody.codeChallenge,
      );
      return {
        apiToken: 'sk-test-token-1234567890',
        apiBaseUrl: baseUrl,
        user: { id: 'user-1', email: 'creator@example.com', name: 'Creator' },
      };
    }
    if (request.url === '/v1/comics/usage') {
      assert.equal(request.headers.authorization, 'Bearer sk-test-token-1234567890');
      return { creditBalance: 1280 };
    }
    return { error: 'not found' };
  });
  const configHome = mkdtempSync(path.join(tmpdir(), 'llamagen-cli-auth-'));
  const env = { LLAMAGEN_CONFIG_HOME: configHome };

  try {
    const output = capture();
    const code = await main(
      ['--site-url', baseUrl, '--api-url', baseUrl, 'auth', 'login'],
      env,
      output.io,
      {
        openBrowser: async () => {
          const callback = new URL(startBody.redirectUri);
          callback.searchParams.set('code', 'one-time-code');
          callback.searchParams.set('state', startBody.state);
          const response = await fetch(callback);
          assert.equal(response.status, 200);
        },
      },
    );

    assert.equal(code, 0);
    assert.equal(exchanged, true);
    assert.match(output.stdout, /Signed in as creator@example.com/);
    assert.equal(output.stdout.includes('sk-test-token'), false);
    const credential = JSON.parse(readFileSync(path.join(configHome, 'credentials.json'), 'utf8'));
    assert.equal(credential.apiToken, 'sk-test-token-1234567890');
    assert.equal(credential.siteUrl, baseUrl);
    assert.equal(credential.apiBaseUrl, baseUrl);

    const status = capture();
    assert.equal(await main(['auth', 'status', '--json'], env, status.io), 0);
    const statusJson = JSON.parse(status.stdout);
    assert.equal(statusJson.authenticated, true);
    assert.equal(statusJson.usage.creditBalance, 1280);
    assert.equal(status.stdout.includes('sk-test-token'), false);

    const logout = capture();
    assert.equal(await main(['auth', 'logout'], env, logout.io), 0);
    assert.equal(existsSync(path.join(configHome, 'credentials.json')), false);
    assert.match(logout.stdout, /server-side Comic API token remain active/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(requests.filter((request) => request.url === '/v1/comics/usage').length, 2);
});

test('auth logout warns when LLAMAGEN_API_KEY still authenticates the process', async () => {
  const output = capture();
  const env = {
    LLAMAGEN_CONFIG_HOME: mkdtempSync(path.join(tmpdir(), 'llamagen-cli-logout-')),
    LLAMAGEN_API_KEY: 'environment-token',
  };
  assert.equal(await main(['auth', 'logout'], env, output.io), 0);
  assert.match(output.stderr, /LLAMAGEN_API_KEY is still set/);
});

test('comic wait treats PROCESSED as a terminal success state', async () => {
  let reads = 0;
  const { server, baseUrl } = await startServer((request) => {
    if (request.method === 'POST') return { id: 'gen_processed', status: 'QUEUED' };
    reads += 1;
    return { id: 'gen_processed', status: 'PROCESSED' };
  });
  try {
    const output = capture();
    const code = await main([
      '--api-key', 'test',
      '--api-url', baseUrl,
      '--poll-interval-ms', '1',
      'comic', 'create', '--prompt', 'hero', '--wait',
    ], {}, output.io);
    assert.equal(code, 0);
    assert.equal(reads, 1);
    assert.match(output.stdout, /PROCESSED/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('comic wait returns a failing exit code for terminal failure states', async () => {
  const { server, baseUrl } = await startServer((request) => {
    if (request.method === 'POST') return { id: 'gen_failed', status: 'QUEUED' };
    return { id: 'gen_failed', status: 'FAILED', error: 'provider rejected prompt' };
  });
  try {
    const output = capture();
    const code = await main([
      '--api-key', 'test',
      '--api-url', baseUrl,
      '--poll-interval-ms', '1',
      'comic', 'create', '--prompt', 'hero', '--wait',
    ], {}, output.io);
    assert.equal(code, 1);
    assert.match(output.stdout, /FAILED/);
    assert.match(output.stderr, /ended with status FAILED/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
