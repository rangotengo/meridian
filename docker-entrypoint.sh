#!/bin/sh
set -e

role="${APP_ROLE:-${1:-web}}"

if [ "$role" = "web" ]; then
  npm run db:migrate
  exec npm start
fi

if [ "$role" = "worker" ]; then
  exec npm run worker
fi

exec "$@"
