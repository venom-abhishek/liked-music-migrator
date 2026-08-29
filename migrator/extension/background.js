// Opens (or focuses) the extension's own UI tab when the toolbar icon is clicked.
// No chrome.tabs permission needed: chrome.tabs.create/update are always allowed,
// and chrome.tabs.query only needs a matching host permission to see URLs for
// tabs at that origin, which extension pages (chrome-extension://) always are.

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("src/ui/index.html");
  const existing = await chrome.tabs.query({ url });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
