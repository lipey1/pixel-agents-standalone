import { useEffect, useState } from 'react'
import type { Notice } from '../hooks/useExtensionMessages.js'

interface NoticeToastProps {
  notices: Notice[]
}

const COLORS: Record<Notice['level'], { border: string; background: string; dot: string }> = {
  info: { border: '#5a8cff', background: 'rgba(20, 28, 50, 0.95)', dot: '#5a8cff' },
  warn: { border: '#d0a33a', background: 'rgba(48, 38, 16, 0.95)', dot: '#d0a33a' },
  error: { border: '#d05a5a', background: 'rgba(52, 20, 20, 0.95)', dot: '#d05a5a' },
}

export function NoticeToast({ notices }: NoticeToastProps) {
  const [visible, setVisible] = useState<Notice[]>([])

  useEffect(() => {
    if (notices.length === 0) return
    setVisible(notices.slice(-3))
    const timer = setTimeout(() => setVisible([]), 7000)
    return () => clearTimeout(timer)
  }, [notices])

  if (visible.length === 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        maxWidth: '80%',
      }}
    >
      {visible.map((notice) => {
        const colors = COLORS[notice.level] ?? COLORS.info
        return (
          <button
            key={notice.id}
            onClick={() => setVisible((prev) => prev.filter((n) => n.id !== notice.id))}
            title="Click to close"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              fontSize: '20px',
              textAlign: 'left',
              color: 'var(--pixel-text, #e8e8f0)',
              background: colors.background,
              border: `2px solid ${colors.border}`,
              borderRadius: 0,
              boxShadow: 'var(--pixel-shadow)',
              cursor: 'pointer',
              whiteSpace: 'normal',
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors.dot, flexShrink: 0 }} />
            {notice.message}
          </button>
        )
      })}
    </div>
  )
}
