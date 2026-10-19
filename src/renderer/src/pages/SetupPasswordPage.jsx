import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, Form, Input, Button, Typography, Alert } from 'antd'
import { LockOutlined } from '@ant-design/icons'
import { useAuth } from '../context/AuthContext'

const { Title, Paragraph } = Typography

// First-Run Security phase — shown instead of LoginPage exactly once,
// the very first time the app ever launches (App.jsx routes here based
// on AuthContext's needsSetup, driven by auth:needsFirstRunSetup).
// There is no temporary password anywhere for this screen to display or
// pre-fill — the operator is choosing the Administrator password for
// the first time, not confirming one that was generated for them.
export default function SetupPasswordPage() {
  const navigate = useNavigate()
  const { completeFirstRunSetup } = useAuth()
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleFinish({ password, confirmPassword }) {
    setSubmitting(true)
    setError('')
    const result = await completeFirstRunSetup(password, confirmPassword)
    setSubmitting(false)
    if (result.success) {
      navigate('/')
    } else {
      setError(result.error)
    }
  }

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--awm-ink)'
      }}
    >
      <Card
        className="awm-page-transition"
        style={{ width: 420, boxShadow: 'var(--awm-hero-shadow)' }}
      >
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <img
            src="./branding/sfz-banner.png"
            alt="شرکت صنعت فرابر زرین"
            style={{ width: '100%', maxWidth: 340, height: 'auto', marginBottom: 16, borderRadius: 'var(--awm-radius-sm)' }}
          />
          <Title level={5} style={{ margin: 0 }}>
            راه‌اندازی اولیه — تعیین رمز عبور مدیر سامانه
          </Title>
          <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 13 }}>
            این اولین اجرای برنامه است. پیش از ورود، یک رمز عبور برای حساب مدیر سامانه تعیین کنید.
          </Paragraph>
        </div>
        {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} showIcon />}
        <Form layout="vertical" onFinish={handleFinish}>
          <Form.Item
            name="password"
            label="رمز عبور جدید"
            rules={[
              { required: true, message: 'رمز عبور را وارد کنید' },
              { min: 8, message: 'رمز عبور باید حداقل ۸ کاراکتر باشد' }
            ]}
          >
            <Input.Password prefix={<LockOutlined />} autoFocus />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="تکرار رمز عبور"
            dependencies={['password']}
            rules={[
              { required: true, message: 'تکرار رمز عبور را وارد کنید' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) return Promise.resolve()
                  return Promise.reject(new Error('رمز عبور و تکرار آن یکسان نیستند'))
                }
              })
            ]}
          >
            <Input.Password prefix={<LockOutlined />} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting}>
            تعیین رمز عبور و ورود
          </Button>
        </Form>
      </Card>
    </div>
  )
}
