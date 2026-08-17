#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { main } from '../src/cli.js';

export { main } from '../src/cli.js';

const isDirect =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirect) {
  const code = await main();
  process.exit(code);
}
