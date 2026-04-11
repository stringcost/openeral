#!/usr/bin/env node

/**
 * CLI to start the optimizer proxy server
 */

import { startProxy } from './proxy.js';

async function main() {
  const args = process.argv.slice(2);

  let port = 8000;
  let optimizerEnabled = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === '--no-optimize') {
      optimizerEnabled = false;
    } else if (args[i] === '--help') {
      console.log(`
Openeral Optimizer Proxy

Usage:
  npx openeral proxy [options]

Options:
  --port <number>     Port to listen on (default: 8000)
  --no-optimize       Disable optimization (passthrough mode)
  --help              Show this help

Environment Variables:
  ANTHROPIC_API_KEY   Your Anthropic API key (required)
  DATABASE_URL        PostgreSQL connection for metrics (optional)
  OPENERAL_WORKSPACE_ID  Workspace ID (default: 'default')

Example:
  npx openeral proxy --port 8000
  
Then set in your environment:
  export ANTHROPIC_BASE_URL=http://localhost:8000
  npx openeral
`);
      process.exit(0);
    }
  }

  try {
    const proxy = await startProxy({ port });
    console.log(`Proxy listening on http://127.0.0.1:${proxy.port}`);
    console.log('Set ANTHROPIC_BASE_URL=http://127.0.0.1:' + proxy.port);
    // Keep running until killed
    await new Promise(() => {});
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
