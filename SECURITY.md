# Security

snout-containers runs other people's images, so a way out of a container, past its limits, or
across to another project's container or the host's network is exactly what we want to hear about.
Report it privately, never as a public issue:

- a [private security advisory](../../security/advisories/new) on this repository, or
- email **security@snoutdata.com**.

The disclosure policy is [snoutdata/.github SECURITY.md](https://github.com/snoutdata/.github/blob/main/SECURITY.md)
(also linked from [snoutdata.com/.well-known/security.txt](https://snoutdata.com/.well-known/security.txt)).

A problem in gVisor itself goes to gVisor (https://github.com/google/gvisor/security), and one in
podman to podman (https://github.com/containers/podman/security); we take their fixes by moving the
pinned version, and ship them to SnoutData Cloud first. When unsure which it is, send it to us.

Only the latest release is supported.
