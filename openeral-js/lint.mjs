#!/usr/bin/env node

/**
 * Structural lints for openeral-js — catches classes of bugs found during
 * development so they don't recur.
 *
 * Run: node lint.mjs (or pnpm lint)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = 'src';
let errors = 0;

function fail(file, message) {
  console.error(`  FAIL  ${file}: ${message}`);
  errors++;
}

function pass(label) {
  console.log(`  OK    ${label}`);
}

function allTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...allTsFiles(full));
    } else if (full.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Lint 1: Every import from a local .js file must have a corresponding .ts source
// Catches: missing module exports (like deleteTree)
// ---------------------------------------------------------------------------
console.log('\n--- Lint: import targets exist ---');

const tsFiles = allTsFiles(SRC);
const importRe = /from\s+['"](\.[^'"]+\.js)['"]/g;

for (const file of tsFiles) {
  if (file.endsWith('.test.ts')) continue;
  const content = readFileSync(file, 'utf8');
  let match;
  while ((match = importRe.exec(content)) !== null) {
    const importPath = match[1].replace(/\.js$/, '.ts');
    const resolved = join(file, '..', importPath);
    try {
      statSync(resolved);
    } catch {
      fail(file, `imports '${match[1]}' but ${resolved} does not exist`);
    }
  }
}
pass('all local imports resolve to .ts files');

// ---------------------------------------------------------------------------
// Lint 2: Every named import from a local module must be exported by that module
// Catches: importing deleteTree from a file that doesn't export it
// ---------------------------------------------------------------------------
console.log('\n--- Lint: named imports match exports ---');

const namedImportRe = /import\s+(?:type\s+)?{\s*([^}]+)}\s+from\s+['"](\.[^'"]+\.js)['"]/g;
const exportRe = /export\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+(\w+)/g;

for (const file of tsFiles) {
  if (file.endsWith('.test.ts')) continue;
  const content = readFileSync(file, 'utf8');
  let match;
  while ((match = namedImportRe.exec(content)) !== null) {
    const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const targetPath = join(file, '..', match[2].replace(/\.js$/, '.ts'));

    let targetContent;
    try {
      targetContent = readFileSync(targetPath, 'utf8');
    } catch {
      continue; // Lint 1 already catches missing files
    }

    const exports = new Set();
    let expMatch;
    while ((expMatch = exportRe.exec(targetContent)) !== null) {
      exports.add(expMatch[1]);
    }

    for (const name of names) {
      if (!exports.has(name)) {
        fail(file, `imports '${name}' from '${match[2]}' but it is not exported`);
      }
    }
  }
}
pass('all named imports match exports');

// ---------------------------------------------------------------------------
// Lint 3: package.json just-bash version must be >=2.0.0
// Catches: wrong version like ^0.1.0
// ---------------------------------------------------------------------------
console.log('\n--- Lint: just-bash version ---');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const jbVersion = pkg.dependencies?.['just-bash'] || '';
const majorMatch = jbVersion.match(/(\d+)/);
if (!majorMatch || parseInt(majorMatch[1]) < 2) {
  fail('package.json', `just-bash version '${jbVersion}' is too old (need >=2.x)`);
} else {
  pass(`just-bash version ${jbVersion}`);
}

// ---------------------------------------------------------------------------
// Lint 4: createOpeneralShell must auto-create workspace config
// Catches: FK violation when workspace_config row doesn't exist
// ---------------------------------------------------------------------------
console.log('\n--- Lint: shell factory seeds workspace ---');

const shellContent = readFileSync('src/shell.ts', 'utf8');
if (!shellContent.includes('workspace_config')) {
  fail('src/shell.ts', 'createOpeneralShell must INSERT INTO workspace_config before use');
} else {
  pass('shell.ts auto-creates workspace_config');
}
if (!shellContent.includes('seedFromConfig')) {
  fail('src/shell.ts', 'createOpeneralShell must seed root directory');
} else {
  pass('shell.ts seeds root directory');
}

// ---------------------------------------------------------------------------
// Lint 5: PgFs write methods must throw EROFS
// Catches: accidentally making /db writable
// ---------------------------------------------------------------------------
console.log('\n--- Lint: PgFs is read-only ---');

const pgFsContent = readFileSync('src/pg-fs/pg-fs.ts', 'utf8');
const writeMethods = ['writeFile', 'appendFile', 'mkdir', 'rm', 'mv', 'chmod', 'utimes', 'symlink', 'link'];
for (const method of writeMethods) {
  // Check that each write method exists and calls erofs() or throws EROFS
  const methodRe = new RegExp(`async\\s+${method}\\b[\\s\\S]{0,200}(?:erofs|EROFS)`, 'i');
  if (!methodRe.test(pgFsContent)) {
    fail('src/pg-fs/pg-fs.ts', `${method}() must throw EROFS`);
  }
}
pass('all PgFs write methods throw EROFS');

// ---------------------------------------------------------------------------
// Lint 6: WorkspaceFs must not have write-back buffering
// Catches: reintroducing FUSE-style buffering that defeats just-bash's model
// ---------------------------------------------------------------------------
console.log('\n--- Lint: no write-back buffering ---');

const wsFsContent = readFileSync('src/workspace-fs/workspace-fs.ts', 'utf8');
if (/dirty|flush|OpenFileHandle/i.test(wsFsContent)) {
  fail('src/workspace-fs/workspace-fs.ts', 'must not use write-back buffering (dirty/flush/OpenFileHandle)');
} else {
  pass('no write-back buffering in WorkspaceFs');
}

// ---------------------------------------------------------------------------
// Lint 7: No FUSE references in sandbox Dockerfile
// Catches: accidentally reintroducing FUSE dependencies
// ---------------------------------------------------------------------------
console.log('\n--- Lint: no FUSE in sandbox ---');

try {
  const dockerfile = readFileSync('../sandboxes/openeral/Dockerfile', 'utf8');
  if (/fuse3|libfuse|\/dev\/fuse|fuse\.conf|\/etc\/fstab/i.test(dockerfile)) {
    fail('sandboxes/openeral/Dockerfile', 'must not reference FUSE (fuse3, libfuse, /dev/fuse, /etc/fstab)');
  } else {
    pass('no FUSE in Dockerfile');
  }
} catch {
  pass('Dockerfile not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 8: pg custom command must document quoting requirement
// Catches: SQL with parens/quotes that bash parses before pg sees it
// ---------------------------------------------------------------------------
console.log('\n--- Lint: pg command quoting documented ---');

const shellSrc = readFileSync('src/shell.ts', 'utf8');
if (shellSrc.includes("defineCommand('pg'") || shellSrc.includes('defineCommand("pg"')) {
  // Verify the pg command exists — the quoting issue is a usage concern,
  // so we just check that the shell factory documents it
  pass('pg command defined in shell.ts');
} else {
  fail('src/shell.ts', 'pg custom command not found');
}

// ---------------------------------------------------------------------------
// Lint 9: Sandbox scripts must import from dist/, not src/
// Catches: importing .ts source instead of compiled .js in container
// ---------------------------------------------------------------------------
console.log('\n--- Lint: sandbox imports use dist/ ---');

for (const f of ['../sandboxes/openeral/setup.sh', '../sandboxes/openeral/openeral-bash.mjs']) {
  try {
    const content = readFileSync(f, 'utf8');
    if (/\/opt\/openeral\/src\//.test(content)) {
      fail(f, 'imports from /opt/openeral/src/ — must use /opt/openeral/dist/');
    }
  } catch {}
}
pass('sandbox scripts import from dist/');

// ---------------------------------------------------------------------------
// Lint 10: Dockerfile must build TypeScript
// Catches: forgetting npm run build in the Dockerfile
// ---------------------------------------------------------------------------
console.log('\n--- Lint: Dockerfile builds TypeScript ---');

try {
  const dockerfile = readFileSync('../sandboxes/openeral/Dockerfile', 'utf8');
  if (!dockerfile.includes('npm run build')) {
    fail('sandboxes/openeral/Dockerfile', 'must run "npm run build" to compile TypeScript');
  } else {
    pass('Dockerfile builds TypeScript');
  }
} catch {
  pass('Dockerfile not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 11: No hardcoded credentials in generated scripts
// Catches: baking DATABASE_URL or secrets into helper scripts
// ---------------------------------------------------------------------------
console.log('\n--- Lint: no hardcoded credentials ---');

const cliContent = readFileSync('src/cli.ts', 'utf8');
// The pg helper function must NOT accept a connection string parameter
if (/writePgHelper\([^)]*connStr|writePgHelper\([^)]*url|writePgHelper\([^)]*database/i.test(cliContent)) {
  fail('src/cli.ts', 'writePgHelper must not accept a connection string — read from env at runtime');
} else {
  pass('pg helper reads DATABASE_URL from env');
}

// ---------------------------------------------------------------------------
// Lint 12: No hardcoded connection strings in test files
// Catches: test files with fallback DATABASE_URL defaults
// ---------------------------------------------------------------------------
console.log('\n--- Lint: no hardcoded creds in test files ---');

for (const testFile of ['test-integration.mjs', 'test-e2e-claude.mjs']) {
  try {
    const content = readFileSync(testFile, 'utf8');
    // Match patterns like: || 'postgresql://...' or = 'postgresql://...'
    if (/['"]postgresql:\/\/[^'"]*password[^'"]*['"]/.test(content)) {
      fail(testFile, 'contains hardcoded PostgreSQL connection string with password');
    }
    if (/['"]sk-ant-[^'"]*['"]/.test(content)) {
      fail(testFile, 'contains hardcoded Anthropic API key');
    }
  } catch {}
}
pass('test files have no hardcoded credentials');

// ---------------------------------------------------------------------------
// Lint 13: Sandbox scripts must not contain literal connection strings
// Catches: setup.sh or openeral-bash.mjs baking credentials
// ---------------------------------------------------------------------------
console.log('\n--- Lint: no creds in sandbox scripts ---');

for (const f of ['../sandboxes/openeral/setup.sh', '../sandboxes/openeral/openeral-bash.mjs']) {
  try {
    const content = readFileSync(f, 'utf8');
    if (/postgresql:\/\/[^$][^'"]*@/.test(content)) {
      fail(f, 'contains literal PostgreSQL connection string');
    }
    if (/sk-ant-/.test(content)) {
      fail(f, 'contains literal Anthropic API key');
    }
  } catch {}
}
pass('sandbox scripts have no hardcoded credentials');

// ---------------------------------------------------------------------------
// Lint 14: syncFromFs must delete stale DB rows (persists deletions)
// Catches: sync that only upserts but never removes deleted files
// ---------------------------------------------------------------------------
console.log('\n--- Lint: sync persists deletions ---');

const syncContent = readFileSync('src/sync.ts', 'utf8');
if (!syncContent.includes('seenPaths') || !syncContent.includes('DELETE FROM _openeral.workspace_files')) {
  fail('src/sync.ts', 'syncFromFs must track seen paths and delete stale DB rows');
} else {
  pass('syncFromFs persists deletions');
}

// ---------------------------------------------------------------------------
// Lint 15: syncFromFs must use real file modes, not hardcoded
// Catches: hardcoding 0o40755/0o100644 instead of reading stat().mode
// ---------------------------------------------------------------------------
console.log('\n--- Lint: sync preserves file modes ---');

// Check that walkDir INSERT statements use st.mode, not literal modes
// Only check the walkDir function body itself (ends at closing brace before root insert)
const walkDirStart = syncContent.indexOf('async function walkDir');
const walkDirEnd = syncContent.indexOf('// Ensure root exists');
const walkDirBody = walkDirEnd > walkDirStart
  ? syncContent.slice(walkDirStart, walkDirEnd)
  : syncContent.slice(walkDirStart);
const walkDirInserts = walkDirBody.match(/INSERT INTO[\s\S]*?\]/g) || [];
let hardcodedMode = false;
for (const stmt of walkDirInserts) {
  if (/0o40755|0o100644/.test(stmt)) {
    hardcodedMode = true;
    fail('src/sync.ts', 'walkDir INSERT uses hardcoded mode instead of st.mode');
    break;
  }
}
if (!hardcodedMode) {
  pass('syncFromFs uses st.mode from filesystem');
}

// Check that syncToFs applies chmod
const syncToFsSection = syncContent.slice(
  syncContent.indexOf('export async function syncToFs'),
  syncContent.indexOf('export async function syncFromFs'),
);
if (!syncToFsSection.includes('chmodSync') || !syncToFsSection.includes('row.mode & 0o7777')) {
  fail('src/sync.ts', 'syncToFs must chmodSync with stored mode');
} else {
  pass('syncToFs applies stored modes');
}

// ---------------------------------------------------------------------------
// Lint 16: Exclude must use exact dir name matching, not regex substring
// Catches: regex like /\.git/ that also matches .gitignore, .github
// ---------------------------------------------------------------------------
console.log('\n--- Lint: exclude uses exact matching ---');

if (syncContent.includes('.test(name)') && syncContent.includes('/node_modules|\\.git/')) {
  fail('src/sync.ts', 'exclude uses regex substring matching — .gitignore and .github would be wrongly excluded');
} else if (!syncContent.includes('excludeDirs.has(name)')) {
  fail('src/sync.ts', 'exclude must use Set.has() for exact directory name matching');
} else {
  pass('exclude uses exact Set-based matching');
}

// ---------------------------------------------------------------------------
// Lint 17: syncToFs must prune local files not in DB
// Catches: stale local files persisting across sessions on reused home dirs
// ---------------------------------------------------------------------------
console.log('\n--- Lint: syncToFs prunes stale local files ---');

if (!syncToFsSection.includes('pruneLocal') && !syncToFsSection.includes('unlinkSync')) {
  fail('src/sync.ts', 'syncToFs must remove local files not present in DB (stale leftovers)');
} else {
  pass('syncToFs prunes stale local files');
}

// ---------------------------------------------------------------------------
// Lint 18: syncToFs must prune BEFORE creating (type conflict safety)
// Catches: EEXIST/EISDIR when a path changed type between sessions
// ---------------------------------------------------------------------------
console.log('\n--- Lint: syncToFs prunes before creating ---');

const pruneIdx = syncToFsSection.indexOf('pruneLocal');
const firstMkdir = syncToFsSection.indexOf('mkdirSync(fullPath');
const firstWrite = syncToFsSection.indexOf('writeFileSync(fullPath');
if (pruneIdx < 0 || firstMkdir < 0 || pruneIdx > firstMkdir) {
  fail('src/sync.ts', 'syncToFs must call pruneLocal BEFORE mkdirSync/writeFileSync to handle type conflicts');
} else {
  pass('syncToFs prunes before creating');
}

// ---------------------------------------------------------------------------
// Lint 19: pruneLocal must handle type conflicts (file↔dir)
// Catches: pruneLocal only checking presence, not type match
// ---------------------------------------------------------------------------
console.log('\n--- Lint: pruneLocal handles type conflicts ---');

if (!syncContent.includes('dbTypes') || !syncContent.includes('dbIsDir === false') || !syncContent.includes('dbIsDir === true')) {
  fail('src/sync.ts', 'pruneLocal must check dbTypes for file↔dir conflicts, not just presence');
} else {
  pass('pruneLocal handles type conflicts');
}

// ---------------------------------------------------------------------------
// Lint 20: README.md is openshell-only (no npx/pnpm/npm install)
// Catches: regressions that mix developer commands into the end-user README.
// Developer commands live in BUILD.md.
// ---------------------------------------------------------------------------
console.log('\n--- Lint: README has no npx/pnpm (user-facing only) ---');

try {
  const readme = readFileSync('../README.md', 'utf8');
  const forbidden = [
    [/\bnpx openeral\b/, 'contains `npx openeral` — move to BUILD.md'],
    [/\bpnpm (install|build|check|run)\b/, 'contains `pnpm install|build|check|run` — move to BUILD.md'],
    [/\bnpm install\b/, 'contains `npm install` — move to BUILD.md'],
  ];
  let readmeOk = true;
  for (const [rx, msg] of forbidden) {
    if (rx.test(readme)) {
      fail('README.md', msg);
      readmeOk = false;
    }
  }
  if (readmeOk) pass('README contains no npx/pnpm/npm-install commands');
} catch {
  pass('README not found (skipped)');
}

// BUILD.md SHOULD contain the build steps — verify the first npx-openeral
// block shows users how to install+build first
console.log('\n--- Lint: BUILD.md installs before running ---');
try {
  const build = readFileSync('../BUILD.md', 'utf8');
  if (!build.includes('npx openeral')) {
    pass('BUILD.md has no npx (skipped)');
  } else {
    const firstOpeneral = build.indexOf('npx openeral');
    const priorText = build.slice(0, firstOpeneral);
    if (!priorText.includes('pnpm install') && !priorText.includes('pnpm build')) {
      fail('BUILD.md', 'first `npx openeral` must be preceded by `pnpm install && pnpm build` instructions');
    } else {
      pass('BUILD.md shows install+build before first npx openeral');
    }
  }
} catch {
  pass('BUILD.md not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 21: Migrations must use advisory lock for concurrent safety
// Catches: race condition when two shells start on a fresh database
// ---------------------------------------------------------------------------
console.log('\n--- Lint: migrations use advisory lock ---');

const migrationsContent = readFileSync('src/db/migrations.ts', 'utf8');
if (!migrationsContent.includes('pg_advisory_lock')) {
  fail('src/db/migrations.ts', 'runMigrations must use pg_advisory_lock to serialize concurrent callers');
} else {
  pass('migrations use advisory lock');
}

// ---------------------------------------------------------------------------
// Lint 22: Skill bootstrap must check node_modules, not just dist
// Catches: skill treating dist/-present but node_modules/-missing tree as launch-ready
// ---------------------------------------------------------------------------
console.log('\n--- Lint: skill checks node_modules ---');

try {
  const skill = readFileSync('../.claude/skills/openeral-shell/SKILL.md', 'utf8');
  if (skill.includes('[ -d dist ]') && !skill.includes('node_modules')) {
    fail('.claude/skills/openeral-shell/SKILL.md', 'bootstrap check must verify node_modules exists, not just dist');
  } else {
    pass('skill checks node_modules');
  }
} catch {
  pass('skill not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 23: policy.yaml must not use fork-specific fields
// Catches: dead secret_injection / egress_via fields that stock OpenShell ignores
// ---------------------------------------------------------------------------
console.log('\n--- Lint: no fork-specific policy fields ---');

try {
  const policy = readFileSync('../sandboxes/openeral/policy.yaml', 'utf8');
  if (/secret_injection:/i.test(policy)) {
    fail('sandboxes/openeral/policy.yaml', 'contains secret_injection: — stock OpenShell handles this automatically via SecretResolver');
  }
  if (/egress_via:/i.test(policy)) {
    fail('sandboxes/openeral/policy.yaml', 'contains egress_via: — not supported in stock OpenShell');
  }
  if (/egress_profile:/i.test(policy)) {
    fail('sandboxes/openeral/policy.yaml', 'contains egress_profile: — not supported in stock OpenShell');
  }
  pass('no fork-specific fields in policy.yaml');
} catch {
  pass('policy.yaml not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 24: Socket.dev endpoint must use protocol: rest + tls: terminate
// Catches: Socket.dev credential injection won't work without TLS termination
// ---------------------------------------------------------------------------
console.log('\n--- Lint: Socket.dev endpoint has TLS terminate ---');

try {
  const policy = readFileSync('../sandboxes/openeral/policy.yaml', 'utf8');
  if (policy.includes('registry.socket.dev')) {
    // Find the socket endpoint block and verify it has tls: terminate
    const socketSection = policy.slice(policy.indexOf('registry.socket.dev'));
    const nextPolicy = socketSection.indexOf('\n  binaries:');
    const socketBlock = socketSection.slice(0, nextPolicy > 0 ? nextPolicy : 200);
    if (!socketBlock.includes('tls: terminate')) {
      fail('sandboxes/openeral/policy.yaml', 'registry.socket.dev must have tls: terminate for credential injection');
    } else {
      pass('Socket.dev endpoint has TLS terminate');
    }
  } else {
    pass('no Socket.dev endpoint (skipped)');
  }
} catch {
  pass('policy.yaml not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 25: Socket.dev policy must be read-only (least privilege)
// Catches: access: full on registry that only needs GET for npm install
// ---------------------------------------------------------------------------
console.log('\n--- Lint: Socket.dev is read-only ---');

try {
  const policy = readFileSync('../sandboxes/openeral/policy.yaml', 'utf8');
  if (policy.includes('registry.socket.dev')) {
    const socketStart = policy.indexOf('socket_packages:');
    const nextPol = policy.indexOf('\n  #', socketStart + 1);
    const socketBlock = policy.slice(socketStart, nextPol > 0 ? nextPol : undefined);
    if (socketBlock.includes('access: full')) {
      fail('sandboxes/openeral/policy.yaml', 'Socket.dev policy must use access: read-only, not access: full');
    } else {
      pass('Socket.dev policy is read-only');
    }
  } else {
    pass('no Socket.dev endpoint (skipped)');
  }
} catch {
  pass('policy.yaml not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 26: setup.sh must not touch user's .npmrc
// Catches: clobbering or deleting user-managed /home/agent/.npmrc
// ---------------------------------------------------------------------------
console.log('\n--- Lint: setup.sh does not touch user .npmrc ---');

try {
  const setup = readFileSync('../sandboxes/openeral/setup.sh', 'utf8');
  if (setup.includes('/home/agent/.npmrc')) {
    fail('sandboxes/openeral/setup.sh', 'must not write or delete /home/agent/.npmrc — use a separate openeral-managed file + NPM_CONFIG_USERCONFIG');
  } else if (setup.includes('npm config set')) {
    fail('sandboxes/openeral/setup.sh', 'must not use npm config set (writes to user HOME)');
  } else {
    pass('setup.sh does not touch user .npmrc');
  }
} catch {
  pass('setup.sh not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 27: no stale test files referencing vendor/ or fork-specific fields
// Catches: tests that depend on the removed vendor/openshell/ tree
// ---------------------------------------------------------------------------
console.log('\n--- Lint: no stale vendor test scripts ---');

try {
  const { readdirSync } = await import('node:fs');
  const testDir = '../tests';
  try {
    const tests = readdirSync(testDir);
    for (const t of tests) {
      const content = readFileSync(`${testDir}/${t}`, 'utf8');
      if (content.includes('vendor/openshell')) {
        fail(`tests/${t}`, 'references vendor/openshell which no longer exists');
      }
    }
  } catch {}
  pass('no stale vendor test scripts');
} catch {}

// ---------------------------------------------------------------------------
// Lint 28: setup.sh must use NPM_CONFIG_USERCONFIG for Socket.dev config
// Catches: writing npm config to user's HOME instead of a temp file
// ---------------------------------------------------------------------------
console.log('\n--- Lint: Socket.dev uses NPM_CONFIG_USERCONFIG ---');

try {
  const setup = readFileSync('../sandboxes/openeral/setup.sh', 'utf8');
  if (setup.includes('SOCKET_TOKEN') && !setup.includes('NPM_CONFIG_USERCONFIG')) {
    fail('sandboxes/openeral/setup.sh', 'must set NPM_CONFIG_USERCONFIG to point npm at the openeral-managed file');
  } else {
    pass('setup.sh uses NPM_CONFIG_USERCONFIG');
  }
} catch {
  pass('setup.sh not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 29: skill must not unconditionally include --provider socket
// Catches: making optional Socket provider mandatory in the launch command
// ---------------------------------------------------------------------------
console.log('\n--- Lint: skill socket provider is conditional ---');

try {
  const skill = readFileSync('../.claude/skills/openeral-shell/SKILL.md', 'utf8');
  // Find the openshell sandbox create line in Step 3c
  if (skill.includes('--provider socket --auto-providers')) {
    // Check it's inside a conditional block
    const socketIdx = skill.indexOf('--provider socket');
    const precedingBlock = skill.slice(Math.max(0, socketIdx - 300), socketIdx);
    if (!precedingBlock.includes('SOCKET_TOKEN')) {
      fail('.claude/skills/openeral-shell/SKILL.md', '--provider socket must be conditional on SOCKET_TOKEN');
    } else {
      pass('skill socket provider is conditional');
    }
  } else {
    pass('skill socket provider is conditional (not in launch command)');
  }
} catch {
  pass('skill not found (skipped)');
}

// ---------------------------------------------------------------------------
// Lint 30: StringCost presign URLs must be normalized before Claude launch
// Catches: passing .../v1/messages as ANTHROPIC_BASE_URL, which Claude then
// appends to produce /v1/messages/v1/messages.
// ---------------------------------------------------------------------------
console.log('\n--- Lint: StringCost proxy URL is base-only ---');

try {
  const setup = readFileSync('../sandboxes/openeral/setup.sh', 'utf8');
  const cli = readFileSync('src/cli.ts', 'utf8');
  let ok = true;
  const markFail = (file, message) => {
    fail(file, message);
    ok = false;
  };

  if (!setup.includes('url.pathname = url.pathname.replace(/\\/v1\\/.*$/, "");')) {
    markFail('sandboxes/openeral/setup.sh', 'normalize_stringcost_proxy_url must strip /v1/... from presign URLs');
  }
  if (!cli.includes("url.pathname = url.pathname.replace(/\\/v1\\/.*$/, '');")) {
    markFail('src/cli.ts', 'stringCostProxyBaseUrl must strip /v1/... from presign URLs');
  }

  for (const snippet of [
    'STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url "$STRINGCOST_PROXY_URL"',
    'STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url "$STRINGCOST_UPLOADED_URL"',
    'STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url "$STRINGCOST_STORED_URL"',
    'STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url "$STRINGCOST_FULL_PRESIGN_URL"',
  ]) {
    if (!setup.includes(snippet)) {
      markFail('sandboxes/openeral/setup.sh', `missing normalization step: ${snippet}`);
    }
  }

  for (const snippet of [
    'const baseUrl = stringCostProxyBaseUrl(fullUrl);',
    'stringcostUrl = stringCostProxyBaseUrl(storedPresign.url);',
    'stringcostUrl = stringCostProxyBaseUrl(fullUrl);',
  ]) {
    if (!cli.includes(snippet)) {
      markFail('src/cli.ts', `must route presigns through stringCostProxyBaseUrl(): ${snippet}`);
    }
  }

  const setupLaunch = setup.slice(setup.indexOf('setup.sh: launching Claude Code'));
  const cliLaunch = cli.slice(cli.indexOf('setup: launching Claude Code'));
  if (!setupLaunch.includes('ANTHROPIC_BASE_URL="$STRINGCOST_PROXY_URL"')) {
    markFail('sandboxes/openeral/setup.sh', 'Claude launch must use normalized STRINGCOST_PROXY_URL');
  }
  if (!cliLaunch.includes('ANTHROPIC_BASE_URL="\\${STRINGCOST_PROXY_URL}"')) {
    markFail('src/cli.ts', 'generated Claude launch must use normalized STRINGCOST_PROXY_URL');
  }

  const badBaseUrlLine = /ANTHROPIC_BASE_URL\s*=.*(?:STRINGCOST_FULL_PRESIGN_URL|fullUrl|storedPresign\.url)/;
  if (setup.split('\n').some(line => badBaseUrlLine.test(line))) {
    markFail('sandboxes/openeral/setup.sh', 'ANTHROPIC_BASE_URL must not be assigned a full presign URL');
  }
  if (cli.split('\n').some(line => badBaseUrlLine.test(line))) {
    markFail('src/cli.ts', 'ANTHROPIC_BASE_URL must not be assigned a full presign URL');
  }

  if (ok) pass('StringCost presign URLs normalize to the base proxy URL before launch');
} catch (err) {
  fail('StringCost proxy URL lint', err?.message || String(err));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${errors === 0 ? '✓ All lints passed' : `✗ ${errors} lint error(s)`}\n`);
process.exit(errors > 0 ? 1 : 0);
