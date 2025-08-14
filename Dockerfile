FROM debian:bookworm-slim

ENTRYPOINT ["/app/iac-manager.sh"]

VOLUME ["/volume"]

ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git \
        docker.io \
        jq \
        yq \
        socat \
        wget \
        psmisc \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN wget -qO /usr/bin/docker-compose https://github.com/docker/compose/releases/download/v2.38.2/docker-compose-linux-x86_64 && \
    chmod +x /usr/bin/docker-compose

WORKDIR /app

COPY update trigger /api/
COPY iac-manager.sh /app/iac-manager.sh
