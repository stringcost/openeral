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

# Pre-stage OpenClaw's TUI plugin-runtime-deps at image-build time so end users
# don't pay the multi-minute npm-install latency on first prompt.
#
# Why this is needed:
#   OpenClaw lazy-loads its TUI plugins on first agent interaction. Some of those
#   plugins declare deps as `git+ssh://git@github.com/…` (e.g. whiskeysockets/
#   libsignal-node), which the OpenShell sandbox policy blocks at the network
#   layer. The user-visible symptom is a ~10 min hang on the very first "hi" and
#   subsequent npm error 128 failures. Doing the stage here, where the build
#   environment has full network access, sidesteps both.
#
# Steps:
#   1. Rewrite git+ssh GitHub URLs to https — same fix as setup.sh, applied here
#      so even if the build's network restricts SSH, deps resolve via HTTPS.
#   2. Run `openclaw status --deep` under a throwaway HOME to force plugin
#      discovery and dependency resolution. `|| true` because we don't want
#      a transient bootstrap warning to fail the whole image build; setup.sh
#      runs the same step at runtime as a fallback.
#   3. Copy the resulting plugin-runtime-deps tree to /opt/openclaw-plugin-cache.
#      setup.sh seeds /home/agent/.openclaw/plugin-runtime-deps from this dir
#      on every sandbox launch.
RUN mkdir -p /tmp/openclaw-bootstrap \
 && HOME=/tmp/openclaw-bootstrap git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/" \
 && HOME=/tmp/openclaw-bootstrap git config --global --add url."https://github.com/".insteadOf "git@github.com:" \
 && HOME=/tmp/openclaw-bootstrap git config --global --add url."https://github.com/".insteadOf "git+ssh://git@github.com/" \
 && HOME=/tmp/openclaw-bootstrap timeout 900 openclaw status --deep \
      </dev/null >/tmp/openclaw-bootstrap.log 2>&1 || true \
 && mkdir -p /opt/openclaw-plugin-cache \
 && if [ -d /tmp/openclaw-bootstrap/.openclaw/plugin-runtime-deps ]; then \
        cp -r /tmp/openclaw-bootstrap/.openclaw/plugin-runtime-deps/. \
              /opt/openclaw-plugin-cache/ 2>/dev/null || true; \
    fi \
 && chmod -R a+rX /opt/openclaw-plugin-cache \
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
