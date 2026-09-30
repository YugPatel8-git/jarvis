import { useEffect, useRef } from 'react'
import { hands } from '../lib/hands'

export function Pointer() {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const update = () => {
      root.current?.querySelectorAll<HTMLElement>('.hand-pointer').forEach((el, i) => {
        const hand = hands[i]
        el.hidden = !hand
        if (!hand) return
        el.style.transform = `translate(${hand.x}px, ${hand.y}px)`
        el.dataset.pinched = String(hand.pinched)
      })
    }
    update()
    const timer = window.setInterval(update, 33)
    return () => window.clearInterval(timer)
  }, [])
  return <div ref={root} aria-hidden="true"><span className="hand-pointer" hidden /><span className="hand-pointer" hidden /></div>
}
