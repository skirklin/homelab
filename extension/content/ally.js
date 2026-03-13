// Content script for Ally Bank (secure.ally.com, wwws.ally.com).
// Scrapes account names, types, external IDs, balances from the dashboard.

(() => {
  const INSTITUTION = "ally";

  const ACCOUNT_TYPE_MAP = {
    checking: "checking",
    "interest checking": "checking",
    savings: "savings",
    "money market": "savings",
    cd: "savings",
    "online savings": "savings",
  };

  function detectAccountType(text) {
    const lower = text.toLowerCase();
    for (const [keyword, type] of Object.entries(ACCOUNT_TYPE_MAP)) {
      if (lower.includes(keyword)) return type;
    }
    return "checking"; // Default for Ally
  }

  function parseBalance(text) {
    const match = text.match(/\$[\d,]+\.\d{2}/);
    if (!match) return null;
    return parseFloat(match[0].replace(/[$,]/g, ""));
  }

  function scrapeAccounts() {
    const accounts = [];
    const seen = new Set();

    // Strategy 1: Look for account links with account numbers
    // Ally uses links like /bank/account/... or /bank/transactions/...
    const accountLinks = document.querySelectorAll(
      'a[href*="/bank/account/"], a[href*="/bank/transactions"], a[href*="/account/"]'
    );

    for (const link of accountLinks) {
      const href = link.getAttribute("href") || "";
      if (href === "/account/" || href === "#") continue;

      // Walk up to find the containing row/card
      const row =
        link.closest("tr") ||
        link.closest('[role="row"]') ||
        link.closest('[class*="account"]') ||
        link.parentElement;

      const rowText = row ? row.innerText : link.innerText;

      // Extract last-4 digits: look for bullet/dot patterns like "••9383"
      const idMatch = rowText.match(/[\u2022\u00B7*•]+\s*(\d{4})/);
      if (!idMatch) continue;

      const externalId = idMatch[1];
      if (seen.has(externalId)) continue;
      seen.add(externalId);

      const displayName = link.innerText.trim().split("\n")[0].trim();
      if (!displayName) continue;

      const accountType = detectAccountType(rowText);
      const balance = parseBalance(rowText);

      accounts.push({
        name: displayName,
        account_type: accountType,
        external_id: externalId,
        balance: balance,
      });
    }

    // Strategy 2: If no links found, try table rows or card-based layouts
    if (accounts.length === 0) {
      const rows = document.querySelectorAll(
        'tr, [role="row"], [class*="AccountCard"], [class*="account-card"]'
      );
      for (const row of rows) {
        const text = row.innerText;
        const idMatch = text.match(/[\u2022\u00B7*•]+\s*(\d{4})/);
        if (!idMatch) continue;

        const externalId = idMatch[1];
        if (seen.has(externalId)) continue;
        seen.add(externalId);

        // First non-empty line is usually the account name
        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l);
        const name = lines[0] || `Account ••${externalId}`;

        accounts.push({
          name: name,
          account_type: detectAccountType(text),
          external_id: externalId,
          balance: parseBalance(text),
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

    // Send to background script for storage
    chrome.runtime.sendMessage({
      type: "SCRAPED_DATA",
      institution: INSTITUTION,
      payload: payload,
    });

    return payload;
  }

  // Listen for scrape requests from popup
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

  // Auto-scrape when page loads on dashboard
  if (
    window.location.href.includes("/dashboard") ||
    window.location.href.includes("/accounts")
  ) {
    // Wait for SPA to render
    setTimeout(() => {
      const data = scrape();
      console.log(
        `[Money] Ally: auto-scraped ${data.accounts.length} account(s)`
      );
    }, 5000);
  }
})();
