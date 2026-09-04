(async () => {
  const text = (value) => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (location.hostname !== "accounts.spotify.com") {
    throw new Error("The Spotify probe ran on an unexpected website.");
  }

  const bootstrapElement = document.querySelector('#bootstrap-data[sp-bootstrap-data]');
  if (bootstrapElement) {
    try {
      const bootstrap = JSON.parse(bootstrapElement.getAttribute("sp-bootstrap-data"));
      const username = text(bootstrap?.user?.displayName);
      if (username) return { state: "signed-in", username };
    } catch (_) {
      // Fall through to the rendered status markers when Spotify changes or
      // temporarily returns an incomplete bootstrap payload.
    }
  }

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (document.querySelector('[data-testid="status-logged-out"]')) return { state: "signed-out" };
    const loggedIn = document.querySelector('[data-testid="status-logged-in"]');
    if (loggedIn) {
      const userInfo = loggedIn.querySelector('[data-testid="user-info"]');
      const username = [...(userInfo?.parentElement?.children || [])]
        .slice(1)
        .map((element) => text(element.textContent))
        .find(Boolean) || "";
      if (!username) return { state: "error", message: "Spotify did not expose the signed-in account name." };
      return { state: "signed-in", username };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { state: "error", message: "Spotify's account status did not load in time." };
})();
