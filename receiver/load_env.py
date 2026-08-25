import os
import shlex
import subprocess

Import("env")


# The page reloads itself when the firmware it is talking to reports a build it
# did not load from, so a flash has to change this.
def build_id():
    try:
        out = subprocess.run(["git", "describe", "--always", "--dirty", "--exclude", "*"],
                             cwd=env.subst("$PROJECT_DIR"), capture_output=True, text=True)
    except OSError:
        return "dev"
    return out.stdout.strip() if out.returncode == 0 and out.stdout.strip() else "dev"


env.Append(CPPDEFINES=[("BUILD_ID", '\\"%s\\"' % build_id())])

path = os.path.join(env.subst("$PROJECT_DIR"), ".env")
if os.path.isfile(path):
    with open(path) as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export "):]
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = " ".join(shlex.split(value))
            if not value:
                continue
            # The macro rides through SCons' double-quoted shell argument, so
            # each byte the compiler must see escaped is escaped twice.
            value = value.replace("\\", "\\\\\\\\").replace('"', '\\\\\\"')
            env.Append(CPPDEFINES=[(key.strip(), '\\"%s\\"' % value)])
