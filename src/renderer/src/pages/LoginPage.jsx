import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, Form, Input, Button, Typography, Alert } from 'antd'
import { UserOutlined, LockOutlined } from '@ant-design/icons'
import { useAuth } from '../context/AuthContext'

const { Title } = Typography

export default function LoginPage() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleFinish({ username, password }) {
    setSubmitting(true)
    setError('')
    const result = await login(username, password)
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
            سامانه مدیریت دارایی و انبار
          </Title>
        </div>
        {error && (
          <Alert type="error" message={error} style={{ marginBottom: 16 }} showIcon />
        )}
        <Form layout="vertical" onFinish={handleFinish}>
          <Form.Item
            name="username"
            label="نام کاربری"
            rules={[{ required: true, message: 'نام کاربری را وارد کنید' }]}
          >
            <Input prefix={<UserOutlined />} autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label="رمز عبور"
            rules={[{ required: true, message: 'رمز عبور را وارد کنید' }]}
          >
            <Input.Password prefix={<LockOutlined />} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting}>
            ورود
          </Button>
        </Form>
      </Card>
    </div>
  )
}
