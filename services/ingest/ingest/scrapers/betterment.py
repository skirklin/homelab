"""Betterment scraper — logs in and downloads transaction CSV exports."""

import logging
from dataclasses import dataclass

from playwright.sync_api import Page

from money.config import load_credentials
from money.ingest.browser import BrowserSession
from money.models import AccountType

log = logging.getLogger(__name__)

LOGIN_URL = "https://wwws.betterment.com/app/login"
DASHBOARD_URL = "https://wwws.betterment.com/app"


ACCOUNT_TYPE_MAP: dict[str, AccountType] = {
    "individual": AccountType.BROKERAGE,
    "joint": AccountType.BROKERAGE,
    "traditional ira": AccountType.IRA,
    "roth ira": AccountType.IRA,
    "sep ira": AccountType.IRA,
    "rollover ira": AccountType.IRA,
    "401k": AccountType.FOUR_OH_ONE_K,
    "checking": AccountType.CHECKING,
    "cash reserve": AccountType.SAVINGS,
    "crypto": AccountType.BROKERAGE,
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


def _login(page: Page, profile: str) -> None:  # pyright: ignore[reportUnusedFunction]
    creds = load_credentials("betterment", profile)
    page.goto(LOGIN_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(3000)

    # Find inputs by label text since type/name attributes may not be standard
    inputs = page.query_selector_all("input")
    log.debug("Found %d input elements", len(inputs))
    for inp in inputs:
        input_type = inp.get_attribute("type") or ""
        input_name = inp.get_attribute("name") or ""
        input_id = inp.get_attribute("id") or ""
        placeholder = inp.get_attribute("placeholder") or ""
        aria_label = inp.get_attribute("aria-label") or ""
        log.debug(
            "  input: type=%s name=%s id=%s placeholder=%s aria-label=%s",
            input_type, input_name, input_id, placeholder, aria_label,
        )

    # Try multiple strategies to find email field
    email_input = (
        page.query_selector('input[type="email"]')
        or page.query_selector('input[name="email"]')
        or page.query_selector('input[name="username"]')
        or page.query_selector('input[id*="email"]')
        or page.query_selector('input[aria-label*="mail"]')
    )

    if not email_input:
        # Try by label
        email_label = page.query_selector('label:has-text("Email")')
        if email_label:
            label_for = email_label.get_attribute("for")
            if label_for:
                email_input = page.query_selector(f"#{label_for}")
            else:
                # Input might be inside the label
                email_input = email_label.query_selector("input")

    if email_input:
        email_input.fill(creds.username)
        log.info("Filled email field")

        password_input = (
            page.query_selector('input[type="password"]')
            or page.query_selector('input[name="password"]')
        )
        if password_input:
            password_input.fill(creds.password)
            log.info("Filled password field")

        # Wait for Cloudflare Turnstile to solve before submitting
        log.info("Waiting for Cloudflare Turnstile challenge...")
        page.wait_for_timeout(5000)

        # Check turnstile state
        turnstile_val = page.evaluate(
            "document.querySelector('[name=\"cf-turnstile-response\"]')?.value || ''"
        )
        log.debug("Turnstile response length: %d", len(turnstile_val))

        submit = page.query_selector('input[type="submit"], button[type="submit"]')
        if submit:
            submit.click()
            log.info("Clicked submit")
        else:
            page.keyboard.press("Enter")
            log.info("Pressed Enter to submit")

        page.wait_for_timeout(5000)

        log.info("Post-submit URL: %s", page.url)
        _print_page_text(page)
    else:
        log.warning("Could not find email input on login page")
        _print_page_text(page)


def explore_betterment(profile: str) -> None:
    """Exploratory login to see Betterment's page structure."""
    with BrowserSession("betterment", profile, headless=True) as session:
        page = session.context.new_page()

        # Try loading dashboard directly with saved cookies
        page.goto(DASHBOARD_URL, wait_until="domcontentloaded")
        page.wait_for_timeout(5000)

        url = page.url
        print(f"\nURL: {url}")

        if "login" in url:
            print("Not logged in — cookies didn't work.")
            _print_page_text(page)
            return

        print("Logged in successfully!")
        _print_page_text(page)

        # Look for account-related links
        print("\nAll links on page:")
        links = page.query_selector_all("a[href]")
        for link in links:
            href = link.get_attribute("href") or ""
            text = link.inner_text().strip()
            if text:
                print(f"  {text[:80]} -> {href[:120]}")

        session.save_state()
        print("\nBrowser state saved.")
