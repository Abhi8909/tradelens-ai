FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/web apps/web
COPY apps/api apps/api
COPY packages packages
RUN npm run build

FROM node:22-bookworm-slim AS api
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node apps/api apps/api
COPY --chown=node:node packages packages
COPY --chown=node:node scripts/mtf-maintenance.ts scripts/mtf-maintenance.ts
ENV NODE_ENV=production API_HOST=0.0.0.0
USER node
EXPOSE 4000
CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]

FROM nginx:1.28-alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80
