#!/usr/bin/env node

import { main } from '../cli.js';

void main().catch((err: unknown) => {
  const e = err instanceof Error ? err : new Error(String(err));
  process.stderr.write(`\x1b[31mopeneral: ${e.message}\x1b[0m\n`);
  process.exit(1);
});

