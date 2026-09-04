(() => {
  const WAIT_TIMEOUT_MS = 25000;

  function textOf(element) {
    return (element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    if (!element || element.nodeType !== 1 || element.getClientRects().length === 0) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
    }
    return true;
  }

  function visibleMatch(selector, predicate = () => true) {
    return [...document.querySelectorAll(selector)].find((element) => isVisible(element) && predicate(element)) || null;
  }

  function waitFor(description, find, stableForMs = 200) {
    return new Promise((resolve, reject) => {
      let stabilityTimer = null;
      const finish = (value) => {
        clearTimeout(timeout);
        if (stabilityTimer) clearTimeout(stabilityTimer);
        observer.disconnect();
        resolve(value);
      };
      const check = () => {
        const candidate = find();
        if (!candidate) {
          if (stabilityTimer) clearTimeout(stabilityTimer);
          stabilityTimer = null;
          return;
        }
        if (stabilityTimer) return;
        stabilityTimer = setTimeout(() => {
          stabilityTimer = null;
          const confirmed = find();
          if (confirmed) finish(confirmed);
        }, stableForMs);
      };
      const observer = new MutationObserver(check);
      const timeout = setTimeout(() => {
        if (stabilityTimer) clearTimeout(stabilityTimer);
        observer.disconnect();
        reject(new Error(`Timed out waiting for ${description}.`));
      }, WAIT_TIMEOUT_MS);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "disabled"] });
      check();
    });
  }

  function click(element) {
    if (!isVisible(element) || element.disabled || element.getAttribute("aria-disabled") === "true") {
      throw new Error("Bandcamp exposed a download control before it was ready to use.");
    }
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
  }

  function setPriceToZero(input) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, "0");
    else input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function setSelectValue(select, value) {
    if (![...select.options].some((option) => option.value === value)) {
      throw new Error(`Bandcamp's country selector does not offer ${value}.`);
    }
    select.value = value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function runEmailPhase(email) {
    if (!email) throw new Error("A Bandcamp email address is required for this download.");
    const emailInput = await waitFor("the Bandcamp email field", () => visibleMatch("#fan_email_address"));
    const country = await waitFor("the Bandcamp country selector", () => visibleMatch("#fan_email_country"));
    const postalCode = await waitFor("the Bandcamp postal-code field", () => visibleMatch("#fan_email_postalcode"));
    setInputValue(emailInput, email);
    setSelectValue(country, "US");
    setInputValue(postalCode, "0");
    const okButton = await waitFor("the Bandcamp OK button", () => visibleMatch(
      "button.download-panel-checkout-button",
      (element) => /^ok$/i.test(textOf(element))
    ));
    click(okButton);
    const handoff = await waitFor("Bandcamp's email handoff", () => {
      const error = visibleMatch("#download-panel-vm .error-bubble.alert, #download-panel-vm [role='alert']");
      if (error) return { error: textOf(error) || "Bandcamp rejected the email form." };
      return visibleMatch("#fan_email_address") ? null : { sent: true };
    });
    if (handoff.error) throw new Error(handoff.error);
    return { phase: "email-sent" };
  }

  async function runReleasePhase(email) {
    const buyButton = await waitFor("the Buy Digital Track button", () => visibleMatch(
      "button.download-link.buy-link, .download-link.buy-link",
      (element) => /^buy digital (track|album)$/i.test(textOf(element))
    ));
    click(buyButton);

    const priceInput = await waitFor("the fully opened Bandcamp purchase dialog", () => visibleMatch("#download-panel-vm #userPrice, #userPrice"), 350);
    setPriceToZero(priceInput);

    const freeDownloadLink = await waitFor("the download to your computer link", () => visibleMatch(
      [
        ".payment-nag-continue a.download-panel-free-download-link",
        ".payment-nag-continue a.grey-link",
        ".payment-nag-continue a"
      ].join(", "),
      (element) => /^download to your computer$/i.test(textOf(element))
    ));
    click(freeDownloadLink);

    const nextAction = await waitFor("the Download Now button or email form", () => {
      const emailField = visibleMatch("#fan_email_address");
      if (emailField) return { type: "email" };
      const downloadButton = visibleMatch(
        "button.download-panel-checkout-button",
        (element) => /^download now$/i.test(textOf(element))
      );
      return downloadButton ? { type: "download", element: downloadButton } : null;
    });
    if (nextAction.type === "email") return runEmailPhase(email);
    click(nextAction.element);
    return { phase: "awaiting-download-page" };
  }

  async function runDownloadPhase(fileType) {
    const format = await waitFor("the Bandcamp format selector", () => visibleMatch("select#format-type"));
    const option = [...format.options].find((entry) => entry.value === fileType);
    if (!option) throw new Error(`The configured Bandcamp format (${fileType}) is not available for this release.`);

    format.value = fileType;
    format.dispatchEvent(new Event("input", { bubbles: true }));
    format.dispatchEvent(new Event("change", { bubbles: true }));

    const downloadLink = await waitFor("the final Bandcamp Download link", () => visibleMatch(
      "a[data-bind*='downloadUrl'], .free-download a",
      (element) => /^download$/i.test(textOf(element)) && Boolean(element.href)
    ));
    const downloadUrl = downloadLink.href;
    click(downloadLink);
    return { phase: "download-started", downloadUrl };
  }

  globalThis.BandcampDownloadRunner = Object.freeze({
    run(phase, fileType, email) {
      if (phase === "release") return runReleasePhase(email);
      if (phase === "download") return runDownloadPhase(fileType);
      throw new Error(`Unsupported Bandcamp automation phase: ${phase}`);
    }
  });
})();
