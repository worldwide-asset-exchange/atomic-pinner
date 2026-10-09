# atomic-pinner — runs one pinning pass and exits, which suits cron, Kubernetes CronJobs
# and CI schedules. The container is STATEFUL: progress.json is the resume cursor and
# confirmed-pinned-hashes.json is the cache that keeps re-runs from re-pinning. Mount a
# volume at /app/state or every run starts from the beginning.

FROM node:20.18.1-alpine3.20

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=false

COPY . .

RUN mkdir -p /app/state && chown -R 1000:1000 /app
USER 1000:1000

ENV PROGRESS_FILE=/app/state/progress.json \
    PERSISTENT_CACHE_FILE=/app/state/confirmed-pinned-hashes.json \
    CHUNK_DIRECTORY=/app/state/chunks \
    HASH_REPORT_DIR=/app/state/reports

VOLUME ["/app/state"]

CMD ["yarn", "start"]
