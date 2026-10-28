# Daemon launcher

This folder is `sharnessd-launcher`, the process an agent image runs in place
of a fixed `sharnessd`. Each start chooses the release to run, then runs that
release's `sharnessd` with the launcher's environment.

`index.ts` is the process: it reads `configuration.ts`, finds the prefix the
image installed, runs `prepare.ts`, and starts the chosen daemon or, for
`prepare`, prints the choice. `prepare.ts` is one start: it reads or seeds the
record, checks it offline, resolves the candidate, and records what runs.
`selection.ts` holds the pure rules that decide whether a candidate is taken.
`npm.ts` reads the npm registry, `provenance.ts` accepts a tarball only
when its Sigstore-verified SLSA provenance names the release workflow on
`main` of `social-harness/moltzap`. `installation.ts` owns the home-volume state: the
record, the cached tarballs, one installed prefix per release, and the
`current` link. Nothing here imports another Client domain; the launcher runs
the daemon as a child process.
