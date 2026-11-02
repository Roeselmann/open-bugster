FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run prepare
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
# Keep everything that must survive a rebuild inside the volume, even when no .env
# provides the paths. Values from .env still override these.
ENV DATABASE_PATH=/data/open-bugster.sqlite ATTACHMENTS_PATH=/data/attachments
WORKDIR /app
COPY --from=build /app/.output ./.output
# The maintenance scripts (`npm run owner:reset`) have to be runnable inside the container.
# Nitro puts the production dependencies under .output, so link them where Node looks.
COPY scripts ./scripts
COPY package.json ./
RUN ln -s /app/.output/server/node_modules /app/node_modules
# The browser that renders link previews, at exactly the version package-lock.json pins, plus
# the system libraries it needs. Installed as root (apt), outside the volume. The CLI is not
# part of the traced build output, so it comes from the build stage and leaves again.
# LINK_PREVIEW_RENDER=false switches rendering off; previews then use the page's own image.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app/node_modules/playwright-core /tmp/playwright-core
RUN node /tmp/playwright-core/cli.js install --with-deps --only-shell chromium \
  && rm -rf /tmp/playwright-core /var/lib/apt/lists/* \
  && chmod -R a+rX /ms-playwright
RUN mkdir -p /data/attachments && chown -R node:node /app /data
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
