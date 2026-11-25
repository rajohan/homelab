import type { MaintenanceTarget } from "./configuration";

const serviceName = /^(?:[A-Za-z0-9:_.@-]|\\x[0-9A-Fa-f]{2})+\.service$/;

/**
 * Identify host services whose recovery requires a new connection to the managed host.
 * @param unit - Canonical Linux service name from the inspection or deploy-time recipe.
 * @returns Whether an existing SSH connection could survive a broken network or SSH listener.
 */
export function requiresNewSshConnection(unit: string | undefined): boolean {
    return (
        unit === "systemd-manager" ||
        unit === "dbus.service" ||
        /^(?:ssh|sshd|networking|NetworkManager|systemd-networkd|systemd-resolved|dhcpcd|connman|tailscaled)\.service$/.test(
            unit ?? ""
        )
    );
}

/**
 * Derive a fixed health and restart recipe for a name from a host's measured report.
 * Unrecognized report entries still have a stable identity for manual follow-up.
 * @param host - Server-owned host inspection and restart authority.
 * @param unit - Canonical entry returned by needrestart and systemd.
 * @returns The internal recipe. Admission additionally requires fresh, restartable evidence.
 */
export function discoveredMaintenanceTarget(
    host: MaintenanceTarget,
    unit: string
): MaintenanceTarget {
    if (host.kind !== "host" || !unit || unit.length > 255)
        throw new Error("Invalid reported maintenance target.");
    const manager = unit === "systemd-manager";
    const systemBus = unit === "dbus.service";
    const broker = unit === "dbus-broker.service";
    const supported =
        host.restartReportedServices === true &&
        !broker &&
        (manager || serviceName.test(unit));
    const dependent = requiresNewSshConnection(unit);
    // The classic bus uses its own detached systemd receipt on the target.
    const controller = supported && dependent && !systemBus ? host.proxmox : undefined;
    let externalReason: string | undefined;
    if (broker) {
        externalReason =
            "The system-bus recovery recipe supports the classic D-Bus daemon. Schedule host maintenance for this broker.";
    } else if (!supported) {
        externalReason = host.restartReportedServices
            ? "This report entry requires manual maintenance."
            : "This host is configured for observation only.";
    } else if (controller) {
        externalReason = "Proxmox verifies the service outside this guest.";
    }
    let impact = `Restart ${unit} and verify its recovery on ${host.label}.`;
    if (manager)
        impact =
            "Reload the host service manager and verify that Linux clears its restart requirement.";
    if (systemBus)
        impact =
            "Restart the system bus, reconnect verified clients and check a fresh SSH login.";
    const identity = new Bun.CryptoHasher("sha256")
        .update(JSON.stringify([host.id, unit]))
        .digest("hex");
    return {
        id: `reported-${identity.slice(0, 48)}`,
        connection: host.connection,
        kind: "service",
        reportedOn: host.id,
        service: unit,
        label: unit,
        impact,
        workerIndependent: supported && !controller,
        ...(controller ? { proxmox: controller } : {}),
        externalReason,
        health: dependent ? host.health : ["/usr/bin/systemctl", "is-active", "--", unit],
        preflight:
            host.preflight ??
            (/^ssh(d)?\.service$/.test(unit) ? ["/usr/sbin/sshd", "-t"] : undefined),
        lockConnections: host.lockConnections,
    };
}
