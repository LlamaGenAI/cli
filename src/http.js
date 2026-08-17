import http from 'node:http';
import https from 'node:https';

import { CliError } from './errors.js';

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

export async function requestJson({ method, url, body, headers = {}, timeoutMs = 120000 }) {
  const target = url instanceof URL ? url : new URL(url);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  let response;
  try {
    response = await rawRequest(target, {
      method,
      headers: compact({
        accept: 'application/json',
        'content-type': payload ? 'application/json' : undefined,
        'content-length': payload ? Buffer.byteLength(payload) : undefined,
        ...headers,
      }),
      body: payload,
      timeoutMs,
    });
  } catch (error) {
    throw new CliError(`Unable to reach ${target.origin}: ${error.message}`, 3);
  }

  const parsed = response.text ? parseJson(response.text) : {};
  if (!response.ok) {
    const detail = typeof parsed?.error === 'string'
      ? parsed.error
      : typeof parsed?.message === 'string'
        ? parsed.message
        : `HTTP ${response.status}`;
    throw new CliError(`LlamaGen request failed (${response.status}): ${detail}`, 1, response.status);
  }
  return parsed;
}

function rawRequest(url, options) {
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      { method: options.method, headers: options.headers },
      (response) => {
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('Response exceeded the 20 MB safety limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          headers: response.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    request.on('error', reject);
    request.setTimeout(options.timeoutMs, () =>
      request.destroy(new Error(`Request timed out after ${options.timeoutMs}ms`)),
    );
    if (options.body) request.write(options.body);
    request.end();
  });
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch { return { raw: text.slice(0, 1000) }; }
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null),
  );
}
