# Daily Dick's sell-through download. The Playwright image ships Node and Chromium with the OS
# libraries Chromium needs; its tag must equal the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# cron for scheduling; tzdata so TZ=America/Denver is honoured by cron and by the log stamps.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends cron tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY run.sh /usr/local/bin/dicks-sync
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/dicks-sync

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
