// Content script for Wealthfront (www.wealthfront.com).
// Scrapes account names, types, external IDs, balances from the overview page.

(() => {
  const INSTITUTION = "wealthfront";

  const ACCOUNT_TYPE_MAP = {
    individual: "brokerage",
    joint: "brokerage",
    "traditional ira": "ira",
    "roth ira": "ira",
    "sep ira": "ira",
    "rollover ira": "ira",
    "401k": "401k",
    "401(k)": "401k",
    cash: "savings",
    "cash account": "checking",
    checking: "checking",
    "bond portfolio": "brokerage",
    "stock investing": "brokerage",
    "risk parity": "brokerage",
  };

  function detectAccountType(text) {
    const lower = text.toLowerCase();
    for (const [keyword, type] of Object.entries(ACCOUNT_TYPE_MAP)) {
      if (lower.includes(keyword)) return type;
    }
    return "brokerage"; // Default for Wealthfront
  }

  function parseBalance(text) {
    // Match dollar amounts like $1,234.56 or $1,234,567.89
    const match = text.match(/\$[\d,]+\.\d{2}/);
    if (!match) return null;
    return parseFloat(match[0].replace(/[$,]/g, ""));
  }

  function extractExternalId(text) {
    // Wealthfront may show account numbers or unique identifiers
    // Try last-4 pattern first
    const lastFour = text.match(/[\u2022\u00B7*•]+\s*(\d{4})/);
    if (lastFour) return lastFour[1];

    // Try account number patterns
    const acctNum = text.match(/(?:account|acct)[\s#:]*(\d+)/i);
    if (acctNum) return acctNum[1];

    return null;
  }

  function scrapeAccounts() {
    const accounts = [];
    const seen = new Set();

    // Strategy 1: Look for account sections/cards on overview page
    // Wealthfront typically shows cards with account name, type, and balance
    const cards = document.querySelectorAll(
      '[class*="account" i], [class*="Account" i], ' +
        '[data-testid*="account" i], [role="listitem"], ' +
        'a[href*="/account/"], a[href*="/d/"]'
    );

    for (const card of cards) {
      const text = card.innerText || "";
      if (!text.trim()) continue;

      const balance = parseBalance(text);
      // Skip elements that don't look like account cards (no balance)
      if (balance === null) continue;

      let externalId = extractExternalId(text);

      // Try to get ID from href
      if (!externalId) {
        const link = card.tagName === "A" ? card : card.querySelector("a[href]");
        if (link) {
          const href = link.getAttribute("href") || "";
          // Wealthfront uses /d/account/... or /account/... URLs
          const urlMatch = href.match(/\/(?:d\/)?(?:account|accounts)\/([^/?]+)/);
          if (urlMatch) externalId = urlMatch[1];
        }
      }

      if (!externalId) {
        // Generate a stable ID from the account name
        const lines = text.split("\n").map((l) => l.trim()).filter((l) => l);
        externalId = lines[0]?.replace(/\s+/g, "_").toLowerCase().substring(0, 20) || null;
      }

      if (!externalId || seen.has(externalId)) continue;
      seen.add(externalId);

      // First line is typically the account name
      const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("$"));
      const name = lines[0] || `Account ${externalId}`;

      accounts.push({
        name: name,
        account_type: detectAccountType(text),
        external_id: externalId,
        balance: balance,
      });
    }

    // Strategy 2: Try table-based layout
    if (accounts.length === 0) {
      const rows = document.querySelectorAll("tr, [role='row']");
      for (const row of rows) {
        const text = row.innerText;
        const balance = parseBalance(text);
        if (balance === null) continue;

        let externalId = extractExternalId(text);
        if (!externalId) {
          const lines = text.split("\n").map((l) => l.trim()).filter((l) => l);
          externalId = lines[0]?.replace(/\s+/g, "_").toLowerCase().substring(0, 20);
        }

        if (!externalId || seen.has(externalId)) continue;
        seen.add(externalId);

        const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("$"));
        const name = lines[0] || `Account ${externalId}`;

        accounts.push({
          name: name,
          account_type: detectAccountType(text),
          external_id: externalId,
          balance: balance,
        });
      }
    }

    return accounts;
  }

  function scrape() {
    const accounts = scrapeAccounts();

    const payload = {
      institution: INSTITUTION,
      accounts: accounts,
      scraped_at: new Date().toISOString(),
      url: window.location.href,
    };

    chrome.runtime.sendMessage({
      type: "SCRAPED_DATA",
      institution: INSTITUTION,
      payload: payload,
    });

    return payload;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "SCRAPE") {
      try {
        const data = scrape();
        sendResponse({
          success: true,
          accounts: data.accounts.length,
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }
  });

  // Auto-scrape on overview/dashboard pages
  if (
    window.location.href.includes("/overview") ||
    window.location.href.includes("/dashboard") ||
    window.location.pathname === "/"
  ) {
    setTimeout(() => {
      const data = scrape();
      console.log(
        `[Money] Wealthfront: auto-scraped ${data.accounts.length} account(s)`
      );
    }, 5000);
  }
})();
