"""Render the operator's private DNS and allowed destination networks before dropping capabilities."""
from ipaddress import ip_address, ip_network
from pathlib import Path
import sys


def render(mode,dns, lan4, lan6, dev_host=""):
    if mode not in ("connected","internet"): raise ValueError("Choose an installed web network.")
    resolver, ipv4, ipv6 = ip_address(dns), ip_network(lan4), ip_network(lan6)
    if (ipv4.version != 4 or ipv6.version != 6 or resolver.version != 4 or resolver not in ipv4
            or not any(ipv4.subnet_of(ip_network(block)) for block in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
            or not ipv6.subnet_of(ip_network("fc00::/7"))):
        raise ValueError("Set a private IPv4 subnet containing its resolver and a ULA IPv6 subnet.")
    dev = ip_address(dev_host) if dev_host else None
    if dev and (mode != "connected" or dev.version != 4 or dev.is_loopback or dev.is_link_local
                or not any(dev in ip_network(block) for block in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))):
        raise ValueError("The development host must be a private Docker bridge IPv4 address.")
    Path("/tmp/dev-hosts").write_text(f"{dev} localhost\n" if dev else "")
    replacements = {"@dns@": str(resolver), "@squid_dns@": "127.0.0.1" if mode == "connected" else str(resolver), "@lan4@": str(ipv4), "@lan6@": str(ipv6)}
    for template, output in (("connected.conf.in", "connected-squid.conf"), ("connected.nft.in", "connected-egress.nft")):
        rules = (Path("/etc/mira-net") / template).read_text()
        rules = rules.replace("@allow_home@", "http_access allow connected" if mode=="connected" else "http_access deny connected").replace("@allow_internet@", "http_access allow internet")
        rules = rules.replace("@home@", "accept" if mode=="connected" else "drop").replace("@internet@", "accept")
        rules = rules.replace("@dev_acl@", (
            f"hosts_file /tmp/dev-hosts\nacl dev_host dstdomain localhost\nacl dev_ports port 3100 3101 8400\n"
            f"acl dev_target dst {dev}/32\nhttp_access allow dev_host dev_ports dev_target\nhttp_access deny dev_host"
            if dev else "acl dev_host dstdomain localhost\nhttp_access deny dev_host"))
        rules = rules.replace("@dev_network@", f"ip daddr {dev} tcp dport {{ 3100, 3101, 8400 }} accept" if dev else "")
        for token, value in replacements.items():
            rules = rules.replace(token, value)
        (Path("/tmp") / output).write_text(rules)


if __name__ == "__main__":
    render(*sys.argv[1:])
