FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm install -D typescript && npx tsc -p tsconfig.json && npm prune --omit=dev
EXPOSE 8787
CMD ["node", "dist/index.js"]
