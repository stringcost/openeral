# OpenEral sandbox — persistent /home/agent + read-only /db via just-bash
#
# Uses stock OpenShell (no custom cluster or gateway images needed).
# All filesystem virtualization happens in userspace via openeral-js.

FROM ghcr.io/nvidia/openshell-community/sandboxes/base:latest

USER root

# Node.js 22 LTS via NodeSource (apt nodejs conflicts with npm on Ubuntu Noble)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# OpenClaw — baked into the image so the sandbox doesn't reinstall on every launch.
# SHARP_IGNORE_GLOBAL_LIBVIPS=1 skips the sharp native postinstall, which would
# otherwise try to pull GitHub release assets (blocked in some CI environments).
#
# Pinned to 2026.4.29 — earlier 2026.4.24–2026.4.26 releases had a Docker regression
# where the embedded gateway never became healthy.
RUN SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g --loglevel=error openclaw@2026.4.29 \
    && chmod -R a+rX /usr/lib/node_modules/openclaw

# Pre-stage OpenClaw's TUI plugin-runtime-deps AND pre-warm the V8 bytecode
# compile cache at image-build time so end users don't pay the multi-minute
# cold-start latency on first prompt.
#
# Why this is needed:
#   1. OpenClaw lazy-loads its TUI plugins on first agent interaction. Some of
#      those plugins declare deps as `git+ssh://git@github.com/…` (e.g.
#      whiskeysockets/libsignal-node), which the OpenShell sandbox policy blocks
#      at the network layer. The user-visible symptom is a ~10 min hang on the
#      very first "hi" and subsequent npm error 128 failures.
#   2. OpenClaw is huge (74 MB unpacked, 9309 files) and lazy-loads most of
#      itself on the first agent message. The gateway's own embedded-run trace
#      shows ~54 s of synchronous CPU on first prompt:
#        model-resolution:6.8s, auth:4.1s, core-plugin-tools:14.1s,
#        system-prompt:8.7s, stream-setup:9.0s, attempt-dispatch:7.7s
#      OpenClaw doctor flags this directly: "NODE_COMPILE_CACHE points to /tmp;
#      use /var/tmp so cache survives reboots." We can't use /var/tmp (sandbox
#      policy makes /tmp the only writable scratch path), but /opt is writable
#      at build time and we can bake the V8 bytecode cache there, then seed it
#      to /tmp on every sandbox launch — same effect.
#
# Steps:
#   1. Rewrite git+ssh GitHub URLs to https (same as setup.sh).
#   2. Run `openclaw status --deep` with NODE_COMPILE_CACHE pointing at
#      /opt/openclaw-compile-cache. Forces plugin discovery + dependency
#      resolution AND populates the V8 bytecode cache for the status/health
#      code path.
#   3. Run a handful of other openclaw subcommands (models list, plugins list,
#      infer model list) to broaden cache coverage. These all share most of
#      openclaw's bootstrap code path.
#   4. Write a fake auth profile via non-interactive `openclaw onboard`, then
#      run `openclaw agent --local`. --local preloads the plugin registry and
#      runs the embedded agent in-process, exercising the exact pipeline the
#      gateway trace flagged — model-resolution, auth, core-plugin-tools,
#      system-prompt, stream-setup. The Anthropic API call fails (fake key) but
#      every module loaded up to that point gets JIT-compiled and the bytecode
#      lands in /opt/openclaw-compile-cache.
#   5. Copy plugin-runtime-deps to /opt/openclaw-plugin-cache (existing logic).
#   6. Make /opt/openclaw-compile-cache world-readable so the sandbox user can
#      seed it at runtime.
RUN set -e \
 && mkdir -p /tmp/openclaw-bootstrap /opt/openclaw-compile-cache \
 && HOME=/tmp/openclaw-bootstrap git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/" \
 && HOME=/tmp/openclaw-bootstrap git config --global --add url."https://github.com/".insteadOf "git@github.com:" \
 && HOME=/tmp/openclaw-bootstrap git config --global --add url."https://github.com/".insteadOf "git+ssh://git@github.com/" \
 && HOME=/tmp/openclaw-bootstrap git config --global http.sslVerify false \
 && export HOME=/tmp/openclaw-bootstrap \
           NODE_COMPILE_CACHE=/opt/openclaw-compile-cache \
           GIT_SSL_NO_VERIFY=true \
           npm_config_strict_ssl=false \
           OPENCLAW_NO_RESPAWN=1 \
           OPENCLAW_SKIP_ONBOARDING=1 \
 # 1. status --deep: forces plugin discovery + npm-via-git deps; primes most
 #    of the status/health code path into NODE_COMPILE_CACHE.
 && timeout 900 openclaw status --deep </dev/null >/tmp/openclaw-bootstrap.log 2>&1 || true \
 # 2. Broaden coverage with cheap subcommands that share most of the bootstrap.
 && timeout 60 openclaw models list  </dev/null >>/tmp/openclaw-bootstrap.log 2>&1 || true \
 && timeout 60 openclaw plugins list </dev/null >>/tmp/openclaw-bootstrap.log 2>&1 || true \
 && timeout 60 openclaw infer list   </dev/null >>/tmp/openclaw-bootstrap.log 2>&1 || true \
 # 3. Pre-warm the embedded-agent run path (the slow one in the gateway trace:
 #    model-resolution, auth, core-plugin-tools, system-prompt, stream-setup).
 #    We write a fake auth profile via non-interactive onboarding, then run
 #    `openclaw agent --local`. The Anthropic API call WILL fail (fake key),
 #    but every module loaded up to that point gets JIT-compiled and the
 #    bytecode lands in /opt/openclaw-compile-cache.
 && timeout 60 openclaw onboard --non-interactive \
      --mode local --auth-choice apiKey \
      --anthropic-api-key "sk-ant-prewarm-fake-not-a-real-key-do-not-use" \
      --secret-input-mode plaintext \
      --gateway-port 18799 --gateway-bind loopback \
      --skip-bootstrap --skip-skills --accept-risk \
      </dev/null >>/tmp/openclaw-bootstrap.log 2>&1 || true \
 && timeout 120 openclaw agent --local --agent main --message "warm" --timeout 60 \
      </dev/null >>/tmp/openclaw-bootstrap.log 2>&1 || true \
 # 4. Copy plugin-runtime-deps to the runtime cache (existing behavior).
 && mkdir -p /opt/openclaw-plugin-cache \
 && if [ -d /tmp/openclaw-bootstrap/.openclaw/plugin-runtime-deps ]; then \
        cp -r /tmp/openclaw-bootstrap/.openclaw/plugin-runtime-deps/. \
              /opt/openclaw-plugin-cache/ 2>/dev/null || true; \
    fi \
 # 5. Lock down perms and log cache size for visibility during build.
 && chmod -R a+rX /opt/openclaw-plugin-cache /opt/openclaw-compile-cache \
 && echo "--- compile cache size ---" >>/tmp/openclaw-bootstrap.log \
 && du -sh /opt/openclaw-compile-cache 2>&1 | tee -a /tmp/openclaw-bootstrap.log || true \
 && rm -rf /tmp/openclaw-bootstrap /tmp/openclaw-bootstrap.log

# Install openeral-js: install all deps (including devDeps for tsc), build, then prune
COPY openeral-js/ /opt/openeral/
RUN cd /opt/openeral && npm install && npm run build && npm prune --omit=dev \
    && chmod -R a+rX /opt/openeral \
    && chown -R sandbox:sandbox /opt/openeral

# openeral-bash: drop-in bash replacement routed through just-bash
COPY --chown=sandbox:sandbox sandboxes/openeral/openeral-bash.mjs /opt/openeral/openeral-bash.mjs
RUN chmod a+rx /opt/openeral/openeral-bash.mjs \
    && ln -sf /opt/openeral/openeral-bash.mjs /usr/local/bin/openeral-bash

# Rename real bash so openeral-bash can fall back to it for interactive use
RUN cp /bin/bash /bin/bash.real

# Setup script (entry point for sandbox create).
#
# Users invoke this as the trailing command of `openshell sandbox create`.
# OpenShell doesn't honour Docker ENTRYPOINT/CMD — the image's native entry is
# overridden by openshell's own supervisor, and an empty trailing command just
# leaves the pod asleep. Shipping a short /usr/local/bin/openeral shim lets the
# end-user command end in `-- openeral` instead of `-- /opt/openeral/setup.sh`.
COPY sandboxes/openeral/setup.sh /opt/openeral/setup.sh
RUN chmod 755 /opt/openeral/setup.sh \
    && chown sandbox:sandbox /opt/openeral/setup.sh \
    && ln -sf /opt/openeral/setup.sh /usr/local/bin/openeral

# Override the upstream base policy
COPY sandboxes/openeral/policy.yaml /etc/openshell/policy.yaml

# Skills for Claude Code
COPY .claude/skills/ /sandbox/.skills/

# Workspace directory — must be owned by sandbox user so setup.sh can write .npmrc
RUN mkdir -p /home/agent && chown sandbox:sandbox /home/agent
