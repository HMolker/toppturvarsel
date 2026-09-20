# Node 22 for built-in fetch, the test runner and AbortSignal.timeout.
# Alpine because this image has zero npm dependencies to compile.
FROM node:22-alpine

# Time zone data, so quiet hours follow local time (TZ in .env).
RUN apk add --no-cache tzdata

# Run as the unprivileged user the base image already provides.
WORKDIR /app

# The service itself has no dependencies. The one optional package is
# nodemailer, for sending alerts through an ordinary mailbox (Gmail and the
# like) over SMTP; it has no dependencies of its own. If it cannot be
# fetched the build still succeeds and only SMTP mail is unavailable —
# Resend, ntfy push and everything else are untouched.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund nodemailer@^6.9 \
    || echo "nodemailer not installed: MAIL_PROVIDER=smtp will be unavailable"

COPY src ./src
COPY public ./public
COPY data ./data
# The tour editor is served (read-only) at /editor.
COPY editor ./editor

# The snapshot cache lives here; mount a volume so it survives restarts.
RUN mkdir -p /app/data/cache && chown -R node:node /app
VOLUME ["/app/data/cache"]

USER node
ENV NODE_ENV=production PORT=8080 DATA_DIR=/app/data
EXPOSE 8080

# The healthcheck fails on a stale snapshot, not just a dead process, so a
# service that is up but silently not fetching is visible to Docker.
HEALTHCHECK --interval=5m --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
