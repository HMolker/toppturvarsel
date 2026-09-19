# Your own GPX tracks

Drop a GPX file here named after the tour's slug and it replaces the
automatically derived OpenStreetMap route for that tour:

    data/tracks/rornestinden.gpx
    data/tracks/store-blamann.gpx

The slug is the tour name lower-cased, with accents removed and anything
that is not a letter or digit turned into "-". `GET /api/meta` lists every
tour with its slug.

Use tracks you recorded yourself or have the right to use. With Docker,
mount this folder (see docker-compose.yml). Restart, or wait for the cache
to expire, for a replaced file to be picked up.

There is deliberately no upload button: the service is often exposed to
the internet, and an unauthenticated upload endpoint is not worth having.
