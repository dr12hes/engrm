#!/usr/bin/env python3
"""Package Engrm Codex skills into upload-ready zip files."""

from __future__ import annotations

from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parent
SKILLS_DIR = ROOT / "skills"
DIST_DIR = ROOT / "dist"


def package_skill(skill_dir: Path) -> Path:
    bundle_path = DIST_DIR / f"{skill_dir.name}.zip"
    if bundle_path.exists():
        bundle_path.unlink()
    with zipfile.ZipFile(bundle_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(skill_dir.rglob("*")):
            if path.is_dir():
                continue
            arcname = Path(skill_dir.name) / path.relative_to(skill_dir)
            zf.write(path, arcname.as_posix())
    return bundle_path


def main() -> None:
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    bundles: list[Path] = []
    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir():
            continue
        if not (skill_dir / "SKILL.md").exists():
            continue
        bundles.append(package_skill(skill_dir))

    print(f"Packaged {len(bundles)} Codex skills into {DIST_DIR}")
    for bundle in bundles:
        print(f"- {bundle.name} ({bundle.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
