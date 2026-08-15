import os
import subprocess

Import("env")

# The page the firmware serves is a build of dashboard/, not a checked-in
# literal, so node is a requirement for pio run.
generated = os.path.join(env.subst("$BUILD_DIR"), "generated")
header = os.path.join(generated, "dashboard_html.h")
builder = os.path.join(env.subst("$PROJECT_DIR"), "..", "dashboard", "build.js")

subprocess.run(["node", builder, "--progmem", header], check=True)

env.Append(CPPPATH=[generated])
