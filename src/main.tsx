import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Keep startup subscriptions single-run in development. Voice capture starts
// only from the manual Talk control.
createRoot(document.getElementById('root')!).render(<App />)
