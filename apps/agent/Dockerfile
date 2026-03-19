FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare yarn@1.22.22 --activate

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive

COPY apps/agent ./apps/agent

EXPOSE 3801

CMD ["yarn", "tsx", "apps/agent/src/server.ts"]
