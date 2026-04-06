"""Wealthfront scraper — logs in and downloads transaction data."""

import json
import logging
from dataclasses import dataclass
from typing import Any

from playwright.sync_api import BrowserContext, Page

from money.config import cookie_relay_path, load_credentials
from money.ingest.browser import BrowserSession
from money.models import AccountType

log = logging.getLogger(__name__)

LOGIN_URL = "https://www.wealthfront.com/login"
DASHBOARD_URL = "https://www.wealthfront.com/overview"

ACCOUNT_TYPE_MAP: dict[str, AccountType] = {
    "individual": AccountType.BROKERAGE,
    "joint": AccountType.BROKERAGE,
    "traditional ira": AccountType.IRA,
    "roth ira": AccountType.IRA,
    "sep ira": AccountType.IRA,
    "rollover ira": AccountType.IRA,
    "401k": AccountType.FOUR_OH_ONE_K,
    "cash": AccountType.SAVINGS,
    "checking": AccountType.CHECKING,
}


@dataclass
class ScrapedAccount:
    name: str
    account_type: AccountType
    external_id: str
    url: str
    balance: float | None = None


def _print_page_text(page: Page) -> None:
    text = page.inner_text("body")
    visible = "\n".join(line.strip() for line in text.splitlines() if line.strip())
    print(f"\n--- Page text ({page.url}) ---")
    print(visible[:3000])
    print("--- end ---\n")


def _check_captcha(page: Page) -> None:
    """Log what captcha mechanism is present on the page."""
    html = page.content().lower()
    for keyword in ["recaptcha", "grecaptcha", "turnstile", "hcaptcha"]:
        if keyword in html:
            log.info("Detected captcha: %s", keyword)


def _login(page: Page, profile: str) -> None:
    creds = load_credentials("wealthfront", profile)
    page.goto(LOGIN_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(2000)

    _check_captcha(page)

    page.fill("#login-username", creds.username)
    page.fill("#login-password", creds.password)
    log.info("Filled credentials")

    page.click('button[type="submit"]')
    log.info("Clicked submit, waiting...")
    page.wait_for_timeout(5000)

    log.info("Post-login URL: %s", page.url)

    if "rcp=failed" in page.url:
        log.error("Login blocked by captcha verification")
        _print_page_text(page)
    elif "login" in page.url:
        log.warning("Still on login page — may need MFA")
        _print_page_text(page)
    else:
        log.info("Login appears successful")


def _login_camoufox(profile: str) -> None:
    """Try logging in with camoufox anti-detect browser."""
    from camoufox.sync_api import Camoufox  # type: ignore[import-untyped]

    creds = load_credentials("wealthfront", profile)

    with Camoufox(headless=True, humanize=True) as browser:
        page = browser.new_page()
        page.goto(LOGIN_URL, wait_until="domcontentloaded")
        page.wait_for_timeout(3000)

        # Type like a human instead of instant fill
        email_input = page.query_selector("#login-username")
        if email_input:
            email_input.click()
            page.wait_for_timeout(500)
            email_input.type(creds.username, delay=80)
        page.wait_for_timeout(300)

        pwd_input = page.query_selector("#login-password")
        if pwd_input:
            pwd_input.click()
            page.wait_for_timeout(500)
            pwd_input.type(creds.password, delay=60)
        log.info("Typed credentials (camoufox)")

        page.wait_for_timeout(1000)
        page.click('button[type="submit"]')
        log.info("Clicked submit, waiting...")
        page.wait_for_timeout(8000)

        log.info("Post-login URL: %s", page.url)

        if "rcp=failed" in page.url:
            log.error("Still blocked by captcha with camoufox")
        elif "login" in page.url:
            log.warning("Still on login page")
            _print_page_text(page)
        else:
            log.info("Login successful with camoufox!")
            _print_page_text(page)

            print("\nAll links on page:")
            links = page.query_selector_all("a[href]")
            for link in links:
                href = link.get_attribute("href") or ""
                text = link.inner_text().strip()
                if text:
                    print(f"  {text[:80]} -> {href[:120]}")


def explore_wealthfront(profile: str, use_camoufox: bool = False) -> None:
    """Exploratory login to see Wealthfront's page structure."""
    if use_camoufox:
        _login_camoufox(profile)
        return

    with BrowserSession("wealthfront", profile, headless=True) as session:
        page = session.context.new_page()

        _login(page, profile)

        if "login" not in page.url:
            _print_page_text(page)

            print("\nAll links on page:")
            links = page.query_selector_all("a[href]")
            for link in links:
                href = link.get_attribute("href") or ""
                text = link.inner_text().strip()
                if text:
                    print(f"  {text[:80]} -> {href[:120]}")

        session.save_state()
        print("\nBrowser state saved.")


def _load_relay_session() -> dict[str, str] | None:
    """Load relayed cookies into a dict suitable for requests."""
    path = cookie_relay_path("wealthfront")
    if not path.exists():
        log.error("No cookies available. Use the Chrome extension to capture them first.")
        return None

    data = json.loads(path.read_text())
    cookies: dict[str, str] = {}
    for c in data.get("cookies", []):
        cookies[c["name"]] = c["value"]
    return cookies



def explore_wealthfront_cookies(profile: str) -> None:
    """Use relayed cookies with camoufox to access Wealthfront's authenticated UI."""
    from camoufox.sync_api import Camoufox  # type: ignore[import-untyped]

    cookies = _load_relay_session()
    if cookies is None:
        return

    log.info("Launching camoufox with %d relayed cookies", len(cookies))

    # Convert cookies dict to the format camoufox/playwright expects
    pw_cookies = []
    for name, value in cookies.items():
        pw_cookies.append({
            "name": name,
            "value": value,
            "domain": ".wealthfront.com",
            "path": "/",
            "secure": True,
            "httpOnly": False,
        })

    with Camoufox(headless=True, humanize=True) as browser:  # type: ignore[no-untyped-call]
        ctx: BrowserContext = browser.new_context()  # type: ignore[assignment]
        ctx.add_cookies(pw_cookies)  # type: ignore[arg-type]

        pg: Page = ctx.new_page()  # type: ignore[assignment]
        log.info("Navigating to overview...")
        pg.goto(DASHBOARD_URL, wait_until="domcontentloaded")
        pg.wait_for_timeout(8000)

        current_url = str(pg.url)
        log.info("URL: %s", current_url)

        if "login" in current_url:
            log.error("Redirected to login — cookies didn't work")
            _print_page_text(pg)
            return

        _print_page_text(pg)

        print("\nAll links on page:")
        all_links: list[Any] = list(pg.query_selector_all("a[href]"))
        for lnk in all_links:
            href: str = str(lnk.get_attribute("href") or "")
            text: str = str(lnk.inner_text()).strip()
            if text:
                print(f"  {text[:80]} -> {href[:120]}")
