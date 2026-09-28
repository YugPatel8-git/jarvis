import { spawn } from 'node:child_process'

/** Stop only this owned process tree, including Windows command wrappers. */
export function stopProcessTree(child) {
  if (process.platform !== 'win32' || !child.pid) { child.kill('SIGTERM'); return Promise.resolve() }
  return new Promise((resolve) => {
    const killer = spawn(process.env.SystemRoot + '\\System32\\taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', shell: false })
    let finished = false
    const finish = (code) => {
      if (finished) return
      finished = true; clearTimeout(timer)
      if (code !== 0) { try { child.kill('SIGTERM') } catch {} }
      // Descendants can inherit pipe handles; they must not retain this caller.
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy()
      child.unref?.()
      resolve()
    }
    const timer = setTimeout(() => { killer.kill(); finish(null) }, 5000)
    killer.once('error', () => finish(null))
    killer.once('close', finish)
  })
}
