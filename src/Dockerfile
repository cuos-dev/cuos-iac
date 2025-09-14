FROM debian:trixie-slim

ENTRYPOINT ["/app/entrypoint.sh"]

VOLUME ["/volume", "/root/.docker"]

ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker
LABEL dev.cuos.iac="1"
LABEL dev.cuos.app_command="\
    --device /dev/tty1 \
    --memory 512MB \
    --read-only \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume /root/.docker/config.json:/root/.docker/config.json:ro \
    --volume /var/run/cuos.sock:/var/run/cuos.sock \
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
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY update trigger /api/
COPY *.sh /app/
