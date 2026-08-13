import os
import shlex

Import("env")

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
            env.Append(CPPDEFINES=[(key.strip(), '\\"%s\\"' % shlex.split(value)[0])])
