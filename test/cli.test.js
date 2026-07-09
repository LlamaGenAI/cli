import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
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
  assert.match(output.stdout, /Saved api-key/);
});
