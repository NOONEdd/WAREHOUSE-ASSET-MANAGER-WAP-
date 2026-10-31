import { contextBridge, ipcRenderer } from 'electron'

// This is the only bridge between the renderer and the main process
// (Phase 2, Section 1). The renderer can only ever call what's explicitly
// exposed here — nothing else, no direct Node.js or filesystem access.
//
// Namespaces filled in as each phase builds its handlers — assets and
// lookups (read) plus auth land in Phase 8; transactions, backup, reports,
// and settings followed in their own phases. importData landed in Phase 9.
const api = {
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion')
  },
  auth: {
    login: (username, password) => ipcRenderer.invoke('auth:login', username, password),
    logout: () => ipcRenderer.invoke('auth:logout'),
    currentUser: () => ipcRenderer.invoke('auth:currentUser'),
    needsFirstRunSetup: () => ipcRenderer.invoke('auth:needsFirstRunSetup'),
    completeFirstRunSetup: (newPassword, confirmPassword) =>
      ipcRenderer.invoke('auth:completeFirstRunSetup', newPassword, confirmPassword),
    changePassword: (currentPassword, newPassword, confirmPassword) =>
      ipcRenderer.invoke('auth:changePassword', { currentPassword, newPassword, confirmPassword })
  },
  assets: {
    list: (filters) => ipcRenderer.invoke('assets:list', filters),
    get: (id) => ipcRenderer.invoke('assets:get', id),
    dashboardStats: () => ipcRenderer.invoke('assets:dashboardStats'),
    countByWorkshop: () => ipcRenderer.invoke('assets:countByWorkshop'),
    countByItemType: () => ipcRenderer.invoke('assets:countByItemType'),
    countByCountry: () => ipcRenderer.invoke('assets:countByCountry'),
    recentActivity: (limit) => ipcRenderer.invoke('assets:recentActivity', limit),
    dataQuality: () => ipcRenderer.invoke('assets:dataQuality'),
    create: (input) => ipcRenderer.invoke('assets:create', input),
    update: (id, input) => ipcRenderer.invoke('assets:update', id, input),
    delete: (id) => ipcRenderer.invoke('assets:delete', id),
    deleteBulk: (ids) => ipcRenderer.invoke('assets:deleteBulk', ids),
    changeStatus: (id, statusChange) => ipcRenderer.invoke('assets:changeStatus', id, statusChange),
    changeStatusBulk: (ids, statusChange) => ipcRenderer.invoke('assets:changeStatusBulk', ids, statusChange)
  },
  lookups: {
    getAll: () => ipcRenderer.invoke('lookups:getAll'),
    create: (kind, name) => ipcRenderer.invoke('lookups:create', kind, name),
    delete: (kind, id) => ipcRenderer.invoke('lookups:delete', kind, id),
    deleteBulk: (kind, ids) => ipcRenderer.invoke('lookups:deleteBulk', kind, ids),
    setActive: (kind, id, isActive) => ipcRenderer.invoke('lookups:setActive', kind, id, isActive),
    listStatuses: () => ipcRenderer.invoke('lookups:listStatuses'),
    createStatus: (name) => ipcRenderer.invoke('lookups:createStatus', name),
    renameStatus: (id, newName) => ipcRenderer.invoke('lookups:renameStatus', id, newName),
    setStatusActive: (id, isActive) => ipcRenderer.invoke('lookups:setStatusActive', id, isActive),
    moveStatus: (id, direction) => ipcRenderer.invoke('lookups:moveStatus', id, direction),
    deleteStatus: (id) => ipcRenderer.invoke('lookups:deleteStatus', id),
    migrateAndDeleteStatus: (id, targetStatusName) =>
      ipcRenderer.invoke('lookups:migrateAndDeleteStatus', id, targetStatusName)
  },
  auditLog: {
    list: (filters) => ipcRenderer.invoke('auditLog:list', filters)
  },
  transactions: {
    listByAsset: (assetId) => ipcRenderer.invoke('transactions:listByAsset', assetId),
    listAll: (params) => ipcRenderer.invoke('transactions:listAll', params)
  },
  export: {
    toExcel: (payload) => ipcRenderer.invoke('export:toExcel', payload),
    toPdf: (payload) => ipcRenderer.invoke('export:toPdf', payload),
    printLabels: (assets) => ipcRenderer.invoke('export:printLabels', { assets })
  },
  backup: {
    list: () => ipcRenderer.invoke('backup:list'),
    create: () => ipcRenderer.invoke('backup:create'),
    restoreByFileName: (fileName) => ipcRenderer.invoke('backup:restoreByFileName', fileName),
    pickFile: () => ipcRenderer.invoke('backup:pickFile'),
    restoreFromPath: (filePath) => ipcRenderer.invoke('backup:restoreFromPath', filePath),
    downloadCopy: (fileName) => ipcRenderer.invoke('backup:downloadCopy', fileName),
    getDirInfo: () => ipcRenderer.invoke('backup:getDirInfo'),
    pickDir: () => ipcRenderer.invoke('backup:pickDir'),
    resetDir: () => ipcRenderer.invoke('backup:resetDir')
  },
  importData: {
    pickFile: () => ipcRenderer.invoke('import:pickFile'),
    inspectFile: (filePath) => ipcRenderer.invoke('import:inspectFile', filePath),
    parseFile: (filePath, options) => ipcRenderer.invoke('import:parseFile', filePath, options),
    buildPreview: (payload) => ipcRenderer.invoke('import:buildPreview', payload),
    commit: (payload) => ipcRenderer.invoke('import:commit', payload)
  },
  savedFilters: {
    list: () => ipcRenderer.invoke('savedFilters:list'),
    create: (name, filters) => ipcRenderer.invoke('savedFilters:create', name, filters),
    delete: (id) => ipcRenderer.invoke('savedFilters:delete', id)
  }
}

contextBridge.exposeInMainWorld('api', api)
