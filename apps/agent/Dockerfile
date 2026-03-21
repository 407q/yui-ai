FROM node:22-bookworm

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bzip2 \
    curl \
    file \
    git \
    jq \
    patch \
    python3 \
    python3-pip \
    ripgrep \
    unzip \
    xz-utils \
    zip \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare yarn@1.22.22 --activate

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive

COPY apps/agent ./apps/agent

EXPOSE 3801

CMD ["yarn", "tsx", "apps/agent/src/server.ts"]
