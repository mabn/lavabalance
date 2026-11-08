# The lavabalance Node bot (src/bot/bot.ts) as a Cloudflare Container image.
# Built and pushed by `cf deploy` (Docker must be running locally); the
# BotContainer Durable Object (src/botContainer.ts) starts it and keeps it up.
# The deploy builds the image for linux/amd64 itself (no --platform here — the
# Docker linter rejects a constant platform in FROM).
FROM node:26-slim

WORKDIR /app

# Debugging comforts for `cf containers ssh` (the slim image has no ps, no
# pager, no editor): procps (ps/top), less, vim (full — vim-tiny has no syntax
# highlighting) with a minimal colour-enabled config, and curl for the health
# endpoint. ~40 MB on top of the image; not used by the bot itself.
RUN apt-get update \
    && apt-get install -y --no-install-recommends procps less vim curl \
    && rm -rf /var/lib/apt/lists/*
# bash for SSH sessions. The platform's SSH server execs /bin/sh (`echo $0` →
# /bin/sh) rather than the user's login shell, so /bin/sh is replaced by
# container/sh: an interactive no-arg session execs `bash --rcfile
# /root/.bashrc -i` (prompt, colours, aliases — no reliance on $ENV reaching
# the session), anything else (`sh -c …`) is passed to bash unchanged.
# The files are staged and CR-stripped first: a CRLF checkout (Windows/WSL git
# autocrlf) turns the shebang into "#!/bin/bash\r" and the build dies with
# "exec /bin/sh: no such file or directory". Replacing /bin/sh is the LAST step
# of this RUN, since every later RUN is executed by /bin/sh.
COPY container/ /tmp/container/
RUN sed -i 's/\r$//' /tmp/container/* \
    && install -m 644 /tmp/container/vimrc /root/.vimrc \
    && install -m 644 /tmp/container/vimrc /etc/vim/vimrc.local \
    && install -m 644 /tmp/container/bashrc /root/.bashrc \
    && usermod -s /bin/bash root \
    && install -m 755 /tmp/container/sh /bin/sh \
    && rm -rf /tmp/container

# Runtime deps only (hono etc. — tiny); tsx runs the TypeScript directly, exactly
# like `pnpm run bot` does, so there is no build step to keep in sync. pnpm is
# installed through npm because Node 25+ no longer ships corepack.
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@10.28.0 tsx@4 && pnpm install --prod --frozen-lockfile

COPY src ./src

# The bot serves a tiny JSON health endpoint on this port (BOT_HEALTH_PORT in
# bot.ts). Cloudflare requires the image to expose a port, and BotContainer waits
# for it to come up (startAndWaitForPorts) and reads it for /bot/status.
ENV BOT_HEALTH_PORT=8080
EXPOSE 8080

# Where things are, for a shell in the instance (`cf containers ssh`):
#   the bot   = PID 1, `tsx src/bot/bot.ts`, cwd /app        → ps aux
#   protocol  = /app/commands_<YYYY-MM-DD>.log (both directions) → less +F /app/commands_*.log
#   console   = /app/bot_<YYYY-MM-DD>.log (everything console.* prints — status,
#               chat, errors; the same lines also go to stdout → dashboard Logs)
#   health    = curl -s localhost:8080/health
# Credentials come from the environment (BOT_LOGIN, BOT_PASSWORD, BOT_ADMINS,
# BOT_AUTOJOIN_ROOM, BOT_TEISERVER_EMAIL, BOT_LAVAOS_URL, BOT_CONTROL_TOKEN), set by BotContainer.
CMD ["tsx", "src/bot/bot.ts"]
