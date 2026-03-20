"""Ally Bank login scraper — automates login to capture auth token for API access."""

import json
import logging
from pathlib import Path
from typing import Any

from playwright.sync_api import BrowserContext, Page, Response

from money.config import DATA_DIR, cookie_relay_path, load_credentials
from money.ingest.browser import BrowserSession

log = logging.getLogger(__name__)

LOGIN_URL = "https://secure.ally.com/?redirect=/dashboard"


def auth_token_path(profile: str) -> Path:
    """Return the auth token path for a given profile."""
    return DATA_DIR / "auth_tokens" / f"ally_{profile}.json"


# Legacy default for backwards compat
AUTH_TOKEN_PATH = DATA_DIR / "auth_tokens" / "ally.json"


def _save_cookies(context: BrowserContext, profile: str) -> None:
    """Save browser cookies in the relay format expected by ally_api."""
    cookies = context.cookies(["https://secure.ally.com"])
    path = cookie_relay_path("ally", profile)
    cookie_data = {"cookies": cookies, "source": "playwright_login"}
    path.write_text(json.dumps(cookie_data, indent=2, default=str))
    log.info("Saved %d cookies to %s", len(cookies), path)


def _save_token(profile: str, token: str, token_type: str,
                expires_in: int | None) -> None:
    """Save captured auth token to disk."""
    path = auth_token_path(profile)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "token": token,
        "token_type": token_type,
        "expires_in": expires_in,
    }
    path.write_text(json.dumps(data, indent=2))
    log.info("Saved auth token to %s", path)


def _extract_token(response_body: dict[str, Any]) -> dict[str, Any] | None:
    """Extract auth token from Ally's nested response structure."""
    # Ally returns token at data.data.json_data.access_token
    top_raw = response_body.get("data")
    if not isinstance(top_raw, dict):
        return None
    top: dict[str, Any] = dict(top_raw)

    # Check nested path: data.data.json_data
    inner_raw = top.get("data")
    if isinstance(inner_raw, dict):
        inner: dict[str, Any] = dict(inner_raw)
        json_data_raw = inner.get("json_data")
        if isinstance(json_data_raw, dict) and "access_token" in json_data_raw:
            return dict[str, Any](json_data_raw)

    # Check direct path: data.access_token
    if "access_token" in top:
        return top

    return None


def login_ally(profile: str, headless: bool = False) -> str:
    """Log into Ally Bank, capture the auth token, and save it.

    Runs headed by default so MFA prompts are visible.
    Browser state is persisted, so "remember this device" works across runs.

    Returns the captured token string for immediate use.
    """
    creds = load_credentials("ally", profile)
    captured_token: dict[str, str | int | None] = {}

    def on_response(response: Response) -> None:
        """Intercept responses to find the auth token."""
        content_type = response.headers.get("content-type", "")
        if "json" not in content_type:
            return
        if response.status != 200:
            return
        try:
            raw = response.json()
        except Exception:
            return
        if not isinstance(raw, dict):
            return

        body: dict[str, Any] = dict(raw)
        token_data = _extract_token(body)
        if token_data is None:
            return
        captured_token["token"] = token_data["access_token"]
        captured_token["token_type"] = token_data.get("token_type", "Bearer")
        captured_token["expires_in"] = token_data.get("expires_in")
        log.info("Captured auth token from %s", response.url)

    debug_dir = DATA_DIR / "debug"
    debug_dir.mkdir(parents=True, exist_ok=True)

    with BrowserSession("ally", profile, headless=headless) as session:
        page: Page = session.context.new_page()
        page.on("response", on_response)

        log.info("Navigating to Ally login...")
        page.goto(LOGIN_URL, wait_until="domcontentloaded")
        page.wait_for_timeout(3000)
        log.info("Current URL: %s", page.url)

        # If we ended up on the authenticated dashboard (no login form visible)
        has_login_form = page.locator('input[type="password"]').count() > 0
        if not has_login_form:
            log.info("No login form found — already authenticated")
            page.wait_for_timeout(3000)
            if captured_token.get("token"):
                token_str = str(captured_token["token"])
                _save_token(
                    profile, token_str,
                    str(captured_token.get("token_type", "Bearer")),
                    captured_token.get("expires_in"),  # type: ignore[arg-type]
                )
                _save_cookies(session.context, profile)
                return token_str
            # Session is active but no token — need to force a fresh login
            # by navigating to the logout URL then back to login
            log.info("Authenticated but no token captured — forcing re-login...")
            page.goto("https://secure.ally.com/acs/customers/authenticate/api/v2/auth/logout",
                       wait_until="domcontentloaded")
            page.wait_for_timeout(2000)
            page.goto(LOGIN_URL, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)

        page.screenshot(path=str(debug_dir / "ally_login.png"), full_page=True)

        # Fill credentials
        username_selectors = [
            'input[name="username"]', 'input[id="username"]',
            'input[autocomplete="username"]',
        ]
        username_filled = False
        for selector in username_selectors:
            loc = page.locator(selector)
            if loc.count() > 0 and loc.first.is_visible():
                loc.first.fill(creds.username)
                log.info("Filled username via: %s", selector)
                username_filled = True
                break

        if not username_filled:
            loc = page.get_by_label("Username")
            if loc.count() > 0:
                loc.first.fill(creds.username)
                log.info("Filled username via label")
                username_filled = True

        if not username_filled:
            page.screenshot(path=str(debug_dir / "ally_no_username.png"), full_page=True)
            raise RuntimeError(
                f"Could not find username input. URL: {page.url}. "
                f"Check {debug_dir / 'ally_login.html'}"
            )

        page.locator('input[type="password"]').first.fill(creds.password)
        log.info("Filled password")

        page.locator('button[type="submit"]').first.click()
        log.info("Submitted login, waiting for response...")

        # Wait for token capture — need to grab it before SPA logs it out
        max_wait = 120
        waited = 0
        interval = 2
        while waited < max_wait:
            if captured_token.get("token"):
                break
            page.wait_for_timeout(interval * 1000)
            waited += interval
            if waited % 10 == 0:
                page.screenshot(
                    path=str(debug_dir / f"ally_waiting_{waited}s.png"), full_page=True
                )
                log.info("Waiting for login... (%ds, URL: %s)", waited, page.url)

        if not captured_token.get("token"):
            page.screenshot(path=str(debug_dir / "ally_timeout.png"), full_page=True)
            log.error("Did not capture auth token after %ds. URL: %s", max_wait, page.url)
            raise TimeoutError(
                "Login timed out — no auth token captured. "
                "Check if MFA was completed or if the login page changed."
            )

        token_str = str(captured_token["token"])
        _save_cookies(session.context, profile)
        _save_token(
            profile, token_str,
            str(captured_token.get("token_type", "Bearer")),
            captured_token.get("expires_in"),  # type: ignore[arg-type]
        )

    return token_str
