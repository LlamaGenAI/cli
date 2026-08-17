#!/usr/bin/env node

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.js';

export { main, VERSION } from '../src/cli.js';

const isDirect =
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  const code = await main();
  process.exit(code);
}
