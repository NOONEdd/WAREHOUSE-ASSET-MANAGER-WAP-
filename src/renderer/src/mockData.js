// Mock data matching the Phase 3 schema exactly. Replaced with real
// window.api calls once Phase 8 connects SQLite — kept in one file so
// that swap is a small, contained change later.

export const mockStatuses = ['در انبار', 'صادر شده', 'مرجوع شده', 'تعمیر', 'آسیب‌دیده', 'مفقود']

export const mockDashboardStats = {
  total: 5247,
  inWarehouse: 3102,
  issued: 1890,
  maintenance: 140,
  damagedOrLost: 115
}

export const mockAssets = [
  {
    id: 1047,
    assetCode: 'A-0001',
    assetName: 'لپ‌تاپ دل لتیتود',
    itemType: 'لپ‌تاپ',
    model: 'Dell Latitude 5420',
    serialNumber: 'SN10234',
    country: 'چین',
    workshop: 'فناوری اطلاعات',
    entryDate: '2026-05-06',
    exitDate: null,
    deliveredBy: 'شرکت حمل‌ونقل الف',
    receivedBy: 'علی رضایی',
    status: 'در انبار',
    notes: '',
    createdAt: '2026-05-06',
    updatedAt: '2026-07-28'
  },
  {
    id: 1048,
    assetCode: 'A-0002',
    assetName: 'صندلی اداری ارگونومیک',
    itemType: 'مبلمان اداری',
    model: 'Herman Miller Aeron',
    serialNumber: 'SN88213',
    country: 'آمریکا',
    workshop: 'منابع انسانی',
    entryDate: '2026-03-12',
    exitDate: null,
    deliveredBy: 'انبار مرکزی',
    receivedBy: 'سارا احمدی',
    status: 'در انبار',
    notes: '',
    createdAt: '2026-03-12',
    updatedAt: '2026-03-12'
  },
  {
    id: 1049,
    assetCode: 'A-0003',
    assetName: 'دستگاه جوش آرگون',
    itemType: 'ماشین‌آلات',
    model: 'Miller Dynasty 210',
    serialNumber: 'SN55012',
    country: 'آمریکا',
    workshop: 'تولید',
    entryDate: '2025-11-02',
    exitDate: '2026-06-15',
    deliveredBy: 'انبار مرکزی',
    receivedBy: 'رضا کریمی',
    status: 'صادر شده',
    notes: 'برای خط تولید ۲ ارسال شد',
    createdAt: '2025-11-02',
    updatedAt: '2026-06-15'
  },
  {
    id: 1050,
    assetCode: 'A-0004',
    assetName: 'پرینتر لیزری',
    itemType: 'تجهیزات اداری',
    model: 'HP LaserJet Pro M404',
    serialNumber: 'SN30291',
    country: 'ویتنام',
    workshop: 'مالی',
    entryDate: '2026-01-20',
    exitDate: null,
    deliveredBy: 'شرکت حمل‌ونقل ب',
    receivedBy: 'مریم حسینی',
    status: 'تعمیر',
    notes: 'کارتریج نیاز به تعویض دارد',
    createdAt: '2026-01-20',
    updatedAt: '2026-07-20'
  },
  {
    id: 1051,
    assetCode: 'A-0005',
    assetName: 'ون حمل و نقل',
    itemType: 'خودرو',
    model: 'Toyota HiAce 2023',
    serialNumber: 'SNVIN99881',
    country: 'ژاپن',
    workshop: 'لجستیک',
    entryDate: '2025-08-14',
    exitDate: null,
    deliveredBy: 'نمایندگی خودرو',
    receivedBy: 'حسین مرادی',
    status: 'آسیب‌دیده',
    notes: 'تصادف جزئی - در انتظار ارزیابی بیمه',
    createdAt: '2025-08-14',
    updatedAt: '2026-07-10'
  }
]

export const mockAuditLog = [
  {
    id: 1,
    user: 'admin',
    action: 'ویرایش',
    entity: 'دارایی A-0004',
    detail: 'وضعیت: در انبار ← تعمیر',
    occurredAt: '2026-07-20'
  },
  {
    id: 2,
    user: 'admin',
    action: 'ایجاد',
    entity: 'دارایی A-0005',
    detail: 'دارایی جدید ثبت شد',
    occurredAt: '2025-08-14'
  }
]
