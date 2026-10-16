# snout-containers

Runs OCI images declared in a directory, each one under [gVisor](https://gvisor.dev), with memory
and CPU limits, a network of its project's own, restarts and logs. It is the runner behind
[Snout Containers](https://docs.snoutdata.com/stack/containers) in SnoutData Cloud, where a paid
project runs a Docker image of its own all the time beside its database.

It does one thing: make what a set of JSON files describes exist on this host, keep it that way,
and say how it is. It holds no database, opens no port to the world, and keeps no state a restart
would lose: the containers are not its children, so a new runner finds them where the old one left
them.

## How it works

```
manifests/<project>.json  ──►  snout-containers  ──►  the engine's podman  ──►  gVisor sandboxes
                                     │
                                     └──►  state/status.json, state/logs/*.jsonl
```

Every few seconds it reads the manifest directory and, for each container:

- equal to what is running: nothing;
- new or changed: pulls the image (with the registry login when one is given), makes the
  project's network, sets the container's limits, and runs it;
- stopped on its own: makes it again from its image, waiting 5 seconds, then 10, doubling up to 5
  minutes; after five failures in a row it reports `failed`, and a minute running clears the count;
- no longer in any manifest: stops and removes it, and the project's network once it is empty.

It writes `status.json` (every container's state, and why when it is not running) after each pass,
and once a minute a JSONL file of what each container printed into `logs/`, for whoever ships logs
to read and delete.

### Isolation

- **gVisor** for every container: its system calls are served by gVisor's user-space kernel, not
  the host's.
- **A user namespace of its own** (`userns=auto`): the sandbox runs as an unprivileged sub-uid.
- **Limits** from a systemd slice per container: `MemoryMax`, `CPUQuota`, `TasksMax`. Over its
  memory, the sandbox is killed and made again.
- **A network per project**: a /28 of its own (from `10.95.0.0/16` by default), with the instance
  metadata service and every private range (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`)
  routed to an address nothing holds. A container reaches the public internet and its own
  project's containers, and nothing else: not the host's network, not another project's containers.
  The networks are IPv4 only, and IPv6 from a project's bridge is dropped at the firewall (below),
  so nothing leaves a container over IPv6.
- **An allowlist, when a project asks for one**: its containers then reach only the destinations
  it lists (below).
- **Limits on what it sends** (below): a connection rate, a number held open, a bandwidth, and
  port 25 closed.
- **No secret on a command line**: the environment reaches podman through a 0600 file deleted as
  soon as the container is made, and a registry login through an auth file the same way.

### What a container may send

The public internet is open to a container, so the limits are on how much and how fast. They live in
one nftables table, `inet snoutct`, in the network namespace the containers' bridges are in
(rootless podman's), hooked into forwarding just before netavark's, and they touch only packets
from the pool:

| | Default |
| --- | --- |
| New connections it opens | 20 a second, bursts of 200 |
| Connections it opened, held at once | 1,000 |
| Bytes a second on connections it opened | 2 MB, bursts of 8 MB |
| TCP ports it may not open | 25 |

IPv6 from any project's bridge is dropped in the same table, whether it is forwarded or addressed
to the namespace itself: the networks have no IPv6 and every limit above is an IPv4 rule, so IPv6
would otherwise pass them all. It is matched by the bridge (`network_interface` in `podman network
ls`), since an IPv6 packet carries no address from the pool.

Past a limit a new connection is refused (a TCP reset, an ICMP refusal otherwise) and bytes over
the rate are dropped. A UDP flow is "new" until something answers, so a flood at a silent address
is held to the connection rate. Connections TO a container are not limited: they began on the
other side.

The runner applies the table before it starts anything, checks it every minute and after every
container it makes, and applies it again when it is missing or different. Once a minute it reads
the table's counters, and each container's row in `status.json` carries what it sent, opened, was
refused and was throttled in the last hour (`egress`), plus `totalSentBytes`, a running total of
what it sent, counted from zero whenever `epoch` changes (a new runner, or the container made anew).
Whoever adds totals up takes the difference while the epoch holds and the whole total when it
moves, so a status read twice or missed never counts a byte twice. A new runner starts from what
the table already holds, which the runner before it counted. In SnoutData Cloud those figures go to
the control plane, which emails the owner and us when an hour looks like abuse, and stops a
project's containers for the rest of the month once they have sent its allowance.

### Where a container may send: an allowlist

By default the public internet is open to a container. A manifest may carry `egress.allow` (below);
that project's containers then reach the destinations it lists and nothing else: a host name, an
IPv4 address or an IPv4 range, each on the ports it lists, or any port when it lists none. The
project's own containers always reach each other. Every packet a container sends that is not a
reply is checked, not only a new connection, so a destination taken off the list is cut at once;
what is refused gets a TCP reset (an ICMP refusal otherwise) and is counted in `blocked`, apart
from `refused`, so it never reads as abuse.

The firewall holds addresses, so the runner looks each host name up every minute through its own
resolver and lists every address it gave in the last hour; a name that rotates through a set of
addresses keeps working, and one that never resolves lists nothing. A name that answers
differently to different resolvers (some CDNs) may be refused now and then; list its range instead.
The rules on how much and how fast still apply to what is allowed.

The sets that hold the allowlists and the bridges are replaced in one transaction whenever they
change, without replacing the table (so its counters carry on), and before the first container of
a project whose network was just made is started. A project with an allowlist never runs without
it: its containers are not started while the sets cannot be put in place, in `measure` mode too,
and with `SNOUT_CONTAINERS_EGRESS=off` they are reported `failed`.

It reaches nftables through the host user's systemd: `systemd-run --user --pipe --wait` runs
`podman unshare --rootless-netns /usr/sbin/nft` on the host, so the host needs `nftables`
installed, and the engine must be rootless podman. On anything else set `SNOUT_CONTAINERS_EGRESS=off`
and limit egress another way.

If the engine's podman does not report the runtime `runsc-snoutct`, the runner makes nothing at
all and reports every container as `failed` with the reason. It never runs an image under an
ordinary runtime.

## The engine

The runner needs these on the host. In SnoutData Cloud they are installed with every host;
anywhere else, as root:

1. **gVisor**: `runsc` and its `gvisor-bin/` directory in `/usr/local/bin`, from a
   [release](https://gvisor.dev/docs/user_guide/install/).
2. **The runtime wrapper**, `/usr/local/bin/runsc-snoutct`:

   ```sh
   #!/bin/sh
   exec /usr/local/bin/runsc --ignore-cgroups --network=host "$@"
   ```

   `--ignore-cgroups` because the limits come from the container's slice, which holds the whole
   sandbox. `--network=host` means the container's *own* network namespace through the host
   kernel's stack, which is what makes the network's deny routes apply and a published port answer.
3. **The engine's podman configuration**, `/etc/snoutct/containers.conf`:

   ```toml
   [containers]
   userns = "auto"

   [engine]
   runtime = "runsc-snoutct"

   [engine.runtimes]
   runsc-snoutct = ["/usr/local/bin/runsc-snoutct"]
   ```

4. **A podman service of its own**, as the (rootless) user that will own the containers, with
   lingering on (`loginctl enable-linger <user>`). `~/.config/systemd/user/snoutct-podman.service`:

   ```ini
   [Service]
   Environment=CONTAINERS_CONF=/etc/snoutct/containers.conf
   ExecStartPre=/usr/bin/mkdir -p %t/snoutct
   ExecStart=/usr/bin/podman system service --time=0 unix://%t/snoutct/podman.sock
   KillMode=process
   Restart=always

   [Install]
   WantedBy=default.target
   ```

   then `systemctl --user enable --now snoutct-podman.service`. A service of its own, because
   podman's API takes no per-container runtime: the defaults above apply only to what is made
   through this socket, and nothing else that user runs is affected. `KillMode=process` is what
   podman's own unit has, and it matters here: the service is the parent of every published port's
   forwarder (`rootlessport`), so without it a restart of the service stops every container's port
   while the containers themselves stay up.

5. **nftables** (`/usr/sbin/nft`), for the limits on what containers send.

Measured on Debian 13, podman 5.4.2, netavark 1.14 (nftables), nftables 1.1.3, gVisor
`release-20261005.0`, arm64.

## Running it

```sh
podman run -d --name snout-containers \
  -v /run/user/$(id -u)/snoutct:/run/snoutct \
  -v /run/user/$(id -u)/bus:/run/user-bus \
  -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user-bus \
  -v $PWD/manifests:/manifests:ro \
  -v $PWD/state:/state \
  -e SNOUT_CONTAINERS_BIND=127.0.0.1 \
  ghcr.io/snoutdata/snout-containers:0.1.2
```

as the same rootless user, with podman's default user mapping (the runner's root is that user, so
the user's systemd accepts it on its bus). It is a podman client: it reaches the engine through the
socket, and the user's systemd through the bus to set each container's slice and to reach nftables.

| Variable | Default | |
| --- | --- | --- |
| `SNOUT_CONTAINERS_MANIFESTS` | `/manifests` | the manifest directory; read-only is fine |
| `SNOUT_CONTAINERS_STATE` | `/state` | `status.json`, `logs/`, and short-lived files in `tmp/` |
| `SNOUT_CONTAINERS_BIND` | `127.0.0.1` | comma-separated addresses a `hostPort` is published on |
| `SNOUT_CONTAINERS_POOL` | `10.95.0.0/16` | where project networks' /28s come from |
| `SNOUT_CONTAINERS_STEP_MS` | `5000` | how often it reconciles |
| `SNOUT_CONTAINERS_EGRESS` | `enforce` | `enforce`: nothing new starts until the egress limits are in place; `measure`: apply and report, but start anyway; `off`: leave the firewall alone |
| `CONTAINER_HOST` | `unix:///run/snoutct/podman.sock` | the engine's socket |
| `DBUS_SESSION_BUS_ADDRESS` | | the user's systemd bus |
| `PORT` | `8080` | where `/health` answers |

`/health` answers 200 when the engine is gVisor and, enforced, the egress limits are in place, and
503 with the reason when not.

## The manifest

One file per project, `<project>.json`, written whole (write it elsewhere and rename it into the
directory):

```json
{
  "project": "acme",
  "limits": { "memoryMb": 256, "cpuPercent": 50 },
  "containers": [
    {
      "name": "whatsapp",
      "image": "ghcr.io/acme/whatsapp-bridge@sha256:…",
      "port": 8080,
      "hostPort": 46432,
      "env": { "DATABASE_URL": "postgresql://…" },
      "registry": { "username": "acme", "password": "…" },
      "restartGeneration": 0
    }
  ],
  "egress": { "allow": [{ "destination": "api.example.com", "ports": [443] }, { "destination": "203.0.113.0/24" }] }
}
```

- `project`: lower-case letters and digits, and the file's name.
- `limits`: each container's memory in MB and its CPU as a percentage of one core.
- `name`: lower-case letters, digits, `-` and `_`, up to 32.
- `image`: pin it by digest; a tag is pulled as it is the first time and not again.
- `port`: what the image listens on, also given to it as `PORT` unless `env` sets one.
- `hostPort`: where it is published on `SNOUT_CONTAINERS_BIND`; leave it out for a container that
  only reaches out.
- `registry`: for a private image. Kept in the file only; given to podman through a 0600 file.
- `restartGeneration`: change it to make the container again from its image.
- `egress`: optional. `allow` lists where the project's containers may send, up to 64
  destinations, each a host name, an IPv4 address or an IPv4 range with up to 16 `ports` (none:
  any). An empty list reaches nothing outside the project. Without `egress`, the public internet.

A file that does not parse, or breaks a rule, is reported in `status.json` and its project's
containers are left as they were. A project with no file has nothing running.

## Stateless

Every change, restart or move makes a container again from its image, so **anything written inside
it is lost**. A container's disk is scratch. What matters belongs in a database or object storage
outside it.

## Development

```sh
npm install
npm test        # compiles, then the unit tests: no podman needed
```

The tests drive the runner against a fake podman: the exact commands it would run, that nothing
secret is on a command line, that a broken engine runs nothing, that a crash is made again with a
backoff, that two projects get two networks, that IPv6 is dropped, and that an allowlist is in
place before a restricted project's container starts.

## Licence

Apache-2.0. See LICENSE.
