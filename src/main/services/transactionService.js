import { transactionRepository } from '../repositories/transactionRepository'

function toApiShape(row) {
  return {
    id: row.id,
    previousStatus: row.previous_status,
    newStatus: row.new_status,
    transactionDate: row.transaction_date,
    deliveredBy: row.delivered_by,
    receivedBy: row.received_by,
    notes: row.notes,
    performedBy: row.performed_by
  }
}

function listByAsset(assetId) {
  return transactionRepository.listByAsset(assetId).map(toApiShape)
}

function listAll(params) {
  return transactionRepository.listAll(params).map((row) => ({
    ...toApiShape(row),
    assetCode: row.asset_code,
    assetName: row.asset_name
  }))
}

export const transactionService = { listByAsset, listAll }
