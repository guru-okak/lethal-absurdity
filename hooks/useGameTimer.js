import { useEffect, useState } from 'react'

export function useGameTimer(deadline, onExpire) {
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))

  useEffect(() => {
    if (!deadline) return undefined
    const interval = window.setInterval(() => {
      const next = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      setRemaining(next)
      if (next === 0) {
        window.clearInterval(interval)
        onExpire?.()
      }
    }, 250)
    return () => window.clearInterval(interval)
  }, [deadline, onExpire])

  return remaining
}
