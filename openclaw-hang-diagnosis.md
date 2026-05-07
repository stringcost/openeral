# OpenClaw Hang Issue - Diagnostic Report

## Problem Summary

OpenClaw successfully launches and shows the TUI (Text User Interface), but when you type messages like "hi", the agent doesn't respond and appears to hang indefinitely. Claude Code works fine in the same environment.

## Observed Behavior

From your logs:
```
openclaw tui - local embedded - agent main - session main
session agent:main:main
local ready | cleared input; press ctrl+c again to exit
agent main | session main | anthropic/claude-sonnet-4-6 | think adaptive | tokens ?/200k
```

After this point, when you type "hi" or any message, nothing happens — the agent doesn't respond.

## Root Cause Analysis

Two confirmed root causes have been identified and fixed:

### 1. **Plugin Loader Hot Loop — PRIMARY HANG CAUSE** (fixed in commit 177b9b3)

`OPENCLAW_PLUGIN_STAGE_DIR` was forwarded to the exec'd openclaw TUI/client process.
When the client sees this variable it runs its own bundled-dep staging loop on every
keystroke, saturating the Node.js event loop and making the terminal completely
unresponsive to keyboard input.

**Fix:** setup.sh now explicitly unsets it before launching the TUI:
```bash
# OPENCLAW_PLUGIN_STAGE_DIR is intentionally NOT forwarded: it is for the
# gateway process only. Passing it to the TUI/client process causes openclaw
# to run its own plugin staging loop on startup, which saturates the Node.js
# event loop and makes the terminal completely unresponsive to keyboard input.
exec env -u STRINGCOST_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY \
  -u OPENCLAW_PLUGIN_STAGE_DIR \
  HOME=/home/agent \
  SHELL=/usr/local/bin/openeral-bash \
  PATH="$PATH" \
  openclaw "$@"
```

### 2. **Reconnect HOME Mismatch** (fixed in commit 177b9b3)

The `HOME=/home/agent` bashrc patch was inside the StringCost `if`-block, so sandboxes
without StringCost never got it. On reconnect (`openshell sandbox connect`), openclaw
could not find its config or gateway auth token because `HOME` pointed at `/sandbox`
instead of `/home/agent`.

**Fix:** the patch now runs unconditionally:
```bash
# Always patch the connect shell's .bashrc so reconnect sessions use the correct HOME
if [ "$SANDBOX_USER_HOME" != "/home/agent" ] && [ -n "$SANDBOX_USER_HOME" ]; then
  CONNECT_BASHRC="$SANDBOX_USER_HOME/.bashrc"
  if ! grep -q 'openeral-connect' "$CONNECT_BASHRC" 2>/dev/null; then
    printf '\n# openeral-connect: set agent HOME for sandbox connect sessions\nexport HOME=/home/agent\n[ -f /home/agent/.openeral/env.sh ] && . /home/agent/.openeral/env.sh\n' \
      >> "$CONNECT_BASHRC"
  fi
fi
```

### 3. **API Key Missing or Is an OpenShell Placeholder** (silent hang on first API call)

OpenClaw's Node.js gateway calls the Anthropic API directly — it cannot use
`openshell:resolve:env:*` placeholder strings that the HTTP proxy resolves for
Claude Code's binary. If `ANTHROPIC_API_KEY` is absent OR is a placeholder, every
API call hangs indefinitely with no error shown in the TUI.

setup.sh detects this and warns (but still launches):
```bash
_openclaw_key_ok=false
case "${ANTHROPIC_API_KEY:-}" in
  ''|openshell:resolve:env:*) ;;          # empty OR placeholder — not usable
  *) _openclaw_key_ok=true ;;
esac
if [ -z "${STRINGCOST_PROXY_URL:-}" ] && [ "$_openclaw_key_ok" = "false" ]; then
  echo "setup.sh: WARNING: OpenClaw has no usable API credentials." >&2
  echo "setup.sh:   ANTHROPIC_API_KEY is missing or is an OpenShell placeholder that" >&2
  echo "setup.sh:   OpenClaw's gateway cannot resolve. Responses will hang." >&2
  echo "setup.sh:   Fix A — upload a real key file before creating the sandbox:" >&2
  echo "setup.sh:     echo 'sk-ant-...' > /tmp/anthropic-api-key" >&2
  echo "setup.sh:     openshell sandbox create --upload /tmp/anthropic-api-key:/sandbox/anthropic-api-key ..." >&2
  echo "setup.sh:   Fix B — set STRINGCOST_API_KEY so setup.sh can create a presign automatically." >&2
fi
```

Note: the condition catches BOTH an absent key AND a placeholder value — not just an
empty key. This is the most common case: the key is "set" but is an unresolvable
placeholder string.

### 4. **Gateway Communication Timeout**

The gateway handshake timeout is set to 30 s and also exported as an env var:
```bash
setsid env OPENCLAW_SKIP_ONBOARDING=1 OPENCLAW_HANDSHAKE_TIMEOUT_MS=30000 \
  HOME=/home/agent openclaw gateway --port 18789 --allow-unconfigured \
  </dev/null >/tmp/openclaw-gateway.log 2>&1 &
```
Also written to `~/.openclaw/openclaw.json`:
```javascript
if (!config.gateway.handshakeTimeoutMs) config.gateway.handshakeTimeoutMs = 30000;
```
If the gateway is slow to respond or the WebSocket connection is unstable, messages
can timeout silently.

### 5. **StringCost Proxy Misconfiguration**

If `STRINGCOST_PROXY_URL` is set but the token has expired or the network is
unreachable, API calls fail silently:
- The proxy URL might be malformed
- The presign token might be expired
- Network connectivity to StringCost might be blocked

## Diagnostic Steps

### Step 1: Check whether the two confirmed hangs are fixed

Verify you're running a build with commit 177b9b3 or later. In a running sandbox:
```bash
# Plugin staging: this variable must NOT be set for the TUI process
echo "OPENCLAW_PLUGIN_STAGE_DIR=${OPENCLAW_PLUGIN_STAGE_DIR:-NOT SET}"
# Should print: OPENCLAW_PLUGIN_STAGE_DIR=NOT SET

# HOME: must be /home/agent, not /sandbox
echo "HOME=$HOME"
# Should print: HOME=/home/agent
```

### Step 2: Check API Key Configuration

```bash
# Check if ANTHROPIC_API_KEY is set and is a real value (not a placeholder)
echo "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-NOT SET}"

# A placeholder looks like: openshell:resolve:env:ANTHROPIC_API_KEY
# OpenClaw's gateway cannot use placeholders — only real sk-ant-... values work

# Check StringCost proxy
echo "STRINGCOST_PROXY_URL: ${STRINGCOST_PROXY_URL:-NOT SET}"

# Check what credentials OpenClaw is actually using
cat ~/.openclaw/openclaw.json | grep -A 5 '"env"'
```

### Step 3: Check Gateway Logs

```bash
# View gateway logs for errors
tail -100 /tmp/openclaw-gateway.log

# Check if gateway is responding via /readyz (NOT just TCP)
# TCP opens before the WebSocket RPC layer is live — /readyz confirms full readiness
curl -v http://127.0.0.1:18789/readyz
```

### Step 4: Test API Connectivity

```bash
# Test if the API key works (if not using StringCost)
curl -X POST https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 10,
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

## Solutions

### Solution 1: Rebuild / Update to Latest (Fixes Confirmed Hangs)

The plugin staging hot loop and HOME mismatch are fully fixed in commit 177b9b3.
Rebuild the sandbox image:
```bash
docker build -f sandboxes/openeral/Dockerfile -t openeral-sandbox:dev .
```
Then relaunch:
```bash
npx openeral --dev
```

### Solution 2: Fix API Key (Primary Fix for Credential Hangs)

Before creating the sandbox, upload a real key as a file (not an env var):
```bash
# Write your real key to a file
echo 'sk-ant-...' > /tmp/anthropic-api-key

# Upload it when creating the sandbox
openshell sandbox create --upload /tmp/anthropic-api-key:/sandbox/anthropic-api-key ...
```

setup.sh reads it at `/sandbox/anthropic-api-key` and writes the real value into
`~/.openclaw/openclaw.json`, bypassing the placeholder resolution problem entirely.

### Solution 3: Use StringCost Proxy (Alternative)

If you have a StringCost account:
```bash
export ANTHROPIC_API_KEY='sk-ant-...'
export STRINGCOST_API_KEY='your-stringcost-key'

# setup.sh will create a presign automatically and configure openclaw to use it
npx openeral --agent openclaw
```

### Solution 4: Restart the Gateway (for gateway crashes)

If the gateway crashes after setup, restart it with the full production command
(missing any of these flags causes subtle failures):
```bash
# setsid: prevents SIGHUP from killing gateway when TUI exits
# OPENCLAW_SKIP_ONBOARDING=1: skip interactive wizard (config already written)
# OPENCLAW_HANDSHAKE_TIMEOUT_MS=30000: lengthen WS handshake for cold containers
# HOME=/home/agent: ensures gateway reads config from the right directory
setsid env OPENCLAW_SKIP_ONBOARDING=1 OPENCLAW_HANDSHAKE_TIMEOUT_MS=30000 \
  HOME=/home/agent openclaw gateway --port 18789 --allow-unconfigured \
  </dev/null >/tmp/openclaw-gateway.log 2>&1 &
echo $! > /tmp/openclaw-gateway.pid
```

After the gateway starts and writes its auth token to `openclaw.json`, re-apply
credentials (the gateway modifies the config during startup):
```bash
# Re-apply auth credentials after gateway finishes its own config modifications
HOME=/home/agent node -e "
const fs = require('fs');
const file = process.env.HOME + '/.openclaw/openclaw.json';
let config = {};
try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (!config.env) config.env = {};
// Set your credentials here
config.env.ANTHROPIC_API_KEY = 'sk-ant-...';
fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log('done');
"
# Wait for /readyz again before launching TUI
until curl -fsS http://127.0.0.1:18789/readyz >/dev/null 2>&1; do sleep 1; done
```

### Solution 5: Debug Mode

Run OpenClaw with debug logging:
```bash
DEBUG=* openclaw
```

## Verification

After applying fixes, verify all of the following:

1. **Plugin staging variable is absent:**
   ```bash
   echo "${OPENCLAW_PLUGIN_STAGE_DIR:-NOT SET}"   # Must be: NOT SET
   ```

2. **HOME is correct:**
   ```bash
   echo "$HOME"   # Must be: /home/agent
   ```

3. **Gateway is healthy (use /readyz, not TCP):**
   ```bash
   curl http://127.0.0.1:18789/readyz
   # Should return: OK
   ```

4. **Config has real (non-placeholder) credentials:**
   ```bash
   cat ~/.openclaw/openclaw.json | grep -A 5 '"env"'
   # ANTHROPIC_API_KEY should be sk-ant-... OR ANTHROPIC_BASE_URL should be a StringCost URL
   ```

5. **Test a simple message:**
   - Launch OpenClaw
   - Type "hi"
   - Should see a response within 5–10 seconds

## Why This Doesn't Happen with Claude Code

| Aspect | Claude Code | OpenClaw |
|--------|-------------|----------|
| **Architecture** | Single process | Gateway + Client (2 processes) |
| **Credential Resolution** | Binary patched by OpenShell to resolve `openshell:resolve:env:*` | Node.js gateway calls Anthropic SDK directly — cannot resolve placeholders |
| **Placeholder Support** | Yes (proxy resolves them) | No (sends placeholder raw to Anthropic → rejected) |
| **Failure Mode** | Routes through StringCost proxy, auth managed by proxy | Hangs silently on first API call with no error in TUI |
| **Plugin staging** | N/A | Must be isolated to gateway process only; leaking to TUI causes event-loop saturation |

## Fixed Root Causes (Summary)

1. **Plugin loader hot loop** (commit 177b9b3) — `OPENCLAW_PLUGIN_STAGE_DIR` unset with `-u` before exec
2. **Reconnect HOME mismatch** (commit 177b9b3) — `HOME=/home/agent` bashrc patch moved outside StringCost if-block
3. **Gateway SIGHUP** (commit 02b6c5d) — `setsid` prevents gateway from dying when TUI is closed
4. **API key placeholder** (existing code) — credential check catches both empty AND `openshell:resolve:env:*` values
