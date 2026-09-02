// The long-running scan belongs to the persistent sidebar. The background
// page only translates a toolbar click into opening that sidebar.
browser.action.onClicked.addListener(() => browser.sidebarAction.open());
