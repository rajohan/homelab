#!/usr/bin/env python3
"""Export numeric cgroup/systemd counters for an explicit native application inventory."""
import argparse
import json
import math
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time

ROOT = Path('/sys/fs/cgroup')
TARGET = Path('/var/lib/homelab-native-resources/native-resources.prom')
PROPERTIES = ('Id,LoadState,ActiveState,ControlGroup,IPAccounting,IPIngressBytes,'
              'IPEgressBytes,IOAccounting,IOReadBytes,IOWriteBytes')


def read(path, optional=False):
    """Bound reads of kernel-owned counters; absence is distinct from zero."""
    try:
        with path.open() as stream:
            text = stream.read(65537)
    except FileNotFoundError:
        if optional:
            return None
        raise
    if len(text) > 65536:
        raise ValueError('Oversized counter')
    return text.strip()


def integer(value):
    """Accept only unsigned decimal kernel/systemd counters."""
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{1,24}', value):
        raise ValueError('Invalid counter')
    return int(value)


def cpu_set(text):
    """Expand a bounded Linux CPU list without counting overlapping ranges twice."""
    result = set()
    for part in text.split(','):
        if not re.fullmatch(r'[0-9]{1,5}(?:-[0-9]{1,5})?', part):
            raise ValueError('Invalid CPU set')
        bounds = [int(value) for value in part.split('-')]
        if bounds[-1] < bounds[0] or bounds[-1] > 65535:
            raise ValueError('Invalid CPU range')
        result.update(range(bounds[0], bounds[-1] + 1))
    return result


def limits(paths, root=ROOT, online=None):
    """Combine disjoint service ceilings, respecting shared ancestor quotas and CPU sets."""
    online = online if online is not None else cpu_set(read(Path('/sys/devices/system/cpu/online')))
    if len(set(paths)) != len(paths) or any(a in b.parents for a in paths for b in paths if a != b):
        raise ValueError('Overlapping cgroups')

    def walk(path, leaves, allowed):
        configured = read(path / 'cpuset.cpus.effective', optional=True)
        allowed = allowed & cpu_set(configured) if configured else allowed
        quota = read(path / 'cpu.max', optional=True)
        cpu = math.inf
        if quota:
            amount, period = quota.split()
            if amount != 'max':
                cpu = integer(amount) / integer(period)
        memory = read(path / 'memory.max', optional=True)
        memory = math.inf if memory in (None, 'max') else integer(memory)
        if path not in leaves:
            children = {path / leaf.relative_to(path).parts[0] for leaf in leaves}
            bounds = [walk(child, [leaf for leaf in leaves if leaf == child or child in leaf.parents], allowed)
                      for child in children]
            allowed = set().union(*(item[2] for item in bounds))
            cpu = min(cpu, sum(item[0] for item in bounds))
            memory = min(memory, sum(item[1] for item in bounds))
        return min(cpu, len(allowed)), memory, allowed

    cpu, memory, _ = walk(root, paths, online)
    if cpu <= 0:
        raise ValueError('No CPU capacity')
    return cpu, 0 if math.isinf(memory) else memory


def inventory(configuration, host):
    """Validate a small explicit allowlist; a systemd unit belongs to exactly one app."""
    apps = configuration[host]
    if not isinstance(apps, list) or not 1 <= len(apps) <= 16:
        raise ValueError('Invalid inventory')
    units, identities = set(), set()
    for app in apps:
        identity = (app['project'], app['service'])
        if identity in identities or any(not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', item) for item in identity):
            raise ValueError('Invalid identity')
        identities.add(identity)
        if not isinstance(app['units'], dict) or not 1 <= len(app['units']) <= 16 or True not in app['units'].values():
            raise ValueError('Invalid units')
        for unit, required in app['units'].items():
            if unit in units or not re.fullmatch(r'[a-zA-Z0-9_.@-]{1,120}\.service', unit) or type(required) is not bool:
                raise ValueError('Invalid or reused unit')
            units.add(unit)
    if len(units) > 32:
        raise ValueError('Excessive unit count')
    return apps, sorted(units)


def unit_values(fields, root=ROOT):
    """Read one live service cgroup, never /proc command lines, environments or host totals."""
    group = fields['ControlGroup']
    if not group.startswith('/') or '..' in Path(group).parts:
        raise ValueError('Invalid cgroup path')
    path = (root / group.lstrip('/')).resolve(strict=True)
    if root not in path.parents:
        raise ValueError('Unexpected cgroup root')
    cpu = dict(line.split() for line in read(path / 'cpu.stat').splitlines())
    memory = dict(line.split() for line in read(path / 'memory.stat').splitlines())
    values = {
        'cpu_usage_seconds_total': integer(cpu['usage_usec']) / 1e6,
        'memory_working_set_bytes': max(0, integer(read(path / 'memory.current')) - integer(memory['inactive_file'])),
        'pids': integer(read(path / 'pids.current')),
    }
    for property_name, metric, enabled in (
        ('IPIngressBytes', 'network_rx_bytes_total', 'IPAccounting'),
        ('IPEgressBytes', 'network_tx_bytes_total', 'IPAccounting'),
        ('IOReadBytes', 'block_read_bytes_total', 'IOAccounting'),
        ('IOWriteBytes', 'block_write_bytes_total', 'IOAccounting'),
    ):
        value = fields.get(property_name, '')
        if fields.get(enabled) == 'yes' and re.fullmatch(r'[0-9]{1,24}', value):
            values[metric] = integer(value)
    return path, values


def metric(name, value, labels):
    """Render approved labels and finite numeric values only."""
    if not math.isfinite(value) or value < 0:
        raise ValueError('Invalid metric')
    suffix = ','.join(key + '=' + json.dumps(value) for key, value in labels.items())
    return 'homelab_native_' + name + '{' + suffix + '} ' + str(value)


def render(apps, states, now, root=ROOT, online=None):
    """Keep unit counters separate so one restart cannot reset another unit's history."""
    lines = []
    for app in apps:
        labels = {'project': app['project'], 'service': app['service']}
        lines.append(metric('app_info', 1, labels))
        values, unit_lines, paths = [], [], []
        success = False
        try:
            for unit, required in app['units'].items():
                fields = states[unit]
                running = fields.get('ActiveState') in ('active', 'activating') and bool(fields.get('ControlGroup'))
                if fields.get('LoadState') != 'loaded' or (required and not running):
                    raise ValueError('Required unit unavailable')
                unit_labels = {**labels, 'unit': unit}
                unit_lines.append(metric('unit_running', int(running), unit_labels))
                if not running:
                    continue
                path, current = unit_values(fields, root)
                paths.append(path)
                values.append(current)
                unit_lines.extend(metric('unit_' + key, value, unit_labels)
                                  for key, value in current.items() if key.endswith('_total'))
            cpu, memory = limits(paths, root, online)
            result = {
                'cpu_capacity_cores': cpu, 'memory_limit_bytes': memory,
                'memory_working_set_bytes': sum(item['memory_working_set_bytes'] for item in values),
                'pids': sum(item['pids'] for item in values),
                'last_sample_timestamp_seconds': now,
            }
            # A partial sum must not masquerade as complete network or I/O accounting.
            for family in ('network', 'block'):
                keys = ('network_rx_bytes_total', 'network_tx_bytes_total') if family == 'network' else ('block_read_bytes_total', 'block_write_bytes_total')
                result[family + '_available'] = int(all(all(key in item for key in keys) for item in values))
            lines.extend(unit_lines)
            lines.extend(metric(key, value, labels) for key, value in result.items())
            success = True
        except (KeyError, ValueError, OSError, ZeroDivisionError):
            pass
        lines.append(metric('metrics_success', int(success), labels))
    return '\n'.join(lines) + '\n'


def atomic_write(text):
    """Replace only the owned numeric textfile, leaving health collection independent."""
    if not TARGET.parent.is_dir() or TARGET.parent.is_symlink() or TARGET.is_symlink():
        raise ValueError('Unexpected textfile path')
    fd, name = tempfile.mkstemp(prefix='.native-resources-', dir=TARGET.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(text)
            stream.flush()
            os.fchmod(stream.fileno(), 0o644)
        os.replace(name, TARGET)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    """Collect an allowlisted systemd snapshot within a fixed service deadline."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='/etc/homelab-native-resources.json')
    parser.add_argument('--stdout', action='store_true')
    args = parser.parse_args()
    apps, units = inventory(json.loads(read(Path(args.config))), socket.gethostname().split('.')[0])
    states = {}
    try:
        result = subprocess.run(['/usr/bin/systemctl', 'show', *units, '--property=' + PROPERTIES],
                                capture_output=True, text=True, timeout=3,
                                env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
        if result.returncode or len(result.stdout) > 131072:
            raise ValueError('Invalid systemd response')
        for block in result.stdout.strip().split('\n\n'):
            fields = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
            if fields.get('Id') in units:
                states[fields['Id']] = fields
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    text = render(apps, states, time.time())
    if args.stdout:
        print(text, end='')
    else:
        atomic_write(text)


if __name__ == '__main__':
    main()
