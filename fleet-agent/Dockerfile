# SPDX-License-Identifier: Apache-2.0
FROM node:22.23.3-alpine3.24

# CuOS's own files; the packages in the image carry their own licences.
LABEL org.opencontainers.image.licenses=Apache-2.0

WORKDIR /app
VOLUME ["/data"]
CMD ["npm","start"]

COPY package*.json ./
RUN npm install --omit=dev || npm install --omit=dev
# repo: the repository root, a named build context (--build-context repo=..)
COPY --from=repo LICENSE.txt NOTICE /usr/share/licenses/cuos/
COPY agent.js ./
