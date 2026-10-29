#!/usr/bin/env python3
"""Install, remove or inspect the Claude Code hooks that drive 小克's work-status animations.

Each hook is an async curl that posts the hook's stdin JSON to the pet host
(http://127.0.0.1:3081/dsh-pet-7340/claude-hook). Async hooks only report:
Claude Code ignores their output, so other tools' hooks (agent-hud's blocking
PermissionRequest among them) keep deciding exactly as before.

    python tools/macos/claude_hooks.py install
    python tools/macos/claude_hooks.py uninstall
    python tools/macos/claude_hooks.py status

install and uninstall copy ~/.claude/settings.json to
settings.json.bak-before-little-pet-<time> before writing, and touch only the
entries whose command posts to the pet host. install also turns on work status
for 小克 in ~/.dsh/dsh-pet/characters/ojousama/config.json (backed up the same
way), adding the clip slots if that copy predates them.
"""

import argparse
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ENDPOINT = "http://127.0.0.1:3081/dsh-pet-7340/claude-hook"
COMMAND = (
    "curl -s -m 2 -o /dev/null -H 'content-type: application/json' "
    f"--data-binary @- {ENDPOINT} || true"
)
# Event -> matcher (None: the event takes no matcher).
EVENTS = {
    "UserPromptSubmit": None,
    "PreToolUse": "",
    "PostToolUse": "",
    "PostToolUseFailure": "",
    "PermissionRequest": "",
    "Notification": "permission_prompt|elicitation_dialog|agent_needs_input",
    "PreCompact": None,
    "Stop": None,
    "StopFailure": None,
    "SessionEnd": None,
}

REPO = Path(__file__).resolve().parents[2]
BUNDLED_PET = REPO / "characters" / "ojousama" / "config.json"


def settings_path() -> Path:
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(base).expanduser() if base else Path.home() / ".claude") / "settings.json"


def pet_config_path() -> Path:
    home = os.environ.get("DSH_HOME")
    root = Path(home).expanduser() if home else Path.home() / ".dsh"
    return root / "dsh-pet" / "characters" / "ojousama" / "config.json"


def ours(hook) -> bool:
    return isinstance(hook, dict) and ENDPOINT in str(hook.get("command", ""))


def backup(path: Path) -> Path:
    target = path.with_name(f"{path.name}.bak-before-little-pet-{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(path, target)
    return target


def read_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise SystemExit(f"{path} is not a JSON object; nothing changed.")
    return data


def write_json(path: Path, data: dict) -> None:
    tmp = path.with_name(path.name + ".little-pet-tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def strip_ours(hooks: dict) -> int:
    """Removes our hooks from every event; drops groups and events left empty. Returns how many went."""
    removed = 0
    for event in list(hooks):
        groups = hooks[event]
        if not isinstance(groups, list):
            continue
        kept = []
        for group in groups:
            inner = group.get("hooks") if isinstance(group, dict) else None
            if not isinstance(inner, list):
                kept.append(group)
                continue
            left = [h for h in inner if not ours(h)]
            removed += len(inner) - len(left)
            if left:
                kept.append({**group, "hooks": left})
            elif len(inner) == 0:
                kept.append(group)
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    return removed


def hooks_of(settings: dict) -> dict:
    hooks = settings.get("hooks")
    if hooks is None:
        hooks = settings["hooks"] = {}
    if not isinstance(hooks, dict):
        raise SystemExit("settings.json has a \"hooks\" value that is not an object; nothing changed.")
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            raise SystemExit(f"settings.json hooks.{event} is not a list; nothing changed.")
    return hooks


def enable_pet() -> None:
    path = pet_config_path()
    if not path.exists():
        print(f"小克 config not found at {path}; start 小小桌宠 once, then run install again to turn on work status.")
        return
    config = read_json(path)
    bundled = read_json(BUNDLED_PET)
    changed = False
    for pet in config.get("pets", []):
        if isinstance(pet, dict) and pet.get("workStatusEnabled") is not True:
            pet["workStatusEnabled"] = True
            changed = True
    # An empty list was the first build's "animation only"; the bundled short lines replace it.
    if not config.get("workStatusTexts"):
        config["workStatusTexts"] = bundled["workStatusTexts"]
        changed = True
    events = config.setdefault("animations", {}).setdefault("events", {})
    if "workStatus" not in events:
        events["workStatus"] = bundled["animations"]["events"]["workStatus"]
        changed = True
    if not changed:
        print(f"小克 work status already on in {path}")
        return
    print(f"Backed up {path.name} to {backup(path).name}")
    write_json(path, config)
    print(f"Turned on work status for 小克 in {path}")


def install() -> None:
    path = settings_path()
    settings = read_json(path) if path.exists() else {}
    hooks = hooks_of(settings)
    strip_ours(hooks)
    for event, matcher in EVENTS.items():
        group = {"hooks": [{"type": "command", "command": COMMAND, "async": True, "timeout": 5}]}
        if matcher is not None:
            group = {"matcher": matcher, **group}
        hooks.setdefault(event, []).append(group)
    if path.exists():
        print(f"Backed up {path.name} to {backup(path).name}")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
    write_json(path, settings)
    print(f"Installed {len(EVENTS)} hooks in {path}")
    enable_pet()
    print("New Claude Code sessions pick the hooks up; restart running ones.")


def uninstall() -> None:
    path = settings_path()
    if not path.exists():
        print(f"{path} does not exist; nothing to remove.")
        return
    settings = read_json(path)
    if not isinstance(settings.get("hooks"), dict):
        print("No hooks in settings.json; nothing to remove.")
        return
    hooks = hooks_of(settings)
    removed = strip_ours(hooks)
    if not removed:
        print("No little-pet hooks in settings.json; nothing changed.")
        return
    if not hooks:
        del settings["hooks"]
    print(f"Backed up {path.name} to {backup(path).name}")
    write_json(path, settings)
    print(f"Removed {removed} hooks from {path}")


def status() -> None:
    path = settings_path()
    settings = read_json(path) if path.exists() else {}
    hooks = settings.get("hooks") if isinstance(settings.get("hooks"), dict) else {}
    mine, others = [], []
    for event, groups in hooks.items():
        for group in groups if isinstance(groups, list) else []:
            for h in (group.get("hooks") or []) if isinstance(group, dict) else []:
                (mine if ours(h) else others).append(event)
    print(f"{path}")
    print(f"  little-pet hooks: {', '.join(mine) if mine else 'none'}")
    missing = [e for e in EVENTS if e not in mine]
    if mine and missing:
        print(f"  missing: {', '.join(missing)} (run install again)")
    print(f"  other hooks: {len(others)} ({', '.join(sorted(set(others)))})" if others else "  other hooks: none")
    try:
        with urllib.request.urlopen("http://127.0.0.1:3081/health", timeout=2) as r:
            json.load(r)
        print("  pet host: listening on 127.0.0.1:3081")
    except (urllib.error.URLError, OSError, ValueError):
        print("  pet host: not reachable on 127.0.0.1:3081 (is 小小桌宠 running?)")
    pet = pet_config_path()
    if pet.exists():
        config = read_json(pet)
        on = all(p.get("workStatusEnabled") is True for p in config.get("pets", []) if isinstance(p, dict))
        slots = "workStatus" in config.get("animations", {}).get("events", {})
        print(f"  小克 work status: {'on' if on and slots else 'off'} ({pet})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Claude Code hooks for 小克's work-status animations")
    parser.add_argument("action", choices=["install", "uninstall", "status"])
    args = parser.parse_args()
    {"install": install, "uninstall": uninstall, "status": status}[args.action]()


if __name__ == "__main__":
    sys.exit(main())
