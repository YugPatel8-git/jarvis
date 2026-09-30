import { useStore } from '../store'
import { BRIDGE_HTTP_URL } from '../config'

function source(raw: string) {
  const path = raw.replace(/^file:\/\//, '')
  if (/^\/(Users|home|root|Volumes|Applications|System|Library|private|tmp|var|opt|mnt|media|srv|data)\//.test(path)) return `${BRIDGE_HTTP_URL}/file?path=${encodeURIComponent(path)}`
  if (/^https?:/i.test(raw) && !raw.startsWith(`${BRIDGE_HTTP_URL}/`)) return `${BRIDGE_HTTP_URL}/img?url=${encodeURIComponent(raw)}`
  return raw
}

export function ImageShelf() {
  const images = useStore((s) => s.ui.orbits)
  if (!images.length) return null
  return <div className="image-shelf" aria-label="Shared images">{images.map((image) => <img key={image.id} src={source(image.src)} alt={image.id} />)}</div>
}
