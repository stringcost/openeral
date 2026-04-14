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

# Install openeral-js: install all deps (including devDeps for tsc), build, then prune
COPY openeral-js/ /opt/openeral/
RUN cd /opt/openeral && npm install && npm run build && npm prune --omit=dev \
    && chmod -R a+rX /opt/openeral \
    && chown -R sandbox:sandbox /opt/openeral

# openeral-bash: drop-in bash replacement routed through just-bash
COPY sandboxes/openeral/openeral-bash.mjs /opt/openeral/openeral-bash.mjs
RUN chmod +x /opt/openeral/openeral-bash.mjs \
    && ln -sf /opt/openeral/openeral-bash.mjs /usr/local/bin/openeral-bash

# Rename real bash so openeral-bash can fall back to it for interactive use
RUN cp /bin/bash /bin/bash.real

# Setup script (entry point for sandbox create)
COPY sandboxes/openeral/setup.sh /opt/openeral/setup.sh
RUN chmod 755 /opt/openeral/setup.sh \
    && chown sandbox:sandbox /opt/openeral/setup.sh

# Override the upstream base policy
COPY sandboxes/openeral/policy.yaml /etc/openshell/policy.yaml

# Skills for Claude Code
COPY .claude/skills/ /sandbox/.skills/

# Workspace directory — must be owned by sandbox user so setup.sh can write .npmrc
RUN mkdir -p /home/agent && chown sandbox:sandbox /home/agent
