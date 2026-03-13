"""Discover Ally Bank API routes by intercepting network requests."""

import json
import logging
import time

from money.config import debug_dir
from money.ingest.browser import BrowserSession

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DASHBOARD_URL = "https://secure.ally.com/dashboard"
LOGIN_URL = "https://secure.ally.com/"

# Collect all API requests
api_requests: list[dict[str, object]] = []


def on_request(request):
    url = request.url
    # Skip static assets, analytics, tracking
    skip = (
        ".js" in url
        or ".css" in url
        or ".png" in url
        or ".svg" in url
        or ".woff" in url
        or ".ico" in url
        or "google" in url
        or "analytics" in url
        or "tracking" in url
        or "newrelic" in url
        or "doubleclick" in url
        or "facebook" in url
        or "segment" in url
        or "optimizely" in url
        or "akamai" in url
    )
    if skip:
        return

    resource = request.resource_type
    if resource in ("xhr", "fetch", "document"):
        entry = {
            "url": url,
            "method": request.method,
            "resource_type": resource,
            "headers": dict(request.headers),
        }
        post = request.post_data
        if post:
            entry["post_data"] = post[:500]
        api_requests.append(entry)
        log.info("[%s] %s %s", resource.upper(), request.method, url)


def on_response(response):
    url = response.url
    resource = response.request.resource_type
    if resource in ("xhr", "fetch") and response.status < 400:
        content_type = response.headers.get("content-type", "")
        if "json" in content_type:
            try:
                body = response.json()
                # Log a preview of the response
                preview = json.dumps(body, indent=2)[:300]
                log.info("  Response preview: %s", preview)
            except Exception:
                pass


def main():
    with BrowserSession("ally", profile="scott", headless=True) as session:
        # Load relayed cookies from the Chrome extension
        n = session.load_relayed_cookies()
        log.info("Loaded %d relayed cookies", n)

        page = session.context.new_page()
        page.on("request", on_request)
        page.on("response", on_response)

        # Try going straight to dashboard with cookies
        log.info("Navigating to dashboard...")
        page.goto(DASHBOARD_URL, wait_until="domcontentloaded")
        page.wait_for_timeout(10000)

        # Check if we're logged in
        url = page.url.lower()
        if "dashboard" in url or "accounts" in url:
            log.info("Logged in via cookies! Current URL: %s", page.url)
        else:
            log.info("Not logged in (landed on %s). Taking screenshot.", page.url)
            page.screenshot(path=str(debug_dir() / "ally_api_discovery.png"))
            # Try clicking around to trigger API calls anyway
            page.wait_for_timeout(5000)

        # Click on account links to trigger more API calls
        account_links = page.query_selector_all(
            'a[href*="/bank/account/"], a[href*="/bank/transactions"]'
        )
        log.info("Found %d account links", len(account_links))
        for link in account_links[:3]:  # Visit first 3 accounts
            href = link.get_attribute("href")
            if href:
                full_url = (
                    href if href.startswith("http") else f"https://secure.ally.com{href}"
                )
                log.info("Visiting account page: %s", full_url)
                page.goto(full_url, wait_until="domcontentloaded")
                page.wait_for_timeout(8000)

        # Save all discovered API routes
        output_path = debug_dir() / "ally_api_routes.json"
        output_path.write_text(json.dumps(api_requests, indent=2))
        log.info("Saved %d API requests to %s", len(api_requests), output_path)

        # Print summary
        print("\n=== Discovered API Routes ===")
        seen = set()
        for req in api_requests:
            key = f"{req['method']} {req['url']}"
            if key not in seen:
                seen.add(key)
                print(f"  {key}")


if __name__ == "__main__":
    main()
