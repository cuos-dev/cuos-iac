FROM node:25.8.2-alpine3.22

WORKDIR /app
VOLUME ["/data"]
CMD ["npm","start"]

COPY package*.json ./
RUN npm install --omit=dev || npm install --omit=dev
COPY agent.js ./
