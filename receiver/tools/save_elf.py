import os
import shutil
import subprocess

Import("env")


# Saves the ELF fetch_coredump.sh needs to match a given dump, since a later
# build may overwrite .pio/build/ before the dump is fetched.
def build_id():
    try:
        out = subprocess.run(["git", "describe", "--always", "--dirty", "--exclude", "*"],
                             cwd=env.subst("$PROJECT_DIR"), capture_output=True, text=True)
    except OSError:
        return "dev"
    return out.stdout.strip() if out.returncode == 0 and out.stdout.strip() else "dev"


def save_elf(source, target, env):
    # A convenience copy for later core-dump symbolication must never fail the
    # firmware build, so any error here is swallowed after a warning.
    try:
        elf_dir = os.path.join(env.subst("$PROJECT_DIR"), "tools", "elf")
        os.makedirs(elf_dir, exist_ok=True)
        # The environment name is part of the file name: two boards built from
        # the same commit would otherwise overwrite each other's ELF, and
        # symbolicating a dump against the wrong board's build produces
        # plausible wrong frames rather than an obvious failure.
        name = "%s-%s.elf" % (build_id(), env.subst("$PIOENV"))
        shutil.copy(str(target[0]), os.path.join(elf_dir, name))
    except OSError as e:
        print("save_elf.py: warning: could not save ELF copy: %s" % e)


env.AddPostAction("$BUILD_DIR/${PROGNAME}.elf", save_elf)
