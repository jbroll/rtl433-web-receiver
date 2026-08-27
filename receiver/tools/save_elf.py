import os
import shutil
import subprocess

Import("env")


# fetch_coredump.sh needs the ELF that matches whatever build produced a given
# dump, not just whatever's newest in .pio/build/ (which a later build may have
# overwritten before the dump is fetched).
def build_id():
    try:
        out = subprocess.run(["git", "describe", "--always", "--dirty", "--exclude", "*"],
                             cwd=env.subst("$PROJECT_DIR"), capture_output=True, text=True)
    except OSError:
        return "dev"
    return out.stdout.strip() if out.returncode == 0 and out.stdout.strip() else "dev"


def save_elf(source, target, env):
    elf_dir = os.path.join(env.subst("$PROJECT_DIR"), "tools", "elf")
    os.makedirs(elf_dir, exist_ok=True)
    shutil.copy(str(target[0]), os.path.join(elf_dir, build_id() + ".elf"))


env.AddPostAction("$BUILD_DIR/${PROGNAME}.elf", save_elf)
