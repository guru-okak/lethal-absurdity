import { useCallback, useEffect, useState } from 'react'

export function useTypingEffect(text = '', speed = 35) {
  const [visibleText, setVisibleText] = useState('')
  const [isComplete, setIsComplete] = useState(false)

  useEffect(() => {
    let index = 0
    setVisibleText('')
    setIsComplete(!text)
    if (!text) return undefined

    const interval = window.setInterval(() => {
      index += 1
      setVisibleText(text.slice(0, index))
      if (index >= text.length) {
        window.clearInterval(interval)
        setIsComplete(true)
      }
    }, speed)

    return () => window.clearInterval(interval)
  }, [text, speed])

  const revealAll = useCallback(() => {
    setVisibleText(text)
    setIsComplete(true)
  }, [text])

  return { visibleText, isComplete, revealAll }
}
