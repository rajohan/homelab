"""Synthetic cgroup fixtures: never read production identity or service data."""
import json
from pathlib import Path
import tempfile
import unittest

import homelab_native_metrics as metrics


class NativeMetricsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.slice = self.root / 'system.slice'
        self.slice.mkdir()
        self.app = {'project': 'test', 'service': 'app', 'units': {'one.service': True}}

    def unit(self, name='one.service', **overrides):
        path = self.slice / name
        path.mkdir(exist_ok=True)
        for name, value in {
            'cpu.stat': 'usage_usec 2000000\n', 'cpu.max': 'max 100000',
            'memory.stat': 'inactive_file 256\n', 'memory.current': '1024',
            'memory.max': 'max', 'pids.current': '4',
        }.items():
            (path / name).write_text(value)
        return {
            'LoadState': 'loaded', 'ActiveState': 'active',
            'ControlGroup': '/system.slice/' + path.name,
            'IPAccounting': 'yes', 'IPIngressBytes': '100', 'IPEgressBytes': '200',
            'IOAccounting': 'yes', 'IOReadBytes': '300', 'IOWriteBytes': '400',
            **overrides,
        }

    def render(self, states, app=None):
        return metrics.render([app or self.app], states, 1000, self.root, {0, 1, 2, 3})

    def test_live_values_exclude_inactive_cache_and_never_use_host_memory(self):
        text = self.render({'one.service': self.unit()})
        self.assertIn('memory_working_set_bytes{project="test",service="app"} 768', text)
        self.assertIn('memory_limit_bytes{project="test",service="app"} 0', text)
        self.assertIn('cpu_capacity_cores{project="test",service="app"} 4', text)
        self.assertIn('cpu_usage_seconds_total{project="test",service="app",unit="one.service"} 2.0', text)
        self.assertIn('network_available{project="test",service="app"} 1', text)

    def test_restarts_keep_counters_per_unit_and_optional_idle_jobs_do_not_fail(self):
        app = {**self.app, 'units': {'one.service': True, 'two.service': True, 'job.service': False}}
        states = {'one.service': self.unit(), 'two.service': self.unit('two.service'),
                  'job.service': {'LoadState': 'loaded', 'ActiveState': 'inactive', 'ControlGroup': ''}}
        text = self.render(states, app)
        self.assertEqual(text.count('homelab_native_unit_cpu_usage_seconds_total'), 2)
        self.assertIn('cpu_capacity_cores{project="test",service="app"} 4', text)
        self.assertIn('memory_working_set_bytes{project="test",service="app"} 1536', text)
        self.assertIn('unit_running{project="test",service="app",unit="job.service"} 0', text)
        (self.slice / 'one.service' / 'cpu.stat').write_text('usage_usec 100000\n')
        text = self.render(states, app)
        self.assertIn('unit="one.service"} 0.1', text)
        self.assertIn('unit="two.service"} 2.0', text)

    def test_shared_parent_quotas_and_cpuset_limits_are_not_counted_twice(self):
        self.unit()
        self.unit('two.service')
        paths = [self.slice / 'one.service', self.slice / 'two.service']
        (paths[0] / 'cpu.max').write_text('50000 100000')
        (paths[1] / 'cpu.max').write_text('100000 100000')
        (paths[0] / 'memory.max').write_text('1024')
        (paths[1] / 'memory.max').write_text('2048')
        self.assertEqual(metrics.limits(paths, self.root, {0, 1, 2, 3}), (1.5, 3072))
        (self.slice / 'cpu.max').write_text('100000 100000')
        (self.slice / 'memory.max').write_text('2500')
        self.assertEqual(metrics.limits(paths, self.root, {0, 1, 2, 3}), (1, 2500))
        (paths[0] / 'cpuset.cpus.effective').write_text('1-2')
        self.assertEqual(metrics.cpu_set('0-2,1,4'), {0, 1, 2, 4})
        with self.assertRaises(ValueError):
            metrics.limits([paths[0], self.slice], self.root, {0, 1})

    def test_failed_or_stopped_units_publish_failure_not_fake_zero_usage(self):
        for states in ({}, {'one.service': self.unit(ActiveState='inactive')},
                       {'one.service': self.unit(ControlGroup='/../../private')}):
            text = self.render(states)
            self.assertIn('metrics_success{project="test",service="app"} 0', text)
            self.assertNotIn('memory_working_set_bytes', text)
            self.assertNotIn('last_sample_timestamp_seconds', text)

    def test_unavailable_accounting_is_omitted_and_partial_aggregation_is_flagged(self):
        text = self.render({'one.service': self.unit(IPIngressBytes='[no data]', IOAccounting='no')})
        self.assertNotIn('unit_network_rx_bytes_total', text)
        self.assertNotIn('unit_block_read_bytes_total', text)
        self.assertIn('network_available{project="test",service="app"} 0', text)
        self.assertIn('block_available{project="test",service="app"} 0', text)
        self.assertIn('metrics_success{project="test",service="app"} 1', text)

    def test_inventory_rejects_duplicate_units_and_unbounded_identifiers(self):
        config = {'test': [self.app]}
        self.assertEqual(metrics.inventory(config, 'test')[1], ['one.service'])
        for other in ({**self.app, 'service': 'other'}, {**self.app, 'service': '../other'}):
            with self.assertRaises(ValueError):
                metrics.inventory({'test': [self.app, other]}, 'test')
        self.assertNotIn('password', json.dumps(config))


if __name__ == '__main__':
    unittest.main()
