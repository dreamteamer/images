# Changelog

## 0.4.0 — 2026-09-25 — hardening

Security fixes from the 2026-09-25 review of the hosted service (findings IMG-1…IMG-7, S8-01/S8-02).

**Breaking for local use:** code-server now binds `127.0.0.1` inside the container unless
`DT_LOCAL_BIND=0.0.0.0` is set, so a Docker port mapping reaches it only with that flag. `dt start
container` does not pass it yet, which is why CI no longer pushes `:latest` (the engine resolves
`--template hq` to `:latest`, which stays on 0.3.3 until the engine sends the flag).

- **The origin proxy is not the workspace user's.** It runs as its own system user `dtproxy`, under
  `node --disable-sigusr1`, with a clean environment, no new privileges and no capabilities; the
  proxy, entrypoint and persist-home files are root-owned `0755`. PID 1 is a small root supervisor
  that `node` cannot signal; when the proxy or code-server exits it stops the other and exits
  non-zero, so the platform restarts the machine.
- **Hosted mode is explicit.** The public listener starts only with `DT_MODE=hosted`, a
  `DT_GATEWAY_PUBLIC_KEY` (or a `DT_GATEWAY_PUBLIC_KEYS` JSON array: an assertion from any key
  verifies) that imports, and `DT_ORIGIN_HOST`. Otherwise the container exits non-zero within a second
  and says why. Any other `DT_MODE` is refused.
- **Egress policy (hosted).** `/etc/dt/egress.nft`: SMTP and common mining/IRC ports, RFC 1918,
  CGNAT, link-local and Fly 6PN (`fdaa::/16`, except the resolver `fdaa::3:53`) are dropped; new
  connections are capped at 50/s (burst 100); a `tc tbf` caps egress at `DT_EGRESS_MBIT` (default
  20). Failure to apply it is fatal. `DT_EGRESS_POLICY=off` is the logged debugging opt-out.
- **No new privileges anywhere, no setuid.** Every process the entrypoint starts runs with
  `--no-new-privs`, an empty inheritable and bounding set; setuid/setgid bits are stripped at build.
- **`/healthz` tells the truth.** 200 only when code-server answers its own `/healthz` within 2 s,
  else 503.
- **Supply chain.** Base image pinned by digest; code-server from the release `.deb`, checked against
  the per-arch sha256 GitHub lists for the asset (no `curl | sh`); `SHELL` with `pipefail`;
  `hq-agents` builds `FROM` the hq digest the same CI run pushed.
- **CI.** Runs on pull requests (gates, build, built-image smoke, container tests; no push) and on
  `v*` tags (plus Trivy CRITICAL gate, push by digest, `digest.txt` artifact, SBOM, provenance, cosign
  keyless signature). Actions pinned by SHA, `permissions: {}` at the top and per-job least
  privilege, a timeout on every job; the leak gate counts matches and never prints them.

## 0.3.x

Hosted mode: the origin proxy, home persistence onto the workspace volume, chown-then-setpriv.

## 0.2.0

The `hq` and `hq-agents` templates.
