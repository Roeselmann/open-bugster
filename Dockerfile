FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run prepare
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /app/.output ./.output
RUN mkdir -p /data/attachments && chown -R node:node /app /data
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
