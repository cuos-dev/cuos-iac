# SPDX-License-Identifier: Apache-2.0
FROM debian:13.6-slim

ENTRYPOINT ["/app/entrypoint.sh"]

VOLUME ["/volume", "/root/.docker"]

ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker
LABEL dev.cuos.iac="1"
LABEL dev.cuos.app_command="\
    --memory 512MB \
    --read-only \
    --tmpfs /etc/ssl/certs:rw,noexec,nosuid,size=16m \
    --tmpfs /tmp:rw,size=64m \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume /root/.docker/config.json:/root/.docker/config.json:ro \
    --volume /var/run/cuos.sock:/var/run/cuos.sock \
    --volume iac-socket:/socket \
    --volume iac-volume:/volume \
    --volume iac-root-docker:/root/.docker \
    --volume /system.json:/system.json:ro \
    --volume /usr/local/share/ca-certificates/custom:/usr/local/share/ca-certificates/custom:ro"
# --user user:group ???

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git \
        docker-cli \
        docker-compose \
        jq \
        yq \
        socat \
        wget \
        psmisc \
        openssh-client \
        openssl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY api/* /api/
COPY *.sh /app/

# Ensure scripts are executable inside the image
RUN chmod +x /app/*.sh /api/* || true
