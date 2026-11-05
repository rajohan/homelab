"""Render the operator's private DNS and allowed destination networks before dropping capabilities."""
from ipaddress import ip_address, ip_network
from pathlib import Path
import sys


def render(mode,dns, lan4, lan6):
    if mode not in ("connected","internet"): raise ValueError("Choose an installed web network.")
    resolver, ipv4, ipv6 = ip_address(dns), ip_network(lan4), ip_network(lan6)
    if (ipv4.version != 4 or ipv6.version != 6 or resolver.version != 4 or resolver not in ipv4
            or not any(ipv4.subnet_of(ip_network(block)) for block in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
            or not ipv6.subnet_of(ip_network("fc00::/7"))):
        raise ValueError("Set a private IPv4 subnet containing its resolver and a ULA IPv6 subnet.")
    replacements = {"@dns@": str(resolver), "@squid_dns@": "127.0.0.1" if mode == "connected" else str(resolver), "@lan4@": str(ipv4), "@lan6@": str(ipv6)}
    for template, output in (("connected.conf.in", "connected-squid.conf"), ("connected.nft.in", "connected-egress.nft")):
        rules = (Path("/etc/mira-net") / template).read_text()
        rules = rules.replace("@allow_home@", "http_access allow connected" if mode=="connected" else "http_access deny connected").replace("@allow_internet@", "http_access allow internet" if mode=="internet" else "")
        rules = rules.replace("@home@", "accept" if mode=="connected" else "drop").replace("@internet@", "accept" if mode=="internet" else "drop")
        for token, value in replacements.items():
            rules = rules.replace(token, value)
        (Path("/tmp") / output).write_text(rules)


if __name__ == "__main__":
    render(*sys.argv[1:])
