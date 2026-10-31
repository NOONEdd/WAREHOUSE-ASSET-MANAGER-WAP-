import { useState } from 'react'
import { Card, Steps, Button, Select, Typography, Result, Space, message, Descriptions } from 'antd'
import { UploadOutlined, FileExcelOutlined } from '@ant-design/icons'
import ColumnMappingStep from '../components/import/ColumnMappingStep'
import ImportPreviewStep from '../components/import/ImportPreviewStep'
import PageHeader from '../components/common/PageHeader'
import { toPersianDigits } from '../utils/numberFormat'
import { notifyBackupWarning } from '../utils/backupWarning'

const { Text } = Typography

const STEP_TITLES = ['انتخاب فایل', 'نگاشت ستون‌ها', 'پیش‌نمایش و اعتبارسنجی', 'نتیجه']

const initialState = {
  step: 0,
  loading: false,
  filePath: null,
  fileName: null,
  fileType: null,
  sheets: [],
  selectedSheet: null,
  headers: [],
  rows: [],
  mapping: {},
  defaults: {},
  unmapped: [],
  fieldSchema: [],
  previewResults: [],
  previewSummary: null,
  duplicatePolicy: 'skip',
  committing: false,
  commitResult: null
}

export default function ImportPage() {
  const [state, setState] = useState(initialState)
  const patch = (fields) => setState((s) => ({ ...s, ...fields }))

  async function handlePickFile() {
    if (state.loading) return // a pick or inspection is already running
    patch({ loading: true })
    const picked = await window.api.importData.pickFile()
    if (!picked.success) {
      patch({ loading: false })
      if (!picked.canceled) message.error(picked.error)
      return
    }

    const inspected = await window.api.importData.inspectFile(picked.path)
    patch({ loading: false })
    if (!inspected.success) {
      message.error(inspected.error)
      return
    }

    patch({
      filePath: picked.path,
      fileName: picked.fileName,
      fileType: inspected.fileType,
      sheets: inspected.sheets,
      selectedSheet: inspected.sheets?.[0] || null
    })
  }

  async function handleParse() {
    patch({ loading: true })
    const result = await window.api.importData.parseFile(state.filePath, {
      fileType: state.fileType,
      sheetName: state.selectedSheet
    })
    patch({ loading: false })
    if (!result.success) {
      message.error(result.error)
      return
    }
    patch({
      headers: result.headers,
      rows: result.rows,
      mapping: result.mapping,
      unmapped: result.unmapped,
      // The one canonical field list (assetImportSchema.js), received
      // here rather than hardcoded in the wizard steps — see that file's
      // header comment. Stored once per parse and handed to both
      // ColumnMappingStep and ImportPreviewStep below.
      fieldSchema: result.fieldSchema,
      step: 1
    })
  }

  async function handleMappingContinue() {
    patch({ loading: true })
    const result = await window.api.importData.buildPreview({
      headers: state.headers,
      rows: state.rows,
      mapping: state.mapping,
      defaults: state.defaults
    })
    patch({ loading: false })
    if (!result.success) {
      message.error(result.error)
      return
    }
    patch({ previewResults: result.results, previewSummary: result.summary, step: 2 })
  }

  async function handleConfirmImport() {
    if (state.duplicatePolicy === 'cancel' && state.previewSummary.duplicate > 0) {
      message.info('ورود اطلاعات لغو شد')
      setState(initialState)
      return
    }

    patch({ committing: true })
    const result = await window.api.importData.commit({
      headers: state.headers,
      rows: state.rows,
      mapping: state.mapping,
      duplicatePolicy: state.duplicatePolicy,
      defaults: state.defaults
    })
    patch({ committing: false })

    if (!result.success) {
      message.error(result.error || 'ورود اطلاعات با خطا مواجه شد')
      return
    }
    notifyBackupWarning(result)
    patch({ commitResult: result, step: 3 })
  }

  return (
    <div>
      <PageHeader title="ورود اطلاعات دارایی‌ها" description="درون‌ریزی از فایل اکسل، CSV یا PDF در چهار مرحله" />

      <Steps
        current={state.step}
        items={STEP_TITLES.map((title) => ({ title }))}
        style={{ marginBottom: 24, maxWidth: 760 }}
      />

      <Card size="small">
        {state.step === 0 && (
          <div>
            {!state.fileName ? (
              // Phase 10 — the whole panel is a click target for the mouse.
              // The button inside is the one control for keyboard and screen
              // readers: the panel used to be a second role="button" around
              // it (axe: nested-interactive), and a click on the button also
              // reached the panel, so the file dialog opened twice.
              <div className="awm-import-dropzone" onClick={handlePickFile}>
                <div className="awm-import-icon-chip">
                  <UploadOutlined />
                </div>
                <Text strong style={{ display: 'block', marginBottom: 4, fontSize: 14.5 }}>
                  فایل را برای درون‌ریزی انتخاب کنید
                </Text>
                <Text type="secondary" style={{ display: 'block', marginBottom: 18, fontSize: 12.5 }}>
                  فرمت‌های پشتیبانی‌شده: Excel (.xlsx / .xls)، CSV یا PDF
                </Text>
                <Button
                  icon={<UploadOutlined />}
                  onClick={(e) => {
                    e.stopPropagation()
                    handlePickFile()
                  }}
                  loading={state.loading}
                >
                  انتخاب فایل
                </Button>
              </div>
            ) : (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Descriptions size="small" column={1} bordered style={{ maxWidth: 480 }}>
                  <Descriptions.Item label="فایل انتخاب‌شده">
                    <FileExcelOutlined style={{ marginInlineEnd: 6, color: 'var(--awm-preview-valid)' }} />
                    {state.fileName}
                  </Descriptions.Item>
                  {state.sheets.length > 1 && (
                    <Descriptions.Item label="برگه">
                      <Select
                        style={{ width: 220 }}
                        value={state.selectedSheet}
                        onChange={(v) => patch({ selectedSheet: v })}
                        options={state.sheets.map((s) => ({ value: s, label: s }))}
                      />
                    </Descriptions.Item>
                  )}
                </Descriptions>

                <Space>
                  <Button type="primary" onClick={handleParse} loading={state.loading}>
                    ادامه و بررسی فایل
                  </Button>
                  {/* Same handlePickFile as the dropzone above — re-picking
                      just overwrites the file fields on success, matching
                      the Phase-9 behavior where this button was always
                      visible at step 0, not a wizard reset. */}
                  <Button onClick={handlePickFile} loading={state.loading}>
                    انتخاب فایل دیگر
                  </Button>
                </Space>
              </Space>
            )}
          </div>
        )}

        {state.step === 1 && (
          <ColumnMappingStep
            headers={state.headers}
            rows={state.rows}
            mapping={state.mapping}
            onChange={(mapping) => patch({ mapping })}
            defaults={state.defaults}
            onDefaultsChange={(defaults) => patch({ defaults })}
            fieldSchema={state.fieldSchema}
            onBack={() => patch({ step: 0 })}
            onContinue={handleMappingContinue}
          />
        )}

        {state.step === 2 && state.previewSummary && (
          <ImportPreviewStep
            results={state.previewResults}
            summary={state.previewSummary}
            duplicatePolicy={state.duplicatePolicy}
            onDuplicatePolicyChange={(duplicatePolicy) => patch({ duplicatePolicy })}
            fieldSchema={state.fieldSchema}
            onBack={() => patch({ step: 1 })}
            onConfirm={handleConfirmImport}
            committing={state.committing}
          />
        )}

        {state.step === 3 && state.commitResult && (
          <Result
            status="success"
            title="ورود اطلاعات با موفقیت انجام شد"
            subTitle={
              <Descriptions size="small" column={2} style={{ marginTop: 12, textAlign: 'right' }}>
                <Descriptions.Item label="کل ردیف‌ها">
                  {toPersianDigits(state.commitResult.summary.total)}
                </Descriptions.Item>
                <Descriptions.Item label="افزوده‌شده">
                  {toPersianDigits(state.commitResult.summary.imported)}
                </Descriptions.Item>
                <Descriptions.Item label="به‌روزرسانی‌شده">
                  {toPersianDigits(state.commitResult.summary.updated)}
                </Descriptions.Item>
                <Descriptions.Item label="نادیده‌گرفته‌شده (تکراری)">
                  {toPersianDigits(state.commitResult.summary.skipped)}
                </Descriptions.Item>
                <Descriptions.Item label="هشدار">
                  {toPersianDigits(state.commitResult.summary.warnings)}
                </Descriptions.Item>
                <Descriptions.Item label="خطا (وارد نشد)">
                  {toPersianDigits(state.commitResult.summary.errors)}
                </Descriptions.Item>
              </Descriptions>
            }
            extra={
              <Space direction="vertical">
                {state.commitResult.errorDetails?.length > 0 && (
                  <Card size="small" title="جزئیات ردیف‌های وارد‌نشده" style={{ textAlign: 'right', maxWidth: 480 }}>
                    {state.commitResult.errorDetails.map((e) => (
                      <div key={e.rowNumber} style={{ marginBottom: 4, fontSize: 12 }}>
                        ردیف {toPersianDigits(e.rowNumber)}: {e.messages.join(' · ')}
                      </div>
                    ))}
                  </Card>
                )}
                <Button type="primary" onClick={() => setState(initialState)}>
                  ورود فایل جدید
                </Button>
              </Space>
            }
          />
        )}
      </Card>
    </div>
  )
}
