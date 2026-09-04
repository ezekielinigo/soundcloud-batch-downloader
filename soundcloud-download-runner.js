(() => {
  const WAIT_TIMEOUT_MS = 25000;

  // The interactive track controls are rendered in SoundCloud's same-origin
  // /n/ player iframe. This file is injected into every frame; the outer page
  // must remain idle instead of later reporting a false timeout.
  if (!/^\/n\/[^/]+\/[^/]+/.test(location.pathname)) return;

  function isUsableButton(element) {
    if (!element || element.nodeType !== 1 || element.disabled || element.getAttribute("aria-disabled") === "true") return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || element.getClientRects().length === 0) return false;
    for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
    }
    return true;
  }

  function findDownloadButton() {
    return [...document.querySelectorAll("button[aria-label='Download track']")]
      .find(isUsableButton) || null;
  }

  function waitForDownloadButton() {
    const existing = findDownloadButton();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const button = findDownloadButton();
        if (!button) return;
        clearTimeout(timeout);
        observer.disconnect();
        resolve(button);
      });
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error("Timed out waiting for SoundCloud's Download track button."));
      }, WAIT_TIMEOUT_MS);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-label", "aria-disabled", "class", "style", "disabled"]
      });
    });
  }

  function clickDownloadButton(button) {
    button.scrollIntoView({ block: "center", inline: "center" });
    for (const type of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const pressed = type === "pointerdown" || type === "mousedown";
      button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: pressed ? 1 : 0 }));
    }
    // Use exactly one click so a successful React handler cannot start the
    // official attachment twice.
    button.click();
  }

  async function report(message) {
    await browser.runtime.sendMessage({ type: "soundcloudRunnerResult", ...message });
  }

  void (async () => {
    try {
      const button = await waitForDownloadButton();
      clickDownloadButton(button);
      await report({ ok: true });
    } catch (error) {
      await report({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
})();
