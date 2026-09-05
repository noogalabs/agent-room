#!/bin/sh
set -eu

node packages/room-persistence/dist/migrate.js --allow-remote
exec node apps/room-server/dist/index.js
