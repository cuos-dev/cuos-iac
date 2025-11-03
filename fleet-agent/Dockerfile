FROM node:24-alpine

WORKDIR /app
VOLUME ["/data"]
CMD ["npm","start"]

COPY package*.json ./
RUN npm install --omit=dev || npm install --omit=dev
COPY agent.js ./
