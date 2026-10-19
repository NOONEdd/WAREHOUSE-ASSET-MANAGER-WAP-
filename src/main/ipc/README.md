IPC handlers - one file per domain (assets, auth, transactions, auditLog, backup,
reports, labels, importData, settings, lookup). Each file registers `ipcMain.handle(...)`
calls and delegates straight to the matching service. No business logic here, just wiring.
