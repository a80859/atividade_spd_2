FROM node:18

WORKDIR /app

COPY package.json .
RUN npm install

COPY . .

EXPOSE 3000
CMD ["PGCLIENTENCODING=utf-8","node", "consumer.js"]

