"""Load Semgrep CE from the sealed engine directory."""

from pathlib import Path
import sys


if __name__ == "__main__":
    site = Path(__file__).resolve(strict=True).parent / "site"
    sys.path.insert(0, str(site))
    from semgrep.console_scripts.pysemgrep import main

    raise SystemExit(main())
