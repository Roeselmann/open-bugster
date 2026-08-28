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
# The maintenance scripts (`npm run owner:reset`) have to be runnable inside the container.
# Nitro puts the production dependencies under .output, so link them where Node looks.
COPY scripts ./scripts
COPY package.json ./
RUN ln -s /app/.output/server/node_modules /app/node_modules
RUN mkdir -p /data/attachments && chown -R node:node /app /data
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
