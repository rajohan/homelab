"""Qualify the independent host journal with real systemd, Docker and PostgreSQL.

Registry references are synthetic: a narrow adapter maps the two test digests to
locally built images. Unit ownership, stop/start, Compose rendering, backup,
migration, health verification and recovery use the production runner unchanged.
Only uniquely named disposable services, images, containers and files are touched.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
HOST = ROOT / "apps/dashboard/src/server/integrations/releases/deploymentHost.py"
spec = importlib.util.spec_from_file_location("deployment_host", HOST)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/root", "LC_ALL": "C"}


def command(arguments, timeout=120, **kwargs):
    result = subprocess.run(arguments, env=ENV, capture_output=True, timeout=timeout, **kwargs)
    if result.returncode:
        raise RuntimeError("Qualification command failed: " + result.stderr.decode(errors="replace")[-1500:])
    return result.stdout


def wait(predicate, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.2)
    raise RuntimeError("Qualification deadline exceeded")


FIXTURE = r'''
import json,os,subprocess,sys,time
from pathlib import Path
from urllib.parse import urlsplit
root=Path(__file__).parent
settings=json.loads((root/'fixture.json').read_text())
database=urlsplit(settings['database'])
environment={'PATH':'/usr/bin:/bin','LC_ALL':'C','PGDATABASE':database.path[1:],
 'PGHOST':database.hostname,'PGPORT':str(database.port),'PGUSER':database.username,'PGPASSWORD':database.password}
def execute(args,check=True):
 return subprocess.run(args,env=environment,check=check,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
mode=sys.argv[1]
if mode=='up':
 reference=(root/'compose.yaml').read_text().split('image: ')[1].splitlines()[0].strip()
 execute(['/usr/bin/docker','rm','-f',settings['container']],False)
 execute(['/usr/bin/docker','run','-d','--name',settings['container'],'--network','none','--memory','128m','--cpus','0.5',
  '--label','com.docker.compose.project='+settings['project'],'--label','com.docker.compose.service='+settings['app'],
  '--label','homelab.test.reference='+reference,'--health-cmd','true','--health-interval','1s','--health-timeout','1s',
  settings['images'][reference],'/bin/sh','-c','while true; do sleep 1; done'])
elif mode=='stop':
 execute(['/usr/bin/docker','stop','--time','3',settings['container']])
elif mode=='backup':
 descriptor=os.open(root/'backup-error',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 os.dup2(descriptor,2);os.close(descriptor)
 os.environ.clear();os.environ.update(environment)
 os.environ['HOMELAB_AUTH_DATABASE_URL' if settings['app']=='auth' else 'HOMELAB_DASHBOARD_DATABASE_URL']=settings['database']
 os.execv('/usr/bin/python3',['/usr/bin/python3','-I','-B',sys.argv[2],'backup']+(['auth'] if settings['app']=='auth' else []))
elif mode=='migrate':
 if settings['app']=='auth': assert sys.argv[2]==settings['candidate']
 execute(['/usr/bin/psql','-v','ON_ERROR_STOP=1','-c','CREATE TABLE deployment_probe (id integer); INSERT INTO deployment_probe VALUES (42);'])
 if settings['scenario']=='interrupted':
  (root/'migration-started').write_text('yes')
  time.sleep(90)
elif mode=='restore':
 execute(['/usr/bin/psql','-v','ON_ERROR_STOP=1','-c','DROP SCHEMA public CASCADE; CREATE SCHEMA public;'])
 execute(['/usr/bin/pg_restore','--exit-on-error','--dbname',settings['database'],sys.argv[2]])
else:raise RuntimeError('Unexpected fixture mode')
'''

ADAPTER = r'''
_native_command=command
def command(arguments,directory,timeout=60,output_file=None):
    settings=json.loads((Path(directory)/'fixture.json').read_text())
    arguments=list(arguments)
    if arguments[:2]==['/usr/bin/docker','pull']:
        arguments=['/usr/bin/docker','image','inspect',settings['images'][arguments[-1]]]
    elif arguments[:3]==['/usr/bin/docker','image','inspect'] and arguments[-1] in settings['images']:
        arguments[-1]=settings['images'][arguments[-1]]
    try:
        result=_native_command(arguments,directory,timeout,output_file)
    except Exception:
        (Path(directory)/'failed-command').write_text(json.dumps(arguments))
        raise
    if arguments[:2]==['/usr/bin/docker','inspect']:
        values=json.loads(result)
        for value in values:
            value['Config']['Image']=value['Config']['Labels']['homelab.test.reference']
        result=json.dumps(values).encode()
    return result
'''


def qualify(directory, images, scenario, base, app):
    prefix = "homelab-release-test-" + uuid.uuid4().hex
    unit = prefix + ".service"
    unit_file = Path("/run/systemd/system") / unit
    project = prefix
    database = prefix + "-db"
    application = prefix + "-app"
    operation_id = str(uuid.uuid4())
    runner_unit = "homelab-release-" + operation_id.replace("-", "") + ".service"
    state = directory / "state"
    state.mkdir(mode=0o700)
    source = HOST.read_text().replace('if __name__ == "__main__":', ADAPTER + '\nif __name__ == "__main__":')
    test_runner = directory / "test-runner.py"
    test_runner.write_text(source)
    script = directory / "fixture.py"
    script.write_text(FIXTURE)
    references = [reference for reference in images if '/'+app+':' in reference]
    compose = directory / "compose.yaml"
    compose.write_text("name: " + project + "\nservices:\n  " + app + ":\n    image: " + references[0] + "\n")
    try:
        command(["docker", "run", "-d", "--rm", "--name", database, "--tmpfs", "/var/lib/postgresql:rw,size=256m",
                 "-p", "127.0.0.1::5432", "-e", "POSTGRES_USER=fixture", "-e", "POSTGRES_PASSWORD=synthetic-only",
                 "-e", "POSTGRES_DB=fixture", base])
        port = command(["docker", "port", database, "5432"]).decode().strip().rsplit(":", 1)[1]
        wait(lambda: subprocess.run(["docker", "exec", database, "pg_isready", "-h", "127.0.0.1", "-U", "fixture"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0)
        settings = {"app": app, "candidate": references[1], "project": project, "container": application, "database": "postgres://fixture:synthetic-only@127.0.0.1:" + port + "/fixture", "images": images, "scenario": scenario}
        private = directory / "fixture.json"
        private.write_text(json.dumps(settings)); private.chmod(0o600)
        unit_file.write_text("[Unit]\nDescription=Disposable release qualification\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/python3 -I -B " + str(script) + " up\nExecStop=/usr/bin/python3 -I -B " + str(script) + " stop\nTimeoutStartSec=30\nTimeoutStopSec=15\n")
        command(["systemctl", "daemon-reload"])
        command(["systemctl", "start", unit])
        wait(lambda: json.loads(command(["docker", "inspect", application]))[0]["State"]["Health"]["Status"] == "healthy")
        target = {"id": "fixture", "label": "Fixture", "connection": "fixture", "project": project, "directory": str(directory),
                  "composeFile": str(compose), "stateDirectory": str(state), "composeCommand": ["/usr/bin/docker", "compose", "-f", str(compose)],
                  "backupCommand": ["/usr/bin/python3", "-I", "-B", str(script), "backup", "{runner}"],
                  "migrateCommand": ["/usr/bin/python3", "-I", "-B", str(script), "migrate"] + (["{authImage}"] if app == "auth" else []), "mira": False,
                  "services": [{"name": app, "app": app}], "units": [unit]}
        release = {"repository": "demo/homelab", "version": "1.2.3", "revision": "c" * 40,
                   "images": [{"app": kind, "reference": next(reference for reference in images if '/'+kind+':1.2.3@' in reference)} for kind in ["auth", "dashboard"]]}
        def invoke(request):
            return json.loads(command(["python3", "-I", "-B", str(test_runner)], input=json.dumps(request).encode()))["result"]
        expected = invoke({"mode": "inspect", "target": target, "release": release})
        intent = {"id": operation_id, "target": target, "release": release, "expected": expected}
        invoke({"mode": "submit", **intent, "deadline": time.time() + 60})
        # The submitter exits here. All subsequent replacement work belongs to systemd.
        operation = state / operation_id
        if scenario == "success":
            wait(lambda: json.loads((operation / "status.json").read_text())["state"] != "running")
            result = invoke({"mode": "status", "id": operation_id, "target": target})
            if result["state"] != "succeeded":
                for name in ['failed-command','backup-error']:
                    if (directory/name).exists(): print(name,(directory/name).read_text()[-2000:],flush=True)
                raise AssertionError(result)
            assert result["containers"][app]["id"] != expected["containers"][app]["id"]
            assert result["containers"][app]["image"] == references[1]
            assert result["requestHash"] == host.digest(host.encoded(intent))
            assert (operation / "database.dump").stat().st_size > 100
            duplicate = invoke({"mode": "submit", **intent, "deadline": time.time() + 60})
            assert duplicate["state"] == "succeeded"
        else:
            wait(lambda: (directory / "migration-started").exists())
            command(["systemctl", "stop", runner_unit])
            result = invoke({"mode": "status", "id": operation_id, "target": target})
            assert result["state"] == "unknown" and result["migrationStarted"], result
            assert not json.loads(command(["docker", "inspect", application]))[0]["State"]["Running"]
            command(["python3", "-I", "-B", str(script), "restore", str(operation / "database.dump")])
            compose.write_bytes((operation / "compose.before").read_bytes())
            command(["systemctl", "start", unit])
            command(["python3", "-I", "-B", str(operation / "runner.py"), "recover", str(operation), "--database-restored"])
            result = invoke({"mode": "status", "id": operation_id, "target": target})
            assert result["state"] == "failed" and result["recovered"] and result["code"] == "operator_recovered", result
            count = command(["docker", "exec", database, "psql", "-U", "fixture", "-d", "fixture", "-Atc", "SELECT count(*) FROM information_schema.tables WHERE table_name='deployment_probe'"])
            assert count.strip() == b"0"
        print("PASS:", app, scenario, "real systemd ownership, containers, backup and receipt", flush=True)
    finally:
        for name in [runner_unit, unit]:
            subprocess.run(["systemctl", "stop", name], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["systemctl", "reset-failed", name], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if unit_file.exists(): unit_file.unlink()
        command(["systemctl", "daemon-reload"])
        for container in [application, database]:
            subprocess.run(["docker", "rm", "-f", container], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    if os.geteuid() != 0:
        raise RuntimeError("This qualification owns disposable systemd units and requires root on a test host.")
    version = command(["pg_dump", "--version"]).decode()
    major = re.search(r"PostgreSQL\) (\d+)\.", version).group(1)
    base = "postgres:" + major
    command(["docker", "pull", base], timeout=300)
    with tempfile.TemporaryDirectory(prefix="homelab-release-qualification-") as temporary:
        root = Path(temporary)
        images = {}
        try:
            for version, digest in [("1.2.2", "a"), ("1.2.3", "b")]:
                tag = "homelab-release-qualification-" + uuid.uuid4().hex + ":" + version
                dockerfile = ("FROM " + base + "\nLABEL org.opencontainers.image.source=https://github.com/demo/homelab\nLABEL org.opencontainers.image.version=" + version + "\nLABEL org.opencontainers.image.revision=" + "c" * 40 + "\n")
                command(["docker", "build", "--provenance=false", "-t", tag, "-"], input=dockerfile.encode(), timeout=300)
                images["ghcr.io/demo/homelab/dashboard:" + version + "@sha256:" + digest * 64] = tag
                images["ghcr.io/demo/homelab/auth:" + version + "@sha256:" + digest * 64] = tag
            for app in ["dashboard", "auth"]:
                for scenario in ["success", "interrupted"]:
                    directory = root / (app + '-' + scenario)
                    directory.mkdir(mode=0o700)
                    qualify(directory, images, scenario, base, app)
        finally:
            for image in set(images.values()):
                subprocess.run(["docker", "image", "rm", image], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
