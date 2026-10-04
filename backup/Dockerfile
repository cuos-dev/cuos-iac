# SPDX-License-Identifier: Apache-2.0
FROM node:26.10.0-alpine3.24

# restic does the backups; docker-cli runs the database dumps in the labelled containers (through the Docker proxy);
# openssh-client is for sftp targets.
RUN apk add --no-cache restic docker-cli openssh-client tzdata

WORKDIR /app
VOLUME ["/data"]
CMD ["node", "agent.js"]

COPY package.json ./
COPY *.js ./
