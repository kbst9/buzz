# Base image for the M3 Docker heavy tier (src/sandbox/docker.ts).
#
# Minimal, git-capable agent workspace image following the cloudflare
# sandbox-sdk pattern (git + curl + ca-certs + bash). The `buzz` CLI is NOT
# baked in — the tier bind-mounts the host binary read-only so the agent
# always runs the same buzz build as the fleet, no image rebuild on CLI bumps.
#
# Build (on the fleet host, so the glibc matches the bind-mounted buzz):
#   docker build -f flue-host/docker/heavy-base.Dockerfile -t buzz-heavy-base:latest .
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The tier sets -w to the projected workspace; this is just a sane default.
WORKDIR /workspace
