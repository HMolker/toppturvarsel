#!/bin/sh
# Refresh the vendored copy of the shared stylesheet from the Pi's /shared/.
#   scripts/sync-molker-css.sh https://tomtarochtroll.duckdns.org
# The page loads /shared/molker.css on top of the vendored copy, so the site
# always shows the newest design; this keeps the fallback copy close to it.
set -e
base="${1:?usage: sync-molker-css.sh https://your-site}"
curl -fsS "$base/shared/molker.css" -o "$(dirname "$0")/../public/vendor/molker.css"
echo "updated public/vendor/molker.css"
