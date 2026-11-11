# Light runner image: actions/runner + git + node, nothing else.
# Cloudflare Containers run linux/amd64 only.
# Base pinned by its multi-arch index digest (Docker Hub registry API,
# fetched 2026-11-11 UTC). Refresh: see README "Updating the runner image".
FROM --platform=linux/amd64 ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

# Pin by version AND checksum. Bump both together:
#   runner: https://github.com/actions/runner/releases (SHA in the release notes)
#   node:   https://nodejs.org/dist/v<version>/SHASUMS256.txt
# GitHub refuses runners older than its minimum supported version (~30 days
# behind latest), so keep RUNNER_VERSION current.
ARG RUNNER_VERSION=2.338.2
ARG RUNNER_SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
ARG NODE_VERSION=22.22.0
ARG NODE_SHA256=9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37

ENV DEBIAN_FRONTEND=noninteractive \
    RUNNER_ALLOW_RUNASROOT=0 \
    AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git jq unzip xz-utils procps \
       libicu74 liblttng-ust1 libkrb5-3 zlib1g \
    && rm -rf /var/lib/apt/lists/*

# Node in /usr/local (for `node` on PATH) and seeded into the tool cache, so
# actions/setup-node finds this exact version instead of downloading it.
RUN curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && mkdir -p "${AGENT_TOOLSDIRECTORY}/node/${NODE_VERSION}/x64" \
    && tar -xJf /tmp/node.tar.xz -C "${AGENT_TOOLSDIRECTORY}/node/${NODE_VERSION}/x64" --strip-components=1 \
    && touch "${AGENT_TOOLSDIRECTORY}/node/${NODE_VERSION}/x64.complete" \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
       --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md' \
    && rm /tmp/node.tar.xz \
    && node --version

# The runner refuses to run as root.
RUN useradd -m -s /bin/bash runner \
    && chown -R runner:runner "${AGENT_TOOLSDIRECTORY}"

WORKDIR /home/runner
RUN curl -fsSL -o /tmp/runner.tar.gz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
    && echo "${RUNNER_SHA256}  /tmp/runner.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/runner.tar.gz \
    && rm /tmp/runner.tar.gz \
    && chown -R runner:runner /home/runner

COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh
USER runner
ENTRYPOINT ["/home/runner/entrypoint.sh"]
