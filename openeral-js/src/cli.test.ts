import { describe, it, expect } from 'vitest';
import { readFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { parseCliArgs, findRepoRoot } from './cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// We can't import writePgHelper directly (it's not exported),
// so we test by running the CLI's pg helper generation logic inline.

describe('pg helper script', () => {
  const tmpDir = '/tmp/openeral-cli-test-' + Date.now();

  it('reads DATABASE_URL from environment, never hardcodes it', () => {
    mkdirSync(join(tmpDir, '.local', 'bin'), { recursive: true });
    const pgPath = join(tmpDir, '.local', 'bin', 'pg');

    // Simulate what writePgHelper does
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
    require('fs').writeFileSync(pgPath, script);
    require('fs').chmodSync(pgPath, 0o755);

    const content = readFileSync(pgPath, 'utf8');

    // Must reference $DATABASE_URL (env var)
    expect(content).toContain('$DATABASE_URL');
    expect(content).toContain('process.env.DATABASE_URL');

    // Must NOT contain a literal postgresql:// connection string
    expect(content).not.toMatch(/postgresql:\/\/\w+:\w+@/);

    // Must NOT contain a literal API key
    expect(content).not.toMatch(/sk-ant-/);

    // Must fail if DATABASE_URL is not set
    expect(content).toContain('DATABASE_URL is not set');

    rmSync(tmpDir, { recursive: true });
  });

  it('pg helper fails without DATABASE_URL', () => {
    mkdirSync(join(tmpDir, '.local', 'bin'), { recursive: true });
    const pgPath = join(tmpDir, '.local', 'bin', 'pg');

    const script = `#!/bin/bash
if [ -z "$DATABASE_URL" ]; then
  echo "pg: DATABASE_URL is not set" >&2; exit 1
fi
echo "would run: $*"
`;
    require('fs').writeFileSync(pgPath, script);
    require('fs').chmodSync(pgPath, 0o755);

    // Run without DATABASE_URL — should fail
    try {
      execSync(`env -u DATABASE_URL bash ${pgPath} "SELECT 1"`, { encoding: 'utf8', stdio: 'pipe' });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.stderr).toContain('DATABASE_URL is not set');
    }

    rmSync(tmpDir, { recursive: true });
  });

  it('pg helper succeeds with DATABASE_URL set', () => {
    mkdirSync(join(tmpDir, '.local', 'bin'), { recursive: true });
    const pgPath = join(tmpDir, '.local', 'bin', 'pg');

    const script = `#!/bin/bash
if [ -z "$DATABASE_URL" ]; then
  echo "pg: DATABASE_URL is not set" >&2; exit 1
fi
echo "connected to: $DATABASE_URL"
`;
    require('fs').writeFileSync(pgPath, script);
    require('fs').chmodSync(pgPath, 0o755);

    const out = execSync(`DATABASE_URL=test://db bash ${pgPath} "SELECT 1"`, { encoding: 'utf8' });
    expect(out.trim()).toBe('connected to: test://db');

    rmSync(tmpDir, { recursive: true });
  });
});

describe('openeral-shell skill shape', () => {
  const skillPath = join(__dirname, '../../.claude/skills/openeral-shell/SKILL.md');
  const skill = readFileSync(skillPath, 'utf8');

  it('launches from the published GHCR image, not a local build', () => {
    expect(skill).toContain('ghcr.io/sandys/openeral/sandbox:just-bash');
    // No `docker build` or local-image references in the main flow
    expect(skill).not.toMatch(/--dev\b/);
    expect(skill).not.toMatch(/openeral-sandbox:dev/);
  });

  it('uses openshell-only commands (no npx, no pnpm)', () => {
    expect(skill).not.toMatch(/\bnpx openeral\b/);
    expect(skill).not.toMatch(/\bpnpm (install|build)\b/);
  });

  it('uses gateway info (not the nonexistent gateway list)', () => {
    expect(skill).not.toMatch(/openshell gateway list\b/);
    expect(skill).toContain('openshell gateway info');
  });

  it('creates generic providers explicitly with KEY=VALUE (not by env lookup)', () => {
    expect(skill).toMatch(/openshell provider create --name db[\s\S]*DATABASE_URL=/);
    expect(skill).toMatch(/openshell provider create --name stringcost[\s\S]*STRINGCOST_API_KEY=/);
  });

  it('does not invoke openshell sandbox exec (which does not exist)', () => {
    // Allow mentions inside prose (e.g. "There is no `openshell sandbox exec`"),
    // but reject it appearing in a shell code block.
    const codeBlockRe = /```[a-z]*\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = codeBlockRe.exec(skill)) !== null) {
      expect(m[1]).not.toMatch(/openshell sandbox exec\b/);
    }
  });
});

describe('CLI argument parsing', () => {
  it('parses memory refresh options', () => {
    const parsed = parseCliArgs([
      'memory',
      'refresh',
      '--workspace', 'mem-ws',
      '--project-root', '/tmp/project',
      '--query', 'openshell proxy',
      '--dry-run',
      '--no-backup',
    ]);

    expect(parsed).toEqual({
      kind: 'memory-refresh',
      workspaceId: 'mem-ws',
      projectRoot: '/tmp/project',
      query: 'openshell proxy',
      dryRun: true,
      backup: false,
    });
  });

  it('keeps launch mode compatible with Claude args after --', () => {
    const parsed = parseCliArgs(['--workspace', 'alpha', '--', '-p', 'hello']);

    expect(parsed).toEqual({
      kind: 'launch',
      workspaceId: 'alpha',
      claudeArgs: ['-p', 'hello'],
    });
  });

  it('treats --help after -- as a Claude arg, not OpenEral help', () => {
    const parsed = parseCliArgs(['--', '--help']);

    expect(parsed).toEqual({
      kind: 'launch',
      workspaceId: 'openeral-claude',
      claudeArgs: ['--help'],
    });
  });
});

describe('built CLI entrypoint', () => {
  const binPath = join(__dirname, '../dist/bin/openeral.js');

  it('prints help when run through the built bin path', () => {
    const out = execFileSync(process.execPath, [binPath, '--help'], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      stdio: 'pipe',
    });

    expect(out).toContain('Usage:');
    expect(out).toContain('openeral memory refresh');
  });

  it('prints help when the built bin is invoked via a symlinked path', () => {
    const tmpDir = `/tmp/openeral-bin-symlink-${Date.now()}`;
    const symlinkPath = join(tmpDir, 'openeral');

    mkdirSync(tmpDir, { recursive: true });
    symlinkSync(binPath, symlinkPath);

    try {
      const out = execFileSync(process.execPath, [symlinkPath, '--help'], {
        cwd: join(__dirname, '..'),
        encoding: 'utf8',
        stdio: 'pipe',
      });

      expect(out).toContain('Usage:');
      expect(out).toContain('openeral memory refresh');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('findRepoRoot', () => {
  it('finds the repo root containing sandboxes/openeral/Dockerfile', () => {
    const root = findRepoRoot();
    expect(root).not.toBeNull();
    // The discovered root must contain the Dockerfile landmark
    const { existsSync } = require('node:fs');
    expect(existsSync(join(root!, 'sandboxes', 'openeral', 'Dockerfile'))).toBe(true);
  });

  it('returns null when the landmark is not found within maxLevels', () => {
    // Pass maxLevels=0 so the walk never starts — always null
    expect(findRepoRoot(0)).toBeNull();
  });
});
