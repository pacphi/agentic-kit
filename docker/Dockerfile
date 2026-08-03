# syntax=docker/dockerfile:1
# Isolated first-use environment for @pacphi/agentic-kit.
#
# Deliberately does NOT bake the kit into the image: the entrypoint installs
# @pacphi/agentic-kit@next at container start, so every fresh container
# exercises the true first-install path against whatever `next` currently is —
# no image rebuild per release. Apt + Node layers stay cached.
#
# See USER-GUIDE.md (running it) and MAINTAINER-GUIDE.md (design + knobs).

ARG UBUNTU_VERSION=26.04
FROM ubuntu:${UBUNTU_VERSION}

ARG NODE_MAJOR=24
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# procps: ruflo daemon discovery shells out to `ps -eo` (absent on slim bases).
# build-essential/python3: node-gyp fallback when a native prebuild is missing.
# socat: re-publishes the loopback-only dashboard on the container interface.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git less procps socat sudo xz-utils \
      build-essential python3 pkg-config \
    && rm -rf /var/lib/apt/lists/*

# NodeSource Node (kit engines: node >=22). Override: --build-arg NODE_MAJOR=26
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get update && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Non-root: the claude CLI refuses permission-bypass modes as root, and a
# user-owned npm prefix (no sudo for `npm -g`) is the realistic first-use shape.
# Passwordless sudo stays available for in-container debugging.
RUN useradd -m -s /bin/bash tester \
    && echo 'tester ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/tester

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER tester
ENV NPM_CONFIG_PREFIX=/home/tester/.npm-global \
    PATH=/home/tester/.npm-global/bin:$PATH
WORKDIR /home/tester/work

# 7432 is the socat bridge, NOT the dashboard itself — the dashboard binds
# container-loopback 7431 by design and is unreachable via port publishing.
EXPOSE 7432

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["dashboard"]
