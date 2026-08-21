FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    WORKBENCH_HOST=0.0.0.0 \
    WORKBENCH_PORT=8787 \
    WORKBENCH_DATA_DIR=/app/data \
    WORKBENCH_WEB_DIR=/app/dist

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]
EXPOSE 8787

CMD ["node", "dist-server/server/index.js"]
