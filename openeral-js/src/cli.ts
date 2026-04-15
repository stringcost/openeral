#!/usr/bin/env node

/**
 * openeral CLI — run Claude Code with persistent PostgreSQL-backed home.
 *
 * Usage:
 *   npx openeral                      # interactive Claude Code
 *   npx openeral -- -p 'hello'        # non-interactive
 *   npx openeral --workspace myid     # custom workspace ID
 *
 * Required env:
 *   DATABASE_URL          PostgreSQL connection string
 *   ANTHROPIC_API_KEY     Claude API key
 *
 * Optional env:
 *   OPENERAL_WORKSPACE_ID   Workspace ID (default: hostname)
 *   OPENERAL_HOME           Home directory path (default: /tmp/openeral-<id>)
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

function writeClaudeSettings(path: string): void {
  // Default security settings for Claude Code (Level 1 sandbox)
  // Protects SSH keys, AWS credentials, .env files, and prevents unauthorized network/code actions
  const settings = {
    permissions: {
      allow: [
        "Bash(npm run *)",
        "Bash(npm test *)",
        "Bash(git status)",
        "Bash(git diff *)",
        "Bash(git log *)",
        "Bash(git commit *)",
        "Bash(ls *)",
        "Bash(cat *)",
        "Bash(grep *)"
      ],
      deny: [
        "Read(~/.ssh/**)",
        "Read(~/.aws/**)",
        "Read(~/.azure/**)",
        "Read(~/.npmrc)",
        "Read(~/.git-credentials)",
        "Edit(~/.bashrc)",
        "Edit(~/.zshrc)",
        "Bash(curl *)",
        "Bash(wget *)",
        "Bash(nc *)",
        "Bash(ssh *)",
        "Bash(git push *)",
        "Read(*.env)",
        "Read(.env.*)"
      ]
    },
    enableAllProjectMcpServers: false
  };
  writeFileSync(path, JSON.stringify(settings, null, 2));
}

function writePgHelper(path: string): void {
  // pg helper reads DATABASE_URL from the environment at runtime.
  // Never hardcode credentials — rely on env propagation from OpenShell providers.
  const script = `#!/bin/bash
# pg — query the database from Claude Code
# Usage: pg "SELECT * FROM public.users LIMIT 5"
if [ -z "$DATABASE_URL" ]; then
  echo "pg: DATABASE_URL is not set" >&2; exit 1
fi
if command -v psql >/dev/null 2>&1; then
  exec psql "$DATABASE_URL" -c "$*"
else
  exec node -e 'const p=require("pg"),o=new p.Pool({connectionString:process.env.DATABASE_URL});o.query(process.argv[1]).then(r=>{console.log(JSON.stringify(r.rows,null,2));o.end()}).catch(e=>{console.error(e.message);process.exit(1)})' "$*"
fi
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrations.js';
import { syncToFs, syncFromFs, watchAndSync } from './sync.js';

type ParsedArgs = 
  | { kind: 'launch'; workspaceId: string; claudeArgs: string[] }
  | { kind: 'memory-refresh'; workspaceId: string; projectRoot: string; query: string; dryRun: boolean; backup: boolean }
  | { kind: 'help' };

export function parseCliArgs(args: string[]): ParsedArgs {
  // Check for help
  if (args.includes('--help') || args.includes('-h')) {
    // Only show help if it's before --
    const dashIdx = args.indexOf('--');
    const helpIdx = Math.max(args.indexOf('--help'), args.indexOf('-h'));
    if (dashIdx === -1 || helpIdx < dashIdx) {
      return { kind: 'help' };
    }
  }

  // Check for memory refresh command
  if (args[0] === 'memory' && args[1] === 'refresh') {
    let workspaceId = process.env.OPENERAL_WORKSPACE_ID || hostname();
    let projectRoot = '';
    let query = '';
    let dryRun = false;
    let backup = true;

    for (let i = 2; i < args.length; i++) {
      if ((args[i] === '--workspace' || args[i] === '-w') && args[i + 1]) {
        workspaceId = args[++i];
      } else if (args[i] === '--project-root' && args[i + 1]) {
        projectRoot = args[++i];
      } else if (args[i] === '--query' && args[i + 1]) {
        query = args[++i];
      } else if (args[i] === '--dry-run') {
        dryRun = true;
      } else if (args[i] === '--no-backup') {
        backup = false;
      }
    }

    return { kind: 'memory-refresh', workspaceId, projectRoot, query, dryRun, backup };
  }

  // Default: launch mode
  let workspaceId = process.env.OPENERAL_WORKSPACE_ID || hostname();
  let claudeArgs: string[] = [];

  // Split on -- to separate openeral args from claude args
  const dashIdx = args.indexOf('--');
  const ownArgs = dashIdx >= 0 ? args.slice(0, dashIdx) : args;
  claudeArgs = dashIdx >= 0 ? args.slice(dashIdx + 1) : [];

  for (let i = 0; i < ownArgs.length; i++) {
    if ((ownArgs[i] === '--workspace' || ownArgs[i] === '-w') && ownArgs[i + 1]) {
      workspaceId = ownArgs[++i];
    }
  }

  return { kind: 'launch', workspaceId, claudeArgs };
}

function printHelp(): void {
  console.log(`Usage:
  openeral [options] [-- claude-args]    Launch Claude Code with persistent home
  openeral memory refresh [options]      Refresh memory system

Launch Options:
  --workspace, -w <id>    Workspace ID (default: hostname)
  --help, -h              Show this help

Memory Refresh Options:
  --workspace, -w <id>    Workspace ID
  --project-root <path>   Project root directory
  --query <text>          Search query
  --dry-run               Preview changes without applying
  --no-backup             Skip backup creation

Environment Variables:
  DATABASE_URL            PostgreSQL connection string (required for persistence)
  ANTHROPIC_API_KEY       Claude API key (required)
  OPENERAL_WORKSPACE_ID   Default workspace ID
  OPENERAL_HOME           Home directory path
`);
}

export async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));

  if (parsed.kind === 'help') {
    printHelp();
    return;
  }

  if (parsed.kind === 'memory-refresh') {
    process.stderr.write('\x1b[31mopeneral: memory refresh not yet implemented\x1b[0m\n');
    process.exit(1);
  }

  // Launch mode
  const { workspaceId, claudeArgs } = parsed;

  // --- Validate env ---
  const databaseUrl = process.env.DATABASE_URL;
  const persistenceEnabled = !!databaseUrl;

  if (!persistenceEnabled) {
    process.stderr.write(
      '\x1b[33mopeneral: DATABASE_URL not set — running without persistence\x1b[0m\n' +
      '\x1b[2m  Set DATABASE_URL to enable PostgreSQL-backed home directory\x1b[0m\n',
    );
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      '\x1b[33mopeneral: ANTHROPIC_API_KEY not set — Claude Code may not work\x1b[0m\n',
    );
  }

  // --- Setup home directory ---
  const homeDir = process.env.OPENERAL_HOME || `/tmp/openeral-${workspaceId}`;
  mkdirSync(homeDir, { recursive: true });

  process.stderr.write(`\x1b[2mopeneral: workspace  ${workspaceId}\x1b[0m\n`);
  process.stderr.write(`\x1b[2mopeneral: home       ${homeDir}\x1b[0m\n`);
  process.stderr.write(`\x1b[2mopeneral: persist    ${persistenceEnabled ? 'PostgreSQL' : 'local only'}\x1b[0m\n`);

  // --- Database setup (only if DATABASE_URL is set) ---
  let pool: import('pg').Pool | null = null;
  let stopWatch: (() => void) | null = null;

  if (persistenceEnabled) {
    pool = createPool(databaseUrl);

    process.stderr.write('\x1b[2mopeneral: running migrations...\x1b[0m\n');
    await runMigrations(pool);

    // Ensure workspace config exists
    await pool.query(
      `INSERT INTO _openeral.workspace_config (id, display_name, config)
       VALUES ($1, $2, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [workspaceId, workspaceId],
    );

    // Sync from PostgreSQL → filesystem
    process.stderr.write('\x1b[2mopeneral: syncing workspace...\x1b[0m\n');
    const synced = await syncToFs(pool, workspaceId, homeDir);
    process.stderr.write(`\x1b[2mopeneral: restored ${synced} files\x1b[0m\n`);

    // Write pg helper
    const pgHelper = join(homeDir, '.local', 'bin', 'pg');
    mkdirSync(join(homeDir, '.local', 'bin'), { recursive: true });
    writePgHelper(pgHelper);

    // Write default Claude security settings (if not exists)
    const claudeSettingsDir = join(homeDir, '.claude');
    const claudeSettingsPath = join(claudeSettingsDir, 'settings.json');
    if (!existsSync(claudeSettingsPath)) {
      mkdirSync(claudeSettingsDir, { recursive: true });
      writeClaudeSettings(claudeSettingsPath);
      process.stderr.write('\x1b[2mopeneral: wrote default ~/.claude/settings.json (security sandbox)\x1b[0m\n');
    }

    // Write CLAUDE.md
    const claudeMdPath = join(homeDir, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
      writeFileSync(claudeMdPath, `# OpenEral

Your home directory persists across sessions.

## Database

Query the connected database:

    pg "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    pg "SELECT * FROM public.users LIMIT 5"
    pg "\\d public.users"

The \`pg\` command uses psql if available, otherwise Node.js pg.

## Security Settings

OpenEral configures Claude Code with default security sandboxing via \`~/.claude/settings.json\`:

**Protected credentials:**
- SSH keys (\`~/.ssh/**\`)
- AWS credentials (\`~/.aws/**\`)
- Azure credentials (\`~/.azure/**\`)
- npm auth (\`~/.npmrc\`, \`~/.git-credentials\`)
- Shell configs (\`~/.bashrc\`, \`~/.zshrc\`)
- Environment files (\`*.env\`, \`.env.*\`)

**Restricted network commands:**
- \`curl\`, \`wget\`, \`nc\`, \`ssh\` blocked
- \`git push\` requires manual approval

**Auto-approved safe commands:**
- \`npm run *\`, \`npm test *\`
- \`git status\`, \`git diff *\`, \`git log *\`, \`git commit *\`
- \`ls *\`, \`cat *\`, \`grep *\`

Edit \`~/.claude/settings.json\` to customize permissions.
`);
    }

    // Start file watcher
    process.stderr.write('\x1b[2mopeneral: watching for changes...\x1b[0m\n');
    stopWatch = watchAndSync(pool, workspaceId, homeDir);
  }

  // --- StringCost auto-presign ---
  // Build Claude environment from allowlist to avoid exposing unnecessary secrets
  const claudeEnv: Record<string, string | undefined> = {
    HOME: homeDir,
    PATH: `${join(homeDir, '.local', 'bin')}:${process.env.PATH}`,
    // Include required ANTHROPIC_* variables for Claude Code
    ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
    ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {}),
  };

  if (process.env.STRINGCOST_API_KEY && process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('\x1b[2mopeneral: presigning with StringCost...\x1b[0m\n');
    try {
      // Use a 10-second timeout to prevent indefinite hangs
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const res = await fetch('https://app.stringcost.com/v1/presign', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.STRINGCOST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'anthropic',
          client_api_key: process.env.ANTHROPIC_API_KEY,
          path: ['/v1/messages'],
          expires_in: -1,
          max_uses: -1,
          tags: ['openeral'],
          metadata: { source: 'openeral' },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { url?: string };
      if (data.url) {
        claudeEnv.ANTHROPIC_BASE_URL = data.url.replace(/\/v1\/.*$/, '');
        process.stderr.write('\x1b[2mopeneral: StringCost enabled — costs tracked automatically\x1b[0m\n');
      }
    } catch (err: any) {
      process.stderr.write(`\x1b[33mopeneral: StringCost presign failed: ${err.message} — continuing without cost tracking\x1b[0m\n`);
    }
  }

  // --- StringCost org skills download ---
  if (process.env.STRINGCOST_API_KEY) {
    process.stderr.write('\x1b[2mopeneral: fetching org skills...\x1b[0m\n');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const res = await fetch('https://app.stringcost.com/v2/skills/bundle', {
        headers: { 'Authorization': `Bearer ${process.env.STRINGCOST_API_KEY}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json() as { skills?: Array<{ slug: string; content: string }> };
        if (data.skills && data.skills.length > 0) {
          const skillsDir = join(homeDir, '.claude', 'skills');
          mkdirSync(skillsDir, { recursive: true });
          for (const skill of data.skills) {
            const dir = join(skillsDir, skill.slug);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'SKILL.md'), skill.content);
          }
          process.stderr.write(`\x1b[2mopeneral: installed ${data.skills.length} org skill(s)\x1b[0m\n`);
        }
      } else if (res.status !== 404) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err: any) {
      process.stderr.write(`\x1b[33mopeneral: skills fetch failed: ${err.message} — continuing\x1b[0m\n`);
    }
  }

  // --- Ensure Claude security settings exist in OS home ---
  // Claude Code reads ~/.claude/settings.json from OS home (not env HOME).
  // Create default security settings once if they don't exist.
  const osHomeDir = homedir();
  const osClaudeDir = join(osHomeDir, '.claude');
  const osSettingsPath = join(osClaudeDir, 'settings.json');
  if (!existsSync(osSettingsPath)) {
    mkdirSync(osClaudeDir, { recursive: true });
    writeClaudeSettings(osSettingsPath);
    process.stderr.write('\x1b[2mopeneral: created default ~/.claude/settings.json (security sandbox)\x1b[0m\n');
  }

  // --- Launch Claude Code ---
  process.stderr.write('\x1b[2mopeneral: starting Claude Code\x1b[0m\n\n');

  const child = spawn('claude', claudeArgs, {
    stdio: 'inherit',
    env: claudeEnv,
  });

  child.on('error', (err: any) => {
    if (err.code === 'ENOENT') {
      process.stderr.write(
        '\x1b[31mopeneral: `claude` not found. Install Claude Code:\x1b[0m\n' +
        '  npm install -g @anthropic-ai/claude-code\n' +
        '  # or: curl -fsSL https://claude.ai/install.sh | bash\n\n',
      );
    } else {
      process.stderr.write(`openeral: ${err.message}\n`);
    }
    process.exit(1);
  });

  child.on('exit', async (code) => {
    if (pool && stopWatch) {
      stopWatch();
      process.stderr.write('\n\x1b[2mopeneral: saving workspace...\x1b[0m\n');
      try {
        const saved = await syncFromFs(pool, workspaceId, homeDir);
        process.stderr.write(`\x1b[2mopeneral: saved ${saved} files\x1b[0m\n`);
      } catch (err: any) {
        process.stderr.write(`\x1b[31mopeneral: sync failed: ${err.message}\x1b[0m\n`);
      }
      await pool.end();
    }
    process.exit(code ?? 0);
  });

  // Forward signals to child
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => child.kill(sig));
  }
}

// Only run main if this is the entry point (not imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`\x1b[31mopeneral: ${err.message}\x1b[0m\n`);
    process.exit(1);
  });
}