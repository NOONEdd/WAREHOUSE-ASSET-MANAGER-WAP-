import { useState, useEffect, useCallback } from 'react'
import {
  Card,
  Tabs,
  Form,
  Input,
  Upload,
  Button,
  List,
  Space,
  Tag,
  Empty,
  message,
  Modal,
  Checkbox,
  Select,
  Switch,
  Typography
} from 'antd'
import {
  UploadOutlined,
  PlusOutlined,
  DownloadOutlined,
  SaveOutlined,
  ExclamationCircleFilled,
  BankOutlined,
  TagsOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  UndoOutlined,
  SwapOutlined,
  EditOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  SafetyOutlined,
  LockOutlined
} from '@ant-design/icons'
import { toJalaali } from 'jalaali-js'
import { useLookups } from '../hooks/useLookups'
import PageHeader from '../components/common/PageHeader'
import { toPersianDigits } from '../utils/numberFormat'
import { notifyBackupWarning } from '../utils/backupWarning'

const { Text } = Typography

function CompanyInfoTab() {
  return (
    <Form layout="vertical" style={{ maxWidth: 420 }}>
      <Form.Item label="نام شرکت">
        <Input placeholder="شرکت شما" />
      </Form.Item>
      <Form.Item label="لوگوی شرکت">
        <Upload beforeUpload={() => false} maxCount={1}>
          <Button icon={<UploadOutlined />}>انتخاب فایل</Button>
        </Upload>
      </Form.Item>
      <Button type="primary">ذخیره</Button>
    </Form>
  )
}

// First-Run Security phase — the ordinary, already-logged-in path to
// change the Administrator's own password (distinct from
// SetupPasswordPage, which only ever runs once, unauthenticated, before
// any password exists at all). Requires the current password — this
// form never assumes "already inside Settings" is proof enough on its
// own — and clears itself on success rather than leaving the old values
// sitting in the fields.
function SecurityTab() {
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)

  async function handleFinish({ currentPassword, newPassword, confirmPassword }) {
    setSubmitting(true)
    try {
      const result = await window.api.auth.changePassword(currentPassword, newPassword, confirmPassword)
      if (result.success) {
        message.success('رمز عبور با موفقیت تغییر کرد')
        form.resetFields()
      } else {
        message.error(result.error || 'تغییر رمز عبور ناموفق بود')
      }
    } catch {
      message.error('تغییر رمز عبور ناموفق بود')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Form form={form} layout="vertical" style={{ maxWidth: 420 }} onFinish={handleFinish}>
      <Form.Item
        name="currentPassword"
        label="رمز عبور فعلی"
        rules={[{ required: true, message: 'رمز عبور فعلی را وارد کنید' }]}
      >
        <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
      </Form.Item>
      <Form.Item
        name="newPassword"
        label="رمز عبور جدید"
        rules={[
          { required: true, message: 'رمز عبور جدید را وارد کنید' },
          { min: 8, message: 'رمز عبور باید حداقل ۸ کاراکتر باشد' }
        ]}
      >
        <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
      </Form.Item>
      <Form.Item
        name="confirmPassword"
        label="تکرار رمز عبور جدید"
        dependencies={['newPassword']}
        rules={[
          { required: true, message: 'تکرار رمز عبور جدید را وارد کنید' },
          ({ getFieldValue }) => ({
            validator(_, value) {
              if (!value || getFieldValue('newPassword') === value) return Promise.resolve()
              return Promise.reject(new Error('رمز عبور جدید و تکرار آن یکسان نیستند'))
            }
          })
        ]}
      >
        <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={submitting}>
        تغییر رمز عبور
      </Button>
    </Form>
  )
}

function MasterDataTab() {
  const [activeList, setActiveList] = useState('itemTypes')
  const [newName, setNewName] = useState('')
  const [selectedIds, setSelectedIds] = useState([])
  const [deletingId, setDeletingId] = useState(null)
  const [togglingId, setTogglingId] = useState(null)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const { lookups, loading, createItem, reload } = useLookups()

  const listMeta = {
    itemTypes: 'نوع کالا',
    workshops: 'واحد / بخش',
    countries: 'کشور سازنده'
  }
  // "وضعیت" gets its own dedicated panel (StatusManagementPanel) rather
  // than this generic add/delete list — system statuses can't be
  // renamed/deactivated/deleted at all, custom statuses need the
  // active/inactive + reorder + reassign-then-delete flow, none of which
  // this generic list knows how to do.
  const sidebarLabels = { ...listMeta, statuses: 'وضعیت' }
  const sidebarOrder = [...Object.keys(listMeta), 'statuses']

  // A selection from one list (say, item types) must not silently carry
  // over and get bulk-deleted against a different list after switching
  // tabs — the ids wouldn't even mean the same things.
  useEffect(() => {
    setSelectedIds([])
  }, [activeList])

  async function handleAdd() {
    if (!newName.trim()) return
    const result = await createItem(activeList, newName)
    if (result.success) {
      setNewName('')
    } else {
      message.error(result.error)
    }
  }

  function handleDeleteOne(item) {
    Modal.confirm({
      title: 'حذف این مورد؟',
      icon: <ExclamationCircleFilled />,
      content: `«${item.name}» در صورت عدم استفاده حذف، و در صورت استفاده در سوابق تاریخی (دارایی‌های حذف‌شده) غیرفعال خواهد شد.`,
      okText: 'حذف',
      okButtonProps: { danger: true },
      cancelText: 'انصراف',
      onOk: async () => {
        setDeletingId(item.id)
        try {
          const result = await window.api.lookups.delete(activeList, item.id)
          if (result.success) {
            message.success(
              result.action === 'deactivated'
                ? `«${result.name}» به دلیل استفاده در سوابق تاریخی غیرفعال شد؛ برای دارایی‌های جدید قابل انتخاب نیست`
                : 'مورد حذف شد'
            )
            setSelectedIds((prev) => prev.filter((id) => id !== item.id))
            reload()
          } else {
            // Covers "still used by N active asset(s)" — the backend's
            // message already names the item and the count.
            message.error(result.error)
          }
        } catch {
          message.error('حذف با خطا مواجه شد')
        } finally {
          setDeletingId(null)
        }
      }
    })
  }

  function handleDeleteSelected() {
    const count = selectedIds.length
    Modal.confirm({
      title: `حذف ${toPersianDigits(count)} مورد انتخاب‌شده؟`,
      icon: <ExclamationCircleFilled />,
      content:
        'هر مورد جداگانه بررسی می‌شود: بدون استفاده حذف، فقط دارای سوابق تاریخی غیرفعال، و مواردی که دارایی فعالی از آن‌ها استفاده می‌کند دست‌نخورده باقی می‌مانند.',
      okText: 'حذف',
      okButtonProps: { danger: true },
      cancelText: 'انصراف',
      onOk: async () => {
        setBulkDeleting(true)
        try {
          const result = await window.api.lookups.deleteBulk(activeList, selectedIds)
          if (result.success) {
            const parts = []
            if (result.deletedCount > 0) parts.push(`${toPersianDigits(result.deletedCount)} مورد حذف شد`)
            if (result.deactivatedCount > 0) parts.push(`${toPersianDigits(result.deactivatedCount)} مورد غیرفعال شد`)
            if (result.blocked?.length > 0) {
              parts.push(
                `${toPersianDigits(result.blocked.length)} مورد به دلیل استفاده فعال دست‌نخورده ماند: ` +
                  result.blocked.map((b) => `«${b.name}» (${toPersianDigits(b.activeUsage)} دارایی)`).join('، ')
              )
            }
            message[result.blocked?.length > 0 ? 'warning' : 'success'](
              parts.length > 0 ? parts.join(' — ') : 'هیچ تغییری اعمال نشد'
            )
            setSelectedIds([])
            reload()
          } else {
            message.error(result.error)
          }
        } catch {
          message.error('عملیات با خطا مواجه شد')
        } finally {
          setBulkDeleting(false)
        }
      }
    })
  }

  // Base Data Lifecycle phase — "6. REACTIVATE": explicit, independent of
  // the delete flow above, so a retired value can be brought back (or a
  // currently-unused active one manually retired) without going through
  // "delete" at all.
  async function handleToggleActive(item, checked) {
    setTogglingId(item.id)
    try {
      const result = await window.api.lookups.setActive(activeList, item.id, checked)
      if (result.success) {
        message.success(checked ? `«${result.name}» فعال شد` : `«${result.name}» غیرفعال شد`)
        reload()
      } else {
        message.error(result.error)
      }
    } catch {
      message.error('عملیات با خطا مواجه شد')
    } finally {
      setTogglingId(null)
    }
  }

  const items = lookups?.[activeList] ?? []
  const allSelected = items.length > 0 && selectedIds.length === items.length
  const showingStatusPanel = activeList === 'statuses'

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <Space direction="vertical" style={{ width: 160 }}>
        {sidebarOrder.map((key) => (
          <Button
            key={key}
            type={activeList === key ? 'primary' : 'default'}
            block
            onClick={() => setActiveList(key)}
          >
            {sidebarLabels[key]}
          </Button>
        ))}
      </Space>
      {showingStatusPanel ? (
        <div style={{ flex: 1 }}>
          <StatusManagementPanel />
        </div>
      ) : (
      <Card
        size="small"
        style={{ flex: 1 }}
        title={
          <span>
            <span className="awm-section-icon">
              <TagsOutlined />
            </span>
            {listMeta[activeList]}
          </span>
        }
        extra={
          selectedIds.length > 0 ? (
            <Button danger size="small" icon={<DeleteOutlined />} loading={bulkDeleting} onClick={handleDeleteSelected}>
              حذف انتخاب‌شده‌ها ({toPersianDigits(selectedIds.length)})
            </Button>
          ) : null
        }
        loading={loading}
      >
        {items.length ? (
          <>
            <Checkbox
              checked={allSelected}
              indeterminate={selectedIds.length > 0 && !allSelected}
              onChange={(e) => setSelectedIds(e.target.checked ? items.map((i) => i.id) : [])}
              style={{ marginBottom: 8 }}
            >
              انتخاب همه
            </Checkbox>
            <List
              size="small"
              dataSource={items}
              renderItem={(item) => (
                <List.Item
                  actions={[
                    <Switch
                      key="active"
                      size="small"
                      checked={item.is_active !== 0}
                      loading={togglingId === item.id}
                      onChange={(checked) => handleToggleActive(item, checked)}
                      checkedChildren="فعال"
                      unCheckedChildren="غیرفعال"
                    />,
                    <Button
                      key="delete"
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      loading={deletingId === item.id}
                      onClick={() => handleDeleteOne(item)}
                    />
                  ]}
                >
                  <Checkbox
                    checked={selectedIds.includes(item.id)}
                    onChange={(e) =>
                      setSelectedIds((prev) =>
                        e.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id)
                      )
                    }
                    style={{ marginInlineEnd: 10 }}
                  />
                  {item.name}
                  {item.is_active === 0 && (
                    <Tag style={{ marginInlineStart: 8 }}>غیرفعال</Tag>
                  )}
                </List.Item>
              )}
            />
          </>
        ) : (
          <Empty description="هنوز موردی ثبت نشده" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
        <Space.Compact style={{ marginTop: 12, width: '100%' }}>
          <Input
            placeholder="نام مورد جدید..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onPressEnter={handleAdd}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            افزودن
          </Button>
        </Space.Compact>
      </Card>
      )}
    </div>
  )
}

function StatusManagementPanel() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [renameItem, setRenameItem] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [migrateModalItem, setMigrateModalItem] = useState(null)
  const [migrateTarget, setMigrateTarget] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    window.api.lookups
      .listStatuses()
      .then((rows) => setItems(rows))
      .catch(() => message.error('بارگذاری فهرست وضعیت‌ها با خطا مواجه شد'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleAdd() {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const result = await window.api.lookups.createStatus(newName)
      if (result.success) {
        message.success('وضعیت جدید افزوده شد')
        notifyBackupWarning(result)
        setNewName('')
        load()
      } else {
        message.error(result.error)
      }
    } finally {
      setCreating(false)
    }
  }

  function openRenameModal(item) {
    setRenameValue(item.name)
    setRenameItem(item)
  }

  async function handleConfirmRename() {
    if (!renameValue.trim()) {
      message.warning('نام وضعیت نمی‌تواند خالی باشد')
      return
    }
    setBusyId(renameItem.id)
    try {
      const result = await window.api.lookups.renameStatus(renameItem.id, renameValue)
      if (result.success) {
        message.success('نام وضعیت به‌روزرسانی شد')
        notifyBackupWarning(result)
        setRenameItem(null)
        load()
      } else {
        message.error(result.error)
      }
    } finally {
      setBusyId(null)
    }
  }

  // Deactivating needs no confirmation dialog — it's fully reversible
  // (the same toggle, flipped back) and touches no asset or history data
  // at all, unlike delete. Reactivating even less so.
  async function handleToggleActive(item) {
    setBusyId(item.id)
    try {
      const result = await window.api.lookups.setStatusActive(item.id, !item.isActive)
      if (result.success) {
        message.success(item.isActive ? 'وضعیت غیرفعال شد' : 'وضعیت فعال شد')
        notifyBackupWarning(result)
        load()
      } else {
        message.error(result.error)
      }
    } finally {
      setBusyId(null)
    }
  }

  async function handleMove(item, direction) {
    setBusyId(item.id)
    try {
      const result = await window.api.lookups.moveStatus(item.id, direction)
      if (result.success) load()
      else message.error(result.error)
    } finally {
      setBusyId(null)
    }
  }

  function handleDeleteUnused(item) {
    Modal.confirm({
      title: 'حذف این وضعیت؟',
      icon: <ExclamationCircleFilled />,
      content: `«${item.name}» حذف خواهد شد. هیچ دارایی‌ای از آن استفاده نمی‌کند. این عملیات قابل بازگشت نیست.`,
      okText: 'حذف',
      okButtonProps: { danger: true },
      cancelText: 'انصراف',
      onOk: async () => {
        setBusyId(item.id)
        try {
          const result = await window.api.lookups.deleteStatus(item.id)
          if (result.success) {
            message.success('وضعیت حذف شد')
            notifyBackupWarning(result)
            load()
          } else {
            message.error(result.error)
          }
        } catch {
          message.error('حذف با خطا مواجه شد')
        } finally {
          setBusyId(null)
        }
      }
    })
  }

  function openMigrateModal(item) {
    setMigrateTarget(null)
    setMigrateModalItem(item)
  }

  async function handleConfirmMigrate() {
    if (!migrateTarget) {
      message.warning('وضعیت مقصد را انتخاب کنید')
      return
    }
    const item = migrateModalItem
    setBusyId(item.id)
    try {
      const result = await window.api.lookups.migrateAndDeleteStatus(item.id, migrateTarget)
      if (result.success) {
        message.success(
          `وضعیت «${item.name}» حذف شد و ${toPersianDigits(result.assetCount)} دارایی به «${migrateTarget}» منتقل شد`
        )
        notifyBackupWarning(result)
        setMigrateModalItem(null)
        load()
      } else {
        message.error(result.error)
      }
    } catch {
      message.error('عملیات با خطا مواجه شد')
    } finally {
      setBusyId(null)
    }
  }

  // Reassignment must always land on something still selectable for new
  // assets — an inactive target would just move the problem sideways —
  // and never onto the status being removed itself.
  const migrateTargetOptions = items
    .filter((s) => s.isActive && s.id !== migrateModalItem?.id)
    .map((s) => ({ value: s.name, label: s.name }))

  return (
    <Card
      size="small"
      title={
        <span>
          <span className="awm-section-icon">
            <TagsOutlined />
          </span>
          وضعیت‌های دارایی
        </span>
      }
      loading={loading}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        وضعیت‌های سیستمی برنامه ثابت هستند و قابل ویرایش، غیرفعال‌سازی یا حذف نیستند. وضعیت‌های دیگر را می‌توانید
        در این بخش اضافه، ویرایش، فعال/غیرفعال یا حذف کنید — وضعیت غیرفعال برای دارایی‌های جدید قابل انتخاب
        نیست، اما دارایی‌ها و سوابق موجودی که از آن استفاده می‌کنند بدون تغییر باقی می‌مانند.
      </Typography.Paragraph>

      <List
        size="small"
        bordered
        dataSource={items}
        renderItem={(item, index) => (
          <List.Item
            actions={
              item.isSystem
                ? [
                    <Button
                      key="up"
                      type="text"
                      size="small"
                      icon={<ArrowUpOutlined />}
                      disabled={index === 0}
                      loading={busyId === item.id}
                      onClick={() => handleMove(item, 'up')}
                    />,
                    <Button
                      key="down"
                      type="text"
                      size="small"
                      icon={<ArrowDownOutlined />}
                      disabled={index === items.length - 1}
                      loading={busyId === item.id}
                      onClick={() => handleMove(item, 'down')}
                    />
                  ]
                : [
                    <Button
                      key="up"
                      type="text"
                      size="small"
                      icon={<ArrowUpOutlined />}
                      disabled={index === 0}
                      loading={busyId === item.id}
                      onClick={() => handleMove(item, 'up')}
                    />,
                    <Button
                      key="down"
                      type="text"
                      size="small"
                      icon={<ArrowDownOutlined />}
                      disabled={index === items.length - 1}
                      loading={busyId === item.id}
                      onClick={() => handleMove(item, 'down')}
                    />,
                    <Button
                      key="rename"
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      loading={busyId === item.id}
                      onClick={() => openRenameModal(item)}
                    />,
                    <Switch
                      key="active"
                      size="small"
                      checked={item.isActive}
                      loading={busyId === item.id}
                      onChange={() => handleToggleActive(item)}
                      checkedChildren="فعال"
                      unCheckedChildren="غیرفعال"
                    />,
                    item.usageCount > 0 ? (
                      <Button
                        key="migrate"
                        size="small"
                        icon={<SwapOutlined />}
                        loading={busyId === item.id}
                        onClick={() => openMigrateModal(item)}
                      >
                        انتقال و حذف
                      </Button>
                    ) : (
                      <Button
                        key="delete"
                        type="text"
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        loading={busyId === item.id}
                        onClick={() => handleDeleteUnused(item)}
                      />
                    )
                  ]
            }
          >
            {item.name}
            {item.isSystem ? (
              <Tag color="green" style={{ marginInlineStart: 8 }}>
                سیستمی
              </Tag>
            ) : (
              <Tag color={item.isActive ? 'blue' : 'default'} style={{ marginInlineStart: 8 }}>
                {item.isActive ? 'فعال' : 'غیرفعال'}
              </Tag>
            )}
            <Tag style={{ marginInlineStart: 4 }} color={item.usageCount > 0 ? 'orange' : 'default'}>
              {item.usageCount > 0 ? `${toPersianDigits(item.usageCount)} دارایی` : 'بدون استفاده'}
            </Tag>
          </List.Item>
        )}
      />

      <Space.Compact style={{ marginTop: 12, width: '100%', maxWidth: 420 }}>
        <Input
          placeholder="نام وضعیت جدید..."
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onPressEnter={handleAdd}
        />
        <Button type="primary" icon={<PlusOutlined />} loading={creating} onClick={handleAdd}>
          افزودن وضعیت
        </Button>
      </Space.Compact>

      <Modal
        title="ویرایش نام وضعیت"
        open={Boolean(renameItem)}
        onCancel={() => setRenameItem(null)}
        onOk={handleConfirmRename}
        confirmLoading={busyId === renameItem?.id}
        okText="ذخیره"
        cancelText="انصراف"
      >
        <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onPressEnter={handleConfirmRename} />
      </Modal>

      <Modal
        title="انتقال دارایی‌ها و حذف وضعیت"
        open={Boolean(migrateModalItem)}
        onCancel={() => setMigrateModalItem(null)}
        onOk={handleConfirmMigrate}
        confirmLoading={busyId === migrateModalItem?.id}
        okText="انتقال و حذف"
        okButtonProps={{ danger: true }}
        cancelText="انصراف"
      >
        {migrateModalItem && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text>
              {toPersianDigits(migrateModalItem.usageCount)} دارایی هم‌اکنون وضعیت «{migrateModalItem.name}» را
              دارند. به‌جای حذف کامل، می‌توانید آن را غیرفعال کنید تا سوابق موجود دست‌نخورده بمانند؛ در صورت تمایل
              به حذف کامل، وضعیت مقصد را انتخاب کنید تا این دارایی‌ها به آن منتقل شده و سپس «{migrateModalItem.name}»
              حذف شود.
            </Text>
            <Select
              style={{ width: '100%' }}
              placeholder="وضعیت مقصد را انتخاب کنید"
              options={migrateTargetOptions}
              value={migrateTarget}
              onChange={setMigrateTarget}
            />
          </Space>
        )}
      </Modal>
    </Card>
  )
}

function formatBackupTimestamp(iso) {
  const d = new Date(iso)
  const { jy, jm, jd } = toJalaali(d)
  const pad2 = (n) => String(n).padStart(2, '0')
  return toPersianDigits(`${jy}/${pad2(jm)}/${pad2(jd)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`)
}

function confirmRestore(fileName, onOk) {
  Modal.confirm({
    title: 'بازیابی پایگاه‌داده',
    icon: <ExclamationCircleFilled />,
    okText: 'بازیابی',
    okType: 'danger',
    cancelText: 'انصراف',
    content: (
      <div>
        <p>
          نسخه پشتیبان «<span className="awm-mono">{fileName}</span>» بازیابی خواهد شد. تمام داده‌های فعلی با
          این نسخه جایگزین می‌شود و برنامه بلافاصله مجدداً راه‌اندازی خواهد شد.
        </p>
        <p>
          <b>این عملیات قابل بازگشت نیست.</b> با این حال، پیش از بازیابی، از وضعیت فعلی به‌طور خودکار یک نسخه
          پشتیبان امنیتی گرفته می‌شود.
        </p>
      </div>
    ),
    onOk
  })
}

function BackupTab() {
  const [backups, setBackups] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [restoringFile, setRestoringFile] = useState(null)
  const [downloadingFile, setDownloadingFile] = useState(null)
  const [dirInfo, setDirInfo] = useState(null)
  const [changingDir, setChangingDir] = useState(false)
  const [resettingDir, setResettingDir] = useState(false)

  const loadBackups = useCallback(() => {
    setLoading(true)
    window.api.backup
      .list()
      .then((rows) => setBackups(rows))
      .catch(() => {
        setBackups([])
        message.error('بارگذاری فهرست پشتیبان‌ها با خطا مواجه شد')
      })
      .finally(() => setLoading(false))
  }, [])

  const loadDirInfo = useCallback(() => {
    window.api.backup
      .getDirInfo()
      .then((info) => setDirInfo(info))
      .catch(() => setDirInfo(null))
  }, [])

  useEffect(() => {
    loadBackups()
    loadDirInfo()
  }, [loadBackups, loadDirInfo])

  async function handleCreateBackup() {
    setCreating(true)
    try {
      const result = await window.api.backup.create()
      if (result.success) {
        message.success('پشتیبان‌گیری با موفقیت انجام شد')
        loadBackups()
      } else {
        message.error(result.error || 'پشتیبان‌گیری ناموفق بود')
      }
    } finally {
      setCreating(false)
    }
  }

  // Picking a new folder only changes WHERE FUTURE backups are written —
  // nothing already on disk in the previous folder is moved or deleted,
  // so it simply stops appearing in this list (see backupService's
  // listBackups comment). Worth saying plainly here too, since silently
  // showing an empty/different list right after a folder change could
  // otherwise read as "my backups are gone".
  async function handleChangeDir() {
    setChangingDir(true)
    try {
      const result = await window.api.backup.pickDir()
      if (result.success) {
        message.success('پوشه پشتیبان‌گیری تغییر کرد؛ پشتیبان‌های قبلی در پوشه پیشین باقی می‌مانند')
        loadDirInfo()
        loadBackups()
      } else if (!result.canceled) {
        message.error(result.error || 'تغییر پوشه ناموفق بود')
      }
    } finally {
      setChangingDir(false)
    }
  }

  async function handleResetDir() {
    setResettingDir(true)
    try {
      const result = await window.api.backup.resetDir()
      if (result.success) {
        message.success('پوشه پیش‌فرض بازگردانده شد')
        loadDirInfo()
        loadBackups()
      } else {
        message.error(result.error || 'بازگشت به پوشه پیش‌فرض ناموفق بود')
      }
    } finally {
      setResettingDir(false)
    }
  }

  // On success these never actually resolve from the renderer's point of
  // view — the app exits and relaunches before an IPC response can come
  // back — so the loading message is left showing on purpose rather than
  // dismissed, until the whole window is replaced by the fresh instance.
  async function runRestore(restoreCall, fileName) {
    setRestoringFile(fileName)
    message.loading({
      content: 'در حال ایجاد نسخه پشتیبان امنیتی و بازیابی… برنامه به‌زودی مجدداً راه‌اندازی می‌شود',
      duration: 0,
      key: 'restore'
    })
    try {
      const result = await restoreCall()
      if (!result.success && !result.canceled) {
        message.destroy('restore')
        message.error(result.error || 'بازیابی ناموفق بود')
      }
    } catch {
      message.destroy('restore')
      message.error('بازیابی ناموفق بود')
    } finally {
      setRestoringFile(null)
    }
  }

  function handleRestoreListed(fileName) {
    confirmRestore(fileName, () =>
      runRestore(() => window.api.backup.restoreByFileName(fileName), fileName)
    )
  }

  async function handleRestoreFromFile() {
    const picked = await window.api.backup.pickFile()
    if (!picked.success) return // canceled — nothing to do
    confirmRestore(picked.fileName, () =>
      runRestore(() => window.api.backup.restoreFromPath(picked.path), picked.fileName)
    )
  }

  async function handleDownload(fileName) {
    setDownloadingFile(fileName)
    try {
      const result = await window.api.backup.downloadCopy(fileName)
      if (result.success) {
        message.success('فایل با موفقیت ذخیره شد')
      } else if (!result.canceled) {
        message.error(result.error || 'ذخیره فایل ناموفق بود')
      }
    } finally {
      setDownloadingFile(null)
    }
  }

  return (
    <div>
      <Card size="small" style={{ marginBottom: 16, background: 'var(--awm-surface-sunken, #fafafa)' }}>
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Space wrap>
            <FolderOpenOutlined />
            <Text>پوشه ذخیره پشتیبان‌ها:</Text>
            <Text className="awm-mono" strong>
              {dirInfo?.path || '…'}
            </Text>
            {dirInfo && <Tag color={dirInfo.isCustom ? 'blue' : 'default'}>{dirInfo.isCustom ? 'سفارشی' : 'پیش‌فرض'}</Tag>}
          </Space>
          <Space wrap>
            <Button size="small" icon={<SwapOutlined />} loading={changingDir} onClick={handleChangeDir}>
              تغییر پوشه
            </Button>
            {dirInfo?.isCustom && (
              <Button size="small" icon={<UndoOutlined />} loading={resettingDir} onClick={handleResetDir}>
                بازگشت به پوشه پیش‌فرض
              </Button>
            )}
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            پشتیبان‌های خودکار و دستی از این پس در پوشه انتخاب‌شده ذخیره می‌شوند. پشتیبان‌های موجود در پوشه‌های
            قبلی حذف یا جابه‌جا نمی‌شوند، فقط تا زمانی که همان پوشه فعال باشد در این فهرست نمایش داده می‌شوند.
          </Text>
        </Space>
      </Card>

      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<SaveOutlined />} loading={creating} onClick={handleCreateBackup}>
          پشتیبان‌گیری اکنون
        </Button>
        <Button icon={<UploadOutlined />} onClick={handleRestoreFromFile}>
          بازیابی از فایل
        </Button>
      </Space>
      {!loading && backups.length === 0 ? (
        <Empty description="هنوز پشتیبانی گرفته نشده" />
      ) : (
        <List
          size="small"
          bordered
          loading={loading}
          dataSource={backups}
          renderItem={(b) => (
            <List.Item
              actions={[
                <Button
                  key="restore"
                  size="small"
                  loading={restoringFile === b.fileName}
                  onClick={() => handleRestoreListed(b.fileName)}
                >
                  بازیابی
                </Button>,
                <Button
                  key="download"
                  size="small"
                  icon={<DownloadOutlined />}
                  loading={downloadingFile === b.fileName}
                  onClick={() => handleDownload(b.fileName)}
                />
              ]}
            >
              <span className="awm-mono">{b.fileName}</span>
              <Tag style={{ marginInlineStart: 8 }}>{formatBackupTimestamp(b.createdAt)}</Tag>
              <Tag color={b.auto ? 'geekblue' : 'default'}>{b.auto ? 'خودکار' : 'دستی'}</Tag>
            </List.Item>
          )}
        />
      )}
    </div>
  )
}

export default function SettingsPage() {
  return (
    <div>
      <PageHeader title="تنظیمات" description="اطلاعات شرکت، داده‌های پایه و پشتیبان‌گیری" />
      <Card size="small">
        <Tabs
          items={[
            {
              key: 'company',
              label: 'اطلاعات شرکت',
              icon: <BankOutlined />,
              children: <CompanyInfoTab />
            },
            {
              key: 'master',
              label: 'داده‌های پایه',
              icon: <TagsOutlined />,
              children: <MasterDataTab />
            },
            {
              key: 'backup',
              label: 'پشتیبان‌گیری و بازیابی',
              icon: <CloudUploadOutlined />,
              children: <BackupTab />
            },
            {
              key: 'security',
              label: 'امنیت',
              icon: <SafetyOutlined />,
              children: <SecurityTab />
            }
          ]}
        />
      </Card>
    </div>
  )
}
