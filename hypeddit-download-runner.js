(() => {
  const WAIT_TIMEOUT_MS = 25000;
  const BUTTON_SELECTOR = "a#gateDownloadButton.free_dwln[data-type='gate']";

  function isSupportedPage(value = location.href) {
    try {
      const url = new URL(value);
      return url.protocol === "https:"
        && /^(?:www\.)?hypeddit\.com$/i.test(url.hostname)
        && /^\/[^/]+(?:\/[^/]+)?\/?$/.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function waitForButton() {
    return new Promise((resolve, reject) => {
      const find = () => document.querySelector(BUTTON_SELECTOR);
      const existing = find();
      if (existing) {
        resolve(existing);
        return;
      }

      const observer = new MutationObserver(() => {
        const button = find();
        if (!button) return;
        clearTimeout(timeout);
        observer.disconnect();
        resolve(button);
      });
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error("Timed out waiting for Hypeddit's final Download button."));
      }, WAIT_TIMEOUT_MS);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  async function run() {
    if (!isSupportedPage()) throw new Error("Hypeddit opened an unsupported page.");
    const button = await waitForButton();
    if (button.tagName !== "A" || button.id !== "gateDownloadButton") {
      throw new Error("Hypeddit's final Download control had an unexpected structure.");
    }
    button.click();
    return { phase: "clicked" };
  }

  globalThis.HypedditDownloadRunner = Object.freeze({ isSupportedPage, run });
})();
