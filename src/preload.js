const { contextBridge, ipcRenderer } = require("electron/renderer");

contextBridge.exposeInMainWorld("appWindow", {
	openDiscord: () => ipcRenderer.send("open-discord"),
	openFAQ: () => ipcRenderer.send("open-faq"),
});
