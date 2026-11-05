"""Loopback-only Squid resolver. A hostname cannot cross the LAN boundary mid-session."""
import asyncio
from collections import OrderedDict
from ipaddress import ip_address, ip_network
import os
from pathlib import Path
import sys
import time

import dns.asyncresolver
import dns.exception
import dns.message
import dns.rcode
import dns.rdataclass
import dns.rdatatype
import dns.rrset
import dns.resolver


class PinnedResolver(asyncio.DatagramProtocol):
    def __init__(self, upstream, lan4, lan6):
        self.upstream = dns.asyncresolver.Resolver(configure=False)
        self.upstream.nameservers = [upstream]
        self.upstream.lifetime = 2
        self.networks = tuple(map(ip_network, (lan4, lan6, "100.64.0.0/10")))
        self.pins = OrderedDict()
        self.tasks = set()

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, wire, client):
        # Only the local Squid can query. Bound parallelism and never evict a live pin.
        if len(self.tasks) >= 32 or len(wire) > 4096:
            return
        task = asyncio.create_task(self.answer(wire, client))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def pin(self, name, addresses):
        classes = set()
        for value in addresses:
            ip = ip_address(value)
            if any(ip in net for net in self.networks):
                classes.add("lan")
            elif ip.is_global and not ip.is_multicast and not getattr(ip, "ipv4_mapped", None):
                classes.add("public")
            else:
                return False
        if len(classes) != 1:
            return False
        destination = classes.pop()
        now = time.monotonic()
        # Exceeds both the five-minute maximum grant and Squid's address cache TTL.
        while self.pins and next(iter(self.pins.values()))[1] <= now:
            self.pins.popitem(last=False)
        prior = self.pins.get(name)
        if (prior and prior[0] != destination) or (not prior and len(self.pins) >= 8192):
            return False
        self.pins[name] = destination, now + 1800
        self.pins.move_to_end(name)
        return True

    async def answer(self, wire, client):
        try:
            query = dns.message.from_wire(wire)
            if len(query.question) != 1:
                return
            q = query.question[0]
            reply = dns.message.make_response(query)
            if q.rdclass != dns.rdataclass.IN or q.rdtype not in (dns.rdatatype.A, dns.rdatatype.AAAA):
                reply.set_rcode(dns.rcode.REFUSED)
            else:
                name = q.name.canonicalize()
                try:
                    # Resolve both families together, follow upstream CNAMEs, and emit only
                    # flat addresses for the original name. No unchecked Additional records.
                    a, aaaa = await asyncio.gather(*(self.upstream.resolve(name, kind, raise_on_no_answer=False, search=False)
                                                    for kind in ("A", "AAAA")))
                    records = [tuple(item.address for item in (answer.rrset or ())) for answer in (a, aaaa)]
                    if any(records):
                        if self.pin(name, records[0] + records[1]):
                            selected = records[q.rdtype == dns.rdatatype.AAAA]
                            if selected:
                                reply.answer.append(dns.rrset.from_text_list(q.name, 5, "IN", q.rdtype, selected[:6]))
                        else:
                            reply.set_rcode(dns.rcode.REFUSED)
                except dns.resolver.NXDOMAIN:
                    reply.set_rcode(dns.rcode.NXDOMAIN)
                except (dns.exception.DNSException, OSError, ValueError):
                    reply.set_rcode(dns.rcode.SERVFAIL)
            self.transport.sendto(reply.to_wire(max_size=512), client)
        except (dns.exception.DNSException, ValueError):
            return


async def serve(upstream, lan4, lan6):
    loop = asyncio.get_running_loop()
    await loop.create_datagram_endpoint(lambda: PinnedResolver(upstream, lan4, lan6), local_addr=("127.0.0.1", 53))
    Path("/tmp/mira-dns.pid").write_text(str(os.getpid()))
    await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(serve(*sys.argv[1:]))
