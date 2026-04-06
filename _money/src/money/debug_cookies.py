"""Debug tool to compare cookie sources for an institution."""

import json
import sys

from money.config import DATA_DIR, cookie_relay_path


def compare_ally_cookies() -> None:
    """Compare Playwright vs extension cookies for Ally."""
    ext_path = cookie_relay_path("ally")
    pw_path = DATA_DIR / "cookies" / "scott@ally.json"

    if not ext_path.exists():
        print(f"No extension cookies at {ext_path}")
        return
    if not pw_path.exists():
        print(f"No Playwright cookies at {pw_path}")
        return

    ext_data = json.loads(ext_path.read_text())
    pw_data = json.loads(pw_path.read_text())

    ext_cookies = {c["name"]: c for c in ext_data.get("cookies", [])}
    pw_cookies = {c["name"]: c for c in pw_data.get("cookies", [])}

    print(f"Extension: {len(ext_cookies)} cookies ({ext_path})")
    print(f"Playwright: {len(pw_cookies)} cookies ({pw_path})")

    missing = pw_cookies.keys() - ext_cookies.keys()
    if missing:
        print(f"\nIn Playwright but NOT extension ({len(missing)}):")
        for name in sorted(missing):
            c = pw_cookies[name]
            print(
                f"  {name:40s} domain={c.get('domain', '?'):20s} "
                f"httpOnly={c.get('httpOnly', '?')!s:6s} secure={c.get('secure', '?')}"
            )

    extra = ext_cookies.keys() - pw_cookies.keys()
    if extra:
        print(f"\nIn extension but NOT Playwright ({len(extra)}):")
        for name in sorted(extra):
            c = ext_cookies[name]
            print(
                f"  {name:40s} domain={c.get('domain', '?'):20s} "
                f"httpOnly={c.get('httpOnly', '?')!s:6s} secure={c.get('secure', '?')}"
            )


def test_api_with_cookies(source: str = "extension") -> None:
    """Test the Ally API with cookies from a specific source."""
    import urllib.error

    from money.ingest.ally_api import _api_request

    if source == "extension":
        path = cookie_relay_path("ally")
    else:
        path = DATA_DIR / "cookies" / "scott@ally.json"

    if not path.exists():
        print(f"No cookies at {path}")
        return

    data = json.loads(path.read_text())
    cookies = {c["name"]: c["value"] for c in data.get("cookies", [])}
    token = cookies.get("Ally-CIAM-Token", "")

    print(f"Source: {source} ({path})")
    print(f"Token: {token[:15]}...")
    print(f"Cookies: {len(cookies)}")
    print(f"PIM-SESSION-ID: {'YES' if 'PIM-SESSION-ID' in cookies else 'NO'}")

    try:
        result = _api_request(token, "/acs/v3/customers/self", cookies=cookies)
        name = result.get("data", {}).get("name", {})
        print(f"SUCCESS: {name.get('first', '')} {name.get('last', '')}")
    except urllib.error.HTTPError as e:
        print(f"FAILED: HTTP {e.code}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        source = sys.argv[2] if len(sys.argv) > 2 else "extension"
        test_api_with_cookies(source)
    else:
        compare_ally_cookies()
