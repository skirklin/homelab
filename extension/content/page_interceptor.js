// Injected into the page context to intercept fetch() and XMLHttpRequest.
// Communicates captured requests back via window.postMessage.

(function() {
  if (window.__moneyRecording) return;
  window.__moneyRecording = true;
  window.__moneyRequests = [];

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const req = args[0] instanceof Request ? args[0] : new Request(args[0], args[1]);
    const url = req.url;
    const method = req.method;

    // Skip static assets
    if (url.includes('.js') || url.includes('.css') || url.includes('.png') ||
        url.includes('.svg') || url.includes('.woff') || url.includes('.ico')) {
      return origFetch.apply(this, args);
    }

    let reqBody = null;
    try {
      if (args[1] && args[1].body) {
        reqBody = typeof args[1].body === 'string' ? args[1].body : null;
      }
    } catch(e) {}

    // Capture all request headers
    let requestHeaders = {};
    try {
      if (args[1] && args[1].headers) {
        const h = args[1].headers;
        if (h instanceof Headers) {
          h.forEach((value, key) => { requestHeaders[key] = value; });
        } else if (typeof h === 'object') {
          requestHeaders = Object.assign({}, h);
        }
      }
    } catch(e) {}

    const startTime = Date.now();
    try {
      const response = await origFetch.apply(this, args);
      const clone = response.clone();
      const contentType = response.headers.get('content-type') || '';

      let responseBody = null;
      let responseText = null;
      if (contentType.includes('json')) {
        try { responseBody = await clone.json(); } catch(e) {}
      }
      // Fallback: try parsing as JSON anyway for API URLs, or capture raw text
      if (responseBody === null && url.includes('/api/')) {
        try {
          const text = await clone.text();
          responseText = text.substring(0, 5000);
          responseBody = JSON.parse(text);
        } catch(e) {}
      }

      // Detect auth tokens in login responses
      if (responseBody && responseBody.data && responseBody.data.data &&
          responseBody.data.data.json_data && responseBody.data.data.json_data.access_token) {
        window.postMessage({
          source: '__money_auth_token',
          token: responseBody.data.data.json_data.access_token,
          tokenType: responseBody.data.data.json_data.token_type || 'Bearer',
          expiresIn: responseBody.data.data.json_data.expires_in,
        }, '*');
      }

      const entry = {
        type: 'fetch',
        url: url,
        method: method,
        status: response.status,
        contentType: contentType,
        requestBody: reqBody ? reqBody.substring(0, 2000) : null,
        requestHeaders: requestHeaders,
        responseBody: responseBody,
        responseText: responseBody === null ? responseText : undefined,
        responseSize: responseBody ? JSON.stringify(responseBody).length : null,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
      window.__moneyRequests.push(entry);
      window.postMessage({ source: '__money_network', entry: entry }, '*');
      return response;
    } catch(err) {
      const entry = {
        type: 'fetch',
        url: url,
        method: method,
        status: 0,
        error: err.message,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
      window.__moneyRequests.push(entry);
      window.postMessage({ source: '__money_network', entry: entry }, '*');
      throw err;
    }
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__moneyMethod = method;
    this.__moneyUrl = url;
    this.__moneyHeaders = {};
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this.__moneyHeaders) {
      this.__moneyHeaders[name] = value;
    }
    return origSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const url = this.__moneyUrl || '';

    // Skip static assets
    if (url.includes('.js') || url.includes('.css') || url.includes('.png') ||
        url.includes('.svg') || url.includes('.woff') || url.includes('.ico')) {
      return origSend.call(this, body);
    }

    const method = this.__moneyMethod || 'GET';
    const allHeaders = this.__moneyHeaders || {};
    const startTime = Date.now();

    this.addEventListener('load', function() {
      const contentType = this.getResponseHeader('content-type') || '';
      let responseBody = null;
      if (contentType.includes('json')) {
        try { responseBody = JSON.parse(this.responseText); } catch(e) {}
      }
      // Fallback: if content-type wasn't JSON but URL looks like an API, try parsing anyway
      if (responseBody === null && url.includes('/api/')) {
        try { responseBody = JSON.parse(this.responseText); } catch(e) {}
      }

      // Detect auth tokens in login responses
      if (responseBody && responseBody.data && responseBody.data.data &&
          responseBody.data.data.json_data && responseBody.data.data.json_data.access_token) {
        window.postMessage({
          source: '__money_auth_token',
          token: responseBody.data.data.json_data.access_token,
          tokenType: responseBody.data.data.json_data.token_type || 'Bearer',
          expiresIn: responseBody.data.data.json_data.expires_in,
        }, '*');
      }

      const entry = {
        type: 'xhr',
        url: url.startsWith('http') ? url : location.origin + url,
        method: method,
        status: this.status,
        contentType: contentType,
        requestBody: (body && typeof body === 'string') ? body.substring(0, 2000) : null,
        requestHeaders: allHeaders,
        responseBody: responseBody,
        responseSize: responseBody ? JSON.stringify(responseBody).length : null,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
      window.__moneyRequests.push(entry);
      window.postMessage({ source: '__money_network', entry: entry }, '*');
    });

    return origSend.call(this, body);
  };

  console.log('[Money] Network recorder started');
})();
