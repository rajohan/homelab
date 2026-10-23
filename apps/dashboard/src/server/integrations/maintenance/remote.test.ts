import { expect, test } from "bun:test";

import program from "./remote.py" with { type: "text" };

test("the actual remote adapter preserves stopped services and fences reboot requests to the approved boot", async () => {
    const script = `
import json, sys, io
source = json.load(sys.stdin)
scope = {"__name__": "fixture"}
exec(source, scope)
boot = "11111111-1111-4111-8111-111111111111"
commands = []
active = "active"
class FakePath:
    def __init__(self, path): self.path = path
    def read_text(self): return boot
    def exists(self): return False
    def is_file(self): return False
def fake_run(argv, timeout=30):
    commands.append(argv)
    return active if "show" in argv else ""
scope["Path"] = FakePath
scope["run"] = fake_run
target = {"kind": "service", "service": "example.service", "health": ["/usr/bin/true"]}
def invoke(mode, expected):
    scope["sys"].stdin = io.TextIOWrapper(io.BytesIO(json.dumps({"target": target, "mode": mode, "expected": expected}).encode()))
    return scope["main"]()
before = {"bootId": boot, "active": "active"}
assert invoke("restart", before)["health"] is True
assert commands.count(["/usr/bin/systemctl", "restart", "example.service"]) == 1
commands.clear()
active = "inactive"
try:
    invoke("restart", {"bootId": boot, "active": "inactive"})
    raise AssertionError("A stopped service was restarted")
except RuntimeError: pass
assert not any("restart" in command for command in commands)
target = {"kind": "host", "health": ["/usr/bin/true"]}
commands.clear()
try:
    invoke("restart", {"bootId": "22222222-2222-4222-8222-222222222222", "active": None})
    raise AssertionError("Changed boot identity accepted")
except RuntimeError: pass
assert not commands
invoke("restart", {"bootId": boot, "active": None})
assert commands == [["/usr/bin/systemctl", "--no-block", "reboot"]]
print("qualified")
`;
    const child = Bun.spawn(["python3", "-c", script], {
        stdin: new TextEncoder().encode(JSON.stringify(program)),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    expect(error).toBe("");
    expect(code).toBe(0);
    expect(output.trim()).toBe("qualified");
});
