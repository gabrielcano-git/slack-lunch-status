FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
USER node
EXPOSE 8080
CMD ["node", "dist/src/server.js"]
