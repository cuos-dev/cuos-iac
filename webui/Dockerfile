FROM node:24-alpine

WORKDIR /app
EXPOSE 3000

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "app.js"]
