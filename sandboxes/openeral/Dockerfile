# Stage 1: Build openeral from source
FROM rust:1.85-bookworm AS builder

RUN apt-get update && apt-get install -y \
    libfuse3-dev \
    fuse3 \
    pkg-config \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/

RUN cargo build --release --bin openeral \
    && strip /build/target/release/openeral

# Stage 2: Runtime image extending the upstream OpenShell base sandbox
FROM ghcr.io/nvidia/openshell-community/sandboxes/base:latest
ARG UBUNTU_APT_MIRROR=""

USER root

RUN if [ -n "$UBUNTU_APT_MIRROR" ]; then \
      sed -i \
        -e "s|http://archive.ubuntu.com/ubuntu|$UBUNTU_APT_MIRROR|g" \
        -e "s|http://security.ubuntu.com/ubuntu|$UBUNTU_APT_MIRROR|g" \
        -e "s|https://archive.ubuntu.com/ubuntu|$UBUNTU_APT_MIRROR|g" \
        -e "s|https://security.ubuntu.com/ubuntu|$UBUNTU_APT_MIRROR|g" \
        /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null || true; \
    fi

# Install only runtime dependencies (no -dev packages)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fuse3 \
    gnupg \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Claude Code and optional OpenClaw runtime support use Node. OpenClaw is baked
# into the image so the user flow stays one composed openshell command.
RUN set -eux; \
    if ! grep -Rqs 'deb.nodesource.com/node_22.x' /etc/apt/sources.list /etc/apt/sources.list.d; then \
      mkdir -p /usr/share/keyrings; \
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg; \
      echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs; \
    node --version; \
    npm --version; \
    npm install -g --omit=dev openclaw@2026.4.29; \
    npm cache clean --force; \
    rm -rf /var/lib/apt/lists/*

# Copy openeral binary
COPY --from=builder /build/target/release/openeral /usr/local/bin/openeral

# Override the upstream base policy with the openeral sandbox policy so the
# stock Claude path keeps working with placeholder credentials under boundary
# secret injection.
COPY sandboxes/openeral/policy.yaml /etc/openshell/policy.yaml

# Allow non-root FUSE mounts
RUN echo "user_allow_other" >> /etc/fuse.conf

# Create mount points and declare supervisor-managed FUSE mounts.
# OpenShell overrides the container command to run `openshell-sandbox`, which
# reads `/etc/fstab` and mounts `fuse.*` entries marked `noauto` before
# spawning the sandboxed child process.
RUN mkdir -p /db /home/agent && \
    chown sandbox:sandbox /home/agent && \
    printf '%s\n' \
      'env /db fuse.openeral ro,allow_other,noauto 0 0' \
      'env#workspace#${OPENSHELL_SANDBOX_ID} /home/agent fuse.openeral rw,allow_other,noauto 0 0' \
      >> /etc/fstab

# Ship project-local skills into the sandbox home.
COPY .claude/skills/ /sandbox/.skills/
