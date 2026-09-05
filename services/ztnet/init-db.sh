#!/bin/sh

# Enable error handling and debug tracing
set -e
# set -x  ( DEBUG )

error_handling() {
    echo "An error occurred. Exiting..."
    exit 1
}
# trap errors
trap error_handling ERR

: "${DATABASE_URL:?DATABASE_URL is required}"

# ZTNet owns only its Planet workspace. The Controller state is mounted
# read-only under /run so a web-process compromise cannot replace identity or
# controller files. Preserve an existing custom planet during migration.
mkdir -p /var/lib/zerotier-one/zt-mkworld /var/lib/zerotier-one/planet_backup
if [ ! -e /var/lib/zerotier-one/planet ] && [ -r /run/zerotier-controller/planet ]; then
  cp /run/zerotier-controller/planet /var/lib/zerotier-one/planet
fi

# apply migrations to the database
echo "Applying migrations to the database..."
/app/node_modules/.bin/prisma migrate deploy
echo "Migrations applied successfully!"

# seed the database
echo "Seeding the database..."
node /app/prisma/seed.cjs
echo "Database seeded successfully!"

echo "Executing command"
exec "$@"
