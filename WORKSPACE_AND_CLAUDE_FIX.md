# Workspace Name and Claude CLI Fix

## Problems Fixed

### 1. Kubernetes Name Validation Error
**Error:**
```
Sandbox.agents.x-k8s.io "JARVIS" is invalid: metadata.name: Invalid value: "JARVIS": 
a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, 
'-' or '.', and must start and end with an alphanumeric character
```

**Cause:** Kubernetes resource names must be lowercase and follow RFC 1123 subdomain rules, but the workspace ID was using the hostname (e.g., "JARVIS") which could be uppercase.

### 2. Claude CLI Not Available
**Issue:** The sandbox didn't have Claude CLI installed, causing the setup to fail when trying to run Claude Code.

### 3. Inconsistent Default Workspace Name
**Issue:** Using hostname as default made workspace names unpredictable and potentially invalid for Kubernetes.

## Solutions Implemented

### 1. Workspace Name Normalization
Added automatic normalization of workspace IDs to be Kubernetes-compliant:

```typescript
// Normalize workspace ID to be Kubernetes-compliant (lowercase, alphanumeric + hyphens)
workspaceId = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
```

**Rules:**
- Convert to lowercase
- Replace non-alphanumeric characters (except hyphens) with hyphens
- Remove leading/trailing hyphens
- Examples:
  - `JARVIS` → `jarvis`
  - `My_Workspace` → `my-workspace`
  - `test.workspace.123` → `test-workspace-123`

### 2. Changed Default Workspace Name
Changed from `hostname()` to `'openeral-claude'`:

```typescript
let workspaceId = process.env.OPENERAL_WORKSPACE_ID || 'openeral-claude';
```

**Benefits:**
- Predictable and consistent
- Always Kubernetes-compliant
- Descriptive of the purpose
- Easy to remember

### 3. Automatic Claude CLI Installation
Added `ensureClaudeInSandbox()` function that:

1. **Checks if Claude is installed:**
   - Creates a temporary sandbox
   - Runs `command -v claude` to check availability
   - Cleans up the temporary sandbox

2. **Installs Claude if missing:**
   - Creates another temporary sandbox
   - Runs `npm install -g @anthropic-ai/claude-cli`
   - Verifies installation success
   - Cleans up the temporary sandbox

3. **Handles errors gracefully:**
   - Shows warning if installation fails
   - Provides manual installation instructions
   - Continues with sandbox creation

**Flow:**
```
Check Claude → Not found → Install → Verify → Continue
              ↓ Found
              Continue
```

## Changes Made

### `openeral-js/src/cli.ts`

1. **Removed hostname import:**
   ```typescript
   - import { hostname } from 'node:os';
   ```

2. **Updated default workspace ID:**
   ```typescript
   - let workspaceId = process.env.OPENERAL_WORKSPACE_ID || hostname();
   + let workspaceId = process.env.OPENERAL_WORKSPACE_ID || 'openeral-claude';
   ```

3. **Added workspace name normalization:**
   ```typescript
   workspaceId = workspaceId.toLowerCase()
     .replace(/[^a-z0-9-]/g, '-')
     .replace(/^-+|-+$/g, '');
   ```

4. **Added `ensureClaudeInSandbox()` function:**
   - Checks Claude availability
   - Installs if missing
   - Provides user feedback

5. **Updated help text:**
   - Changed default from "hostname" to "openeral-claude"
   - Added note about name normalization
   - Added note about automatic Claude installation

6. **Updated documentation:**
   - Added features list
   - Documented normalization behavior
   - Updated environment variable descriptions

## User Experience

### Before
```bash
$ npx openeral
openeral: workspace  JARVIS
...
Error: Sandbox.agents.x-k8s.io "JARVIS" is invalid: metadata.name: Invalid value: "JARVIS"
```

### After
```bash
$ npx openeral
openeral: workspace  openeral-claude
openeral: starting OpenShell gateway...
✓ Gateway ready
openeral: checking Claude CLI availability...
✓ Claude CLI available
openeral: launching Claude Code in OpenShell sandbox (openeral-claude)...
```

### With Custom Workspace (Uppercase)
```bash
$ npx openeral --workspace MyProject
openeral: workspace  myproject
...
```

### Claude Not Installed
```bash
$ npx openeral
openeral: workspace  openeral-claude
...
openeral: checking Claude CLI availability...
openeral: Claude CLI not found, installing...
✓ Claude CLI installed
openeral: launching Claude Code in OpenShell sandbox (openeral-claude)...
```

## Testing

### Test Workspace Name Normalization
```bash
# Test uppercase
npx openeral --workspace MYWORKSPACE
# Expected: workspace name = myworkspace

# Test special characters
npx openeral --workspace "My_Project.123"
# Expected: workspace name = my-project-123

# Test default
npx openeral
# Expected: workspace name = openeral-claude
```

### Test Claude Installation
```bash
# With Claude already installed
npx openeral
# Expected: "✓ Claude CLI available"

# With Claude not installed (use fresh sandbox image)
npx openeral
# Expected: "openeral: Claude CLI not found, installing..."
#           "✓ Claude CLI installed"
```

## Configuration

### Environment Variables

**OPENERAL_WORKSPACE_ID**
- Default: `openeral-claude`
- Will be normalized to lowercase and Kubernetes-compliant format
- Example: `export OPENERAL_WORKSPACE_ID="my-project"`

**ANTHROPIC_API_KEY**
- Required for Claude CLI to work
- Example: `export ANTHROPIC_API_KEY="sk-ant-..."`

**DATABASE_URL**
- Required for openeral database operations
- Example: `export DATABASE_URL="postgresql://..."`

## Future Improvements

1. **Cache Claude installation:** Store installed Claude in a persistent volume to avoid reinstalling
2. **Parallel checks:** Check Claude availability while gateway is starting
3. **Version management:** Allow specifying Claude CLI version
4. **Offline mode:** Support pre-built images with Claude already installed
5. **Better error messages:** Provide more context when Claude installation fails
6. **Workspace templates:** Allow predefined workspace configurations
