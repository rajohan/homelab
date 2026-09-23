# Update targets

`update-targets.json` is the explicitly reviewed, nonsecret deployment configuration
for this Homelab installation. Internal hosts/IPs, installation paths, service users,
fixed loader commands and secret-reference names are intentionally versioned with
the owner's approval. Do not add passwords, tokens, private keys, loader output,
session data or user data.

The dashboard build packages this directory into the dashboard/worker image; auth
and browser bundles do not include it. Set
`HOMELAB_DASHBOARD_UPDATE_TARGETS_FILE=/app/config/update-targets.json` explicitly
in both dashboard and worker, with the legacy inline variable absent. Merely shipping
the file grants no access and enables no automatic policies. Keys remain separately
mounted in the worker; target source publishers must also be configured.

Jackett tracks LinuxServer's `latest` image channel instead of scanning its large
version-tag catalog. Its source publisher must set
`imageTrackingTags["stremio-jackett-1"]` to `"latest"` as well. This changes only
version discovery and the matching execution recipe, not the installed digest or
automatic-update consent. Deployment still requires a reviewed release.

Review changes through PR and deploy a released image. Do not edit production's
container copy. See [update management](../../../docs/update-management.md) for
privilege boundaries, external-file overrides and native activation prerequisites.
