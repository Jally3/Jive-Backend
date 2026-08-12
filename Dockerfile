FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S jive && adduser -S -G jive jive
COPY --from=build --chown=jive:jive /app/node_modules ./node_modules
COPY --from=build --chown=jive:jive /app/dist ./dist
COPY --from=build --chown=jive:jive /app/migrations ./migrations
COPY --from=build --chown=jive:jive /app/package.json ./package.json
USER jive
EXPOSE 3000
CMD ["node", "dist/apps/api/src/main.js"]
