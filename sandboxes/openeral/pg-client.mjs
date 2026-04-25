#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const sql = process.argv.slice(2).join(' ');
const result = spawnSync('/usr/local/bin/openeral-bash', ['--pg', sql], {
  stdio: 'inherit',
  env: {
    ...process.env,
    HOME: '/home/agent',
    OPENERAL_HOME: '/home/agent',
  },
});

process.exit(result.status ?? 1);
