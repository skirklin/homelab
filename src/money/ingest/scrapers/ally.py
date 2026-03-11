"""Ally Bank scraper — logs in and downloads transaction CSV exports."""

import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from tempfile import mkdtemp

from playwright.sync_api import Page

from money.config import debug_dir, load_credentials
from money.ingest.browser import BrowserSession
from money.models import AccountType

log = logging.getLogger(__name__)

LOGIN_URL = "https://secure.ally.com/"
DASHBOARD_URL = "https://secure.ally.com/dashboard"

ACCOUNT_TYPE_MAP: dict[str, AccountType] = {
    "checking": AccountType.CHECKING,
    "savings": AccountType.SAVINGS,
    "money market": AccountType.SAVINGS,
    "cd": AccountType.SAVINGS,
    "interest checking": AccountType.CHECKING,
}


@dataclass
class ScrapedAccount:
    name: str
    account_type: AccountType
    external_id: str
    url: str
    balance: float | None = None


def _login(page: Page, profile: str | None = None) -> None:
    creds = load_credentials("ally", profile)
    log.info("Navigating to Ally login page")
    page.goto(LOGIN_URL, wait_until="domcontentloaded")

    if _is_logged_in(page):
        log.info("Already logged in (restored session)")
        return

    # Wait for the SPA to render the login form
    page.wait_for_timeout(10000)
    log.debug("Page URL: %s  Title: %s", page.url, page.title())

    log.info("Entering credentials")
    page.fill('input[name="username"], input[id="username"]', creds.username)
    page.fill('input[name="password"], input[id="password"]', creds.password)
    page.click('button[type="submit"]')

    # Don't use networkidle — Ally's analytics keep connections open forever.
    # Poll for URL change indicating success, MFA, or error.
    log.info("Waiting for post-login navigation...")
    last_url = page.url
    deadline = time.time() + 30
    while time.time() < deadline:
        current_url = page.url
        if current_url != last_url:
            log.info("Navigated to: %s", current_url)
            last_url = current_url

        if _is_logged_in(page):
            log.info("Login successful")
            return

        # Any /security/ page is an MFA challenge
        if "/security/" in current_url:
            _handle_mfa(page)
            return

        # Check for login error
        error = page.query_selector('[class*="error"], [class*="alert"]')
        if error and error.is_visible():
            text = error.inner_text()
            if "password" in text.lower() or "invalid" in text.lower():
                raise RuntimeError(f"Login failed: {text}")

        page.wait_for_timeout(1000)

    # Take a debug screenshot before failing
    screenshot_path = debug_dir() / "ally_post_login.png"
    page.screenshot(path=str(screenshot_path))
    log.error("Post-login screenshot saved to %s", screenshot_path)
    raise RuntimeError("Login timed out — never reached dashboard or MFA prompt.")


def _is_logged_in(page: Page) -> bool:
    url = page.url.lower()
    # Logged in if we're on dashboard, accounts, or any authenticated page
    # (i.e. not on the login page or a /security/ MFA page)
    return (
        "accounts" in url
        or "dashboard" in url
        or (
            "secure.ally.com" in url
            and "/security/" not in url
            and url != "https://secure.ally.com/"
        )
    )


def _wait_for_login(page: Page, timeout: int = 60) -> None:
    """Poll until we reach an authenticated page, handling intermediate screens."""
    last_url = page.url
    deadline = time.time() + timeout
    while time.time() < deadline:
        current_url = page.url
        if current_url != last_url:
            log.info("Navigated to: %s", current_url)
            last_url = current_url

        if _is_logged_in(page):
            log.info("Login successful")
            return

        # Handle "register this device" page automatically
        if "register-device" in current_url:
            page.wait_for_timeout(2000)
            # Select "Yes - trusted device" radio if present
            yes_radio = page.query_selector(
                'input[type="radio"][value*="yes" i], label:has-text("Yes") input[type="radio"]'
            )
            if yes_radio and not yes_radio.is_checked():
                log.info("Selecting 'Yes - trusted device'")
                yes_radio.check()
            # Click Continue
            continue_btn = page.query_selector(
                'button:has-text("Continue"), button:has-text("Register"), button[type="submit"]'
            )
            if continue_btn and continue_btn.is_visible():
                log.info("Registering device: clicking '%s'", continue_btn.inner_text().strip())
                continue_btn.click()
                page.wait_for_timeout(3000)
                continue

        page.wait_for_timeout(2000)

    screenshot_path = debug_dir() / "ally_login_timeout.png"
    page.screenshot(path=str(screenshot_path))
    log.error("Timed out at URL: %s", page.url)
    raise RuntimeError(f"Login timed out. Screenshot saved to {screenshot_path}")


def _handle_mfa(page: Page) -> None:
    """Handle MFA — supports push-to-approve and code entry flows."""
    log.info("MFA challenge at: %s", page.url)
    page.wait_for_timeout(3000)  # Let the MFA page fully render

    # Show the user what's on the MFA page
    _print_page_text(page)

    # Check for "remember this device" checkbox and enable it
    remember = page.query_selector(
        'input[type="checkbox"][name*="remember" i], '
        'input[type="checkbox"][id*="remember" i], '
        'input[type="checkbox"][aria-label*="remember" i], '
        'label:has-text("remember") input[type="checkbox"], '
        'label:has-text("Don\'t ask") input[type="checkbox"]'
    )
    if remember and not remember.is_checked():
        log.info("Checking 'remember this device'")
        remember.check()

    # Check if this is a push-to-approve page (Ally mobile approve)
    if "mobile-approve" in page.url:
        input("\nPress Enter after approving the push notification on your phone...")
        log.info("Waiting for post-MFA redirect...")
        _wait_for_login(page)
        return

    # Interactive: let the user tell us what to do
    action = input("\nEnter MFA code, or type 'click <button text>' to click a button: ").strip()

    if action.lower().startswith("click "):
        btn_text = action[6:].strip()
        btn = page.query_selector(f'button:has-text("{btn_text}")')
        if btn and btn.is_visible():
            log.info("Clicking button: %s", btn_text)
            btn.click()
            page.wait_for_timeout(5000)
            _print_page_text(page)
            # After clicking, we might now have a code input or another page
            if _is_logged_in(page):
                log.info("Login successful")
                return
            if "/security/" in page.url:
                # Recurse to handle the next MFA step
                _handle_mfa(page)
                return
        else:
            log.warning("Button '%s' not found or not visible", btn_text)

    # Try to find and fill a code input
    mfa_input = page.query_selector(
        'input[name*="code" i], '
        'input[name*="otp" i], '
        'input[name*="verification" i], '
        'input[type="tel"], '
        'input[aria-label*="code" i], '
        'input[aria-label*="verification" i]'
    )
    if mfa_input is None:
        screenshot_path = debug_dir() / "ally_mfa_unknown.png"
        page.screenshot(path=str(screenshot_path))
        raise RuntimeError(f"Could not find MFA input field. Screenshot saved to {screenshot_path}")

    if not action.lower().startswith("click "):
        # The action IS the code
        log.info("Submitting MFA code")
        mfa_input.fill(action)

        submit_btn = page.query_selector(
            'button[type="submit"], '
            'button:has-text("Verify"), '
            'button:has-text("Submit"), '
            'button:has-text("Continue")'
        )
        if submit_btn and submit_btn.is_visible():
            submit_btn.click()
        else:
            mfa_input.press("Enter")

    _wait_for_login(page)


def _print_page_text(page: Page) -> None:
    """Print visible text from the page so the user can see MFA options."""
    # Get the main content text, stripping nav/footer noise
    main = page.query_selector("main, [role='main'], .main-content")
    text = main.inner_text() if main else page.inner_text("body")

    # Clean up and print non-empty lines
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    print("\n--- Page content ---")
    for line in lines[:30]:  # Cap at 30 lines to avoid noise
        print(f"  {line}")
    print("--------------------")


def _discover_accounts(page: Page) -> list[ScrapedAccount]:
    """Find all accounts on the Ally dashboard."""
    log.info("Discovering accounts on dashboard")
    page.goto(DASHBOARD_URL, wait_until="domcontentloaded")
    # Wait for the SPA to render account data
    page.wait_for_timeout(10000)
    log.debug("Dashboard URL: %s", page.url)

    screenshot_path = debug_dir() / "ally_dashboard.png"
    page.screenshot(path=str(screenshot_path))
    log.debug("Dashboard screenshot saved to %s", screenshot_path)

    accounts: list[ScrapedAccount] = []

    # Find account links — Ally uses /bank/account/ or /account/ paths
    account_links = page.query_selector_all(
        'a[href*="/bank/account/"], a[href*="/bank/transactions"], a[href*="/account/"]'
    )
    log.debug("Found %d account links", len(account_links))

    for link in account_links:
        href = link.get_attribute("href")
        if not href:
            continue
        # Skip nav/header links that aren't actual account pages
        if href in ("/account/", "#"):
            continue

        url = href if href.startswith("http") else f"https://secure.ally.com{href}"

        display_name = link.inner_text().strip()
        if not display_name:
            continue

        # Get the row containing this link to find account number and balance
        row = link.evaluate_handle(
            "el => el.closest('tr') || el.closest('[role=\"row\"]') || el.parentElement"
        )
        row_el = row.as_element() if row else None
        row_text = row_el.inner_text() if row_el else display_name

        # Parse account number (last 4 digits) from row like "Spending Account••9383"
        acct_match = re.search(r"[\u2022•*]+\s*(\d{4})", row_text)
        if not acct_match:
            log.debug("Skipping link with no account number: %r", display_name)
            continue
        external_id = acct_match.group(1)

        account_type = AccountType.CHECKING
        text_lower = row_text.lower()
        for keyword, atype in ACCOUNT_TYPE_MAP.items():
            if keyword in text_lower:
                account_type = atype
                break

        if any(a.external_id == external_id for a in accounts):
            continue

        # Extract balance from dollar amounts in the row
        balance: float | None = None
        amounts = re.findall(r"\$[\d,]+\.\d{2}", row_text)
        if amounts:
            balance = float(amounts[0].replace("$", "").replace(",", ""))

        log.info(
            "Found account: %s ••%s (%s) balance=%s",
            display_name,
            external_id,
            account_type.value,
            f"${balance:,.2f}" if balance else "unknown",
        )
        accounts.append(
            ScrapedAccount(
                name=display_name,
                account_type=account_type,
                external_id=external_id,
                url=url,
                balance=balance,
            )
        )

    if not accounts:
        log.warning("No account links found on dashboard")

    return accounts


def _download_csv(page: Page, account: ScrapedAccount, download_dir: Path) -> Path | None:
    """Navigate to an account and download its transaction CSV."""
    log.info("Downloading CSV for: %s", account.name)
    page.goto(account.url, wait_until="domcontentloaded")
    page.wait_for_timeout(10000)
    log.debug("Account page URL: %s", page.url)

    download_btn = page.query_selector(
        'button[aria-label*="download" i], '
        'button[aria-label*="export" i], '
        'a[aria-label*="download" i], '
        'a[aria-label*="export" i], '
        '[data-testid*="download" i], '
        '[data-testid*="export" i], '
        '[class*="download" i], '
        'button:has-text("Download"), '
        'button:has-text("Export"), '
        'a:has-text("Download"), '
        'a:has-text("Export")'
    )

    if not download_btn:
        log.warning("No download button found for %s", account.name)
        _print_page_text(page)
        return None

    log.debug("Clicking download button")
    download_btn.click()
    page.wait_for_timeout(3000)

    # The download dialog has "Select File Format" and "Date Range" dropdowns.
    # Use JS to set values and trigger React change events properly.
    format_select = page.query_selector("select")
    if format_select:
        options = format_select.evaluate(
            "el => Array.from(el.options).map(o => ({value: o.value, text: o.text}))"
        )
        log.debug("File format options: %s", options)
        # Trigger via native input setter to fire React's onChange
        format_select.evaluate("""el => {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLSelectElement.prototype, 'value'
            ).set;
            nativeInputValueSetter.call(el, 'csv');
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }""")
        log.debug("Selected file format: CSV")
        page.wait_for_timeout(1000)

    selects = page.query_selector_all("select")
    if len(selects) >= 2:
        date_select = selects[1]
        date_options = date_select.evaluate(
            "el => Array.from(el.options).map(o => ({value: o.value, text: o.text}))"
        )
        log.debug("Date range options: %s", date_options)
        date_select.evaluate("""el => {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLSelectElement.prototype, 'value'
            ).set;
            nativeInputValueSetter.call(el, 'all');
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }""")
        log.debug("Selected date range: All available dates")
        page.wait_for_timeout(1000)

    # Click the Download button in the dialog — find all matching buttons
    # and use the last visible one (the dialog button, not the header link)
    try:
        with page.expect_download(timeout=30000) as download_info:
            download_buttons = page.query_selector_all('button:has-text("Download")')
            log.debug("Found %d Download buttons", len(download_buttons))
            # Click the LAST visible Download button (the dialog submit, not the header link)
            visible_btns = [b for b in download_buttons if b.is_visible()]
            if visible_btns:
                btn = visible_btns[-1]
                log.debug(
                    "Clicking dialog Download button (%d of %d visible)",
                    len(visible_btns),
                    len(download_buttons),
                )
                btn.click()
            else:
                log.warning("No visible download button found in dialog")
                return None

        download = download_info.value
        dest = download_dir / download.suggested_filename
        download.save_as(str(dest))
        log.info("Downloaded: %s", dest.name)
        return dest
    except Exception as e:
        log.warning("Download failed for %s: %s", account.name, e)
        return None


def scrape_ally(profile: str | None = None) -> list[tuple[ScrapedAccount, Path]]:
    """Log in to Ally Bank, discover accounts, and download CSVs.

    Returns list of (account_info, csv_path) tuples.
    """
    download_dir = Path(mkdtemp(prefix="ally_"))
    results: list[tuple[ScrapedAccount, Path]] = []

    with BrowserSession("ally", profile=profile) as session:
        page = session.context.new_page()
        _login(page, profile=profile)
        session.save_state()

        accounts = _discover_accounts(page)
        if not accounts:
            raise RuntimeError(
                "No accounts found on Ally dashboard. The page structure may have changed."
            )

        for account in accounts:
            csv_path = _download_csv(page, account, download_dir)
            if csv_path:
                results.append((account, csv_path))

    log.info("Scraped %d account(s) with CSV data", len(results))
    return results
