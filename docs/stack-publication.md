# Publishing Homelab Compose pins

The source workspaces on main are `/srv/workspaces/homelab-services` and
`/srv/workspaces/homelab-tools`. The original Compose project IDs `stremio`
and `tools` still identify their containers, volumes, networks and namespace
dependencies. The old paths are persistent bind aliases managed by
`srv-workspaces-stremio.mount` and `srv-workspaces-tools.mount` for existing
container bind mounts and older update workers.

The public repositories [homelab-services](https://github.com/rajohan/homelab-services)
and [homelab-tools](https://github.com/rajohan/homelab-tools) contain audited
Compose bases. Production environments, secret inputs, network settings, mounts
and local patches stay on main. Neither a checkout nor a Git remote on the live
directories is needed for publication.

After an approved single, batch or automatic container update verifies its new
image, the host records the previous and new public pins in
`/var/spool/homelab-stack-pins`. A timer publishes as `mira-2026` to the fixed
service file on the corresponding repository's `main` branch. It reads that
file from GitHub and changes only the validated image reference. The GitHub
Contents API creates one commit and uses the current blob SHA for concurrency
control. The updater never stages files from the production workspace.

Install on main from the reviewed Homelab checkout as root:

```sh
install -d -o root -g root -m 0755 /usr/local/lib/homelab-stack-pins
install -d -o rajohan -g rajohan -m 0750 /var/spool/homelab-stack-pins
install -m 0644 apps/dashboard/src/server/integrations/updates/stack_publication.py \
  deploy/maintenance/publish-stack-pins.py /usr/local/lib/homelab-stack-pins/
install -m 0644 deploy/maintenance/homelab-stack-pins.service \
  deploy/maintenance/homelab-stack-pins.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now homelab-stack-pins.timer
```

The service runs without root privileges. Its fixed GitHub CLI wrapper must
authenticate as Mira and have contents write access to both repositories. New
projects and images require review of the explicit mapping in
`stack_publication.py` and creation of a matching public Compose base.

If GitHub is unavailable, the timer retries the verified receipt after a minute.
A successful push with a lost response is acknowledged when the remote file
already has the same pin. A conflicting human edit holds later receipts for
that service. Inspect `journalctl -u homelab-stack-pins.service`, reconcile the
public file and restart the service. A `.prepared` receipt older than 30 minutes
means the installer did not record final verification. Review host and job
state before either completing that receipt or discarding it. Receipts contain
only immutable public image references and service identifiers.
