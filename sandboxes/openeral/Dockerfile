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
USER root

# Copy openeral binary
COPY --from=builder /build/target/release/openeral /usr/local/bin/openeral

# Override the upstream base policy with the openeral sandbox policy so the
# stock Claude path keeps working with placeholder credentials under boundary
# secret injection.
COPY sandboxes/openeral/policy.yaml /etc/openshell/policy.yaml

# Ship project-local skills into the sandbox home.
COPY .claude/skills/ /sandbox/.skills/
