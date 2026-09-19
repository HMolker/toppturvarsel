# IBM Plex (optional, self-hosted)

The graphical profile sets type in IBM Plex Sans with IBM Plex Mono for
labels. The stylesheet looks for Plex in this order:

1. installed on the viewer's machine (`local()`),
2. these files, served from `/fonts/`,
3. otherwise a Helvetica/Arial and system-mono fallback.

Nothing is fetched from a third party at runtime. To self-host, drop these
woff2 files in this folder (IBM Plex is SIL Open Font License, from
https://github.com/IBM/plex/releases):

    IBMPlexSans-Regular.woff2
    IBMPlexSans-Medium.woff2
    IBMPlexSans-SemiBold.woff2
    IBMPlexSans-Bold.woff2
    IBMPlexMono-Regular.woff2
    IBMPlexMono-SemiBold.woff2

Rebuild the image and they are picked up; no code change needed.
