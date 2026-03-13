// Content script for Betterment (wwws.betterment.com).
// Scrapes account names, types, external IDs, balances from the dashboard.

(() => {
  const INSTITUTION = "betterment";

  const ACCOUNT_TYPE_MAP = {
    individual: "brokerage",
    joint: "brokerage",
    "traditional ira": "ira",
    "roth ira": "ira",
    "sep ira": "ira",
    "rollover ira": "ira",
    "401k": "401k",
    "401(k)": "401k",
    checking: "checking",
    "cash reserve": "savings",
    crypto: "brokerage",
    "safety net": "savings",
    "general investing": "brokerage",
  };

  function detectAccountType(text) {
    const lower = text.toLowerCase();
    for (const [keyword, type] of Object.entries(ACCOUNT_TYPE_MAP)) {
      if (lower.includes(keyword)) return type;
    }
    return "brokerage"; // Default for Betterment
  }

  function parseBalance(text) {
    const match = text.match(/\$[\d,]+\.\d{2}/);
    if (!match) return null;
    return parseFloat(match[0].replace(/[$,]/g, ""));
  }

  function extractExternalId(text, element) {
    // Try last-4 pattern
    const lastFour = text.match(/[\u2022\u00B7*•]+\s*(\d{4})/);
    if (lastFour) return lastFour[1];

    // Try to extract from links
    const link = element.tagName === "A" ? element : element.querySelector("a[href]");
    if (link) {
      const href = link.getAttribute("href") || "";
      // Betterment uses /app/account/... or /app/goal/... URLs
      const urlMatch = href.match(
        /\/app\/(?:account|goal|accounts|goals)\/([^/?]+)/
      );
      if (urlMatch) return urlMatch[1];
    }

    // Try account number patterns
    const acctNum = text.match(/(?:account|acct)[\s#:]*(\w+)/i);
    if (acctNum) return acctNum[1];

    return null;
  }

  function scrapeAccounts() {
    const accounts = [];
    const seen = new Set();

    // Strategy 1: Look for account/goal cards
    // Betterment organizes by "goals" - each goal has a name and balance
    const cards = document.querySelectorAll(
      '[class*="goal" i], [class*="Goal" i], ' +
        '[class*="account" i], [class*="Account" i], ' +
        '[data-testid*="goal" i], [data-testid*="account" i], ' +
        'a[href*="/app/account/"], a[href*="/app/goal/"], ' +
        '[role="listitem"]'
    );

    for (const card of cards) {
      const text = card.innerText || "";
      if (!text.trim()) continue;

      const balance = parseBalance(text);
      if (balance === null) continue;

      let externalId = extractExternalId(text, card);

      if (!externalId) {
        // Generate a stable ID from the name
        const lines = text.split("\n").map((l) => l.trim()).filter((l) => l);
        externalId =
          lines[0]?.replace(/\s+/g, "_").toLowerCase().substring(0, 20) || null;
      }

      if (!externalId || seen.has(externalId)) continue;
      seen.add(externalId);

      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("$") && !l.match(/^[\d,]+\.\d{2}/));
      const name = lines[0] || `Account ${externalId}`;

      accounts.push({
        name: name,
        account_type: detectAccountType(text),
        external_id: externalId,
        balance: balance,
      });
    }

    // Strategy 2: Broader search if no cards found
    if (accounts.length === 0) {
      // Look for any elements with dollar amounts that might be accounts
      const allElements = document.querySelectorAll(
        "section, article, [class*='card' i], [class*='Card' i], li"
      );
      for (const el of allElements) {
        // Only process leaf-ish elements (skip huge containers)
        if (el.children.length > 10) continue;

        const text = el.innerText || "";
        const balance = parseBalance(text);
        if (balance === null) continue;

        let externalId = extractExternalId(text, el);
        if (!externalId) {
          const lines = text.split("\n").map((l) => l.trim()).filter((l) => l);
          externalId = lines[0]
            ?.replace(/\s+/g, "_")
            .toLowerCase()
            .substring(0, 20);
        }

        if (!externalId || seen.has(externalId)) continue;
        seen.add(externalId);

        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter(
            (l) => l && !l.startsWith("$") && !l.match(/^[\d,]+\.\d{2}/)
          );
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

  // Auto-scrape on dashboard/app pages
  if (
    window.location.href.includes("/app") &&
    !window.location.href.includes("/login")
  ) {
    setTimeout(() => {
      const data = scrape();
      console.log(
        `[Money] Betterment: auto-scraped ${data.accounts.length} account(s)`
      );
    }, 5000);
  }
})();
