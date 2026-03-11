import logging
from typing import Self

from playwright.sync_api import Browser, BrowserContext, Playwright, sync_playwright

from money.config import browser_state_path

log = logging.getLogger(__name__)


class BrowserSession:
    """Manages a Playwright browser with persistent state per institution."""

    def __init__(self, institution: str, profile: str | None = None, headless: bool = True) -> None:
        self.institution = institution
        self.profile = profile
        self.headless = headless
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None

    def __enter__(self) -> Self:
        self._playwright = sync_playwright().start()
        log.info("Launching Chromium (headless=%s)", self.headless)
        # Use chromium channel to get full browser instead of headless shell.
        # The headless shell can't render SPAs properly.
        chrome_path = (
            list(
                (__import__("pathlib").Path.home() / ".cache/ms-playwright").glob(
                    "chromium-*/chrome-linux*/chrome"
                )
            )
            or [None]
        )[0]
        launch_kwargs: dict[str, object] = {
            "headless": self.headless,
            "args": [
                "--disable-blink-features=AutomationControlled",
            ],
        }
        if chrome_path:
            log.debug("Using full Chromium at %s", chrome_path)
            launch_kwargs["executable_path"] = str(chrome_path)
        self._browser = self._playwright.chromium.launch(**launch_kwargs)  # type: ignore[arg-type]

        context_kwargs: dict[str, object] = {
            "user_agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
        }
        state_path = browser_state_path(self.institution, self.profile)
        if state_path.exists():
            log.debug("Loading saved browser state from %s", state_path)
            context_kwargs["storage_state"] = str(state_path)
        else:
            log.debug("No saved browser state, starting fresh")
        self._context = self._browser.new_context(**context_kwargs)  # type: ignore[arg-type]

        # Remove automation signals that bot detectors look for
        self._context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
        """)

        return self

    def __exit__(self, *args: object) -> None:
        self.save_state()
        if self._context:
            self._context.close()
        if self._browser:
            self._browser.close()
        if self._playwright:
            self._playwright.stop()
        log.debug("Browser session closed")

    @property
    def context(self) -> BrowserContext:
        assert self._context is not None, "BrowserSession not entered"
        return self._context

    def save_state(self) -> None:
        if self._context:
            state_path = browser_state_path(self.institution, self.profile)
            self._context.storage_state(path=str(state_path))
            log.debug("Saved browser state to %s", state_path)
