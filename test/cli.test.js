import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../bin/llamagen.js';

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

test('comic create sends promptUrl to latest endpoint', async () => {
  const { server, requests, baseUrl } = await startServer(() => ({ id: 'gen_123', status: 'COMPLETED' }));
  try {
    const output = capture();
    const code = await main(['--api-key', 'test', '--base-url', baseUrl, 'comic', 'create', '--prompt', 'hero', '--prompt-url', 'https://s.llamagen.ai/yourteam/uploads/script-brief.pdf', '--size', '1024x1024'], {}, output.io);
    assert.equal(code, 0);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/v1/comics/generations');
    assert.equal(requests[0].body.promptUrl, 'https://s.llamagen.ai/yourteam/uploads/script-brief.pdf');
    assert.match(output.stdout, /gen_123/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
