import fs from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

/** Small CDP client for exercising the actual Electron renderer and preload. */
export async function connectRenderer(port, timeout = 20000) {
  const deadline = Date.now() + timeout
  let target
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) break
    } catch {
      /* Electron is still starting. */
    }
    await delay(100)
  }
  if (!target) throw new Error('Electron renderer did not become ready')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  const exceptions = []
  let sequence = 0
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown')
      exceptions.push(message.params.exceptionDetails)
    if (!message.id || !pending.has(message.id)) return
    const { resolve, reject, timer } = pending.get(message.id)
    clearTimeout(timer)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, 20000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result?.value
  }
  async function waitFor(expression, timeoutMs = 15000) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await evaluate(expression)) return
      await delay(60)
    }
    throw new Error(`UI condition timed out: ${expression}`)
  }
  async function click(selector) {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  async function clickText(text) {
    const expression = `Array.from(document.querySelectorAll('button')).find(el => el.textContent.replace(/\\s+/g, '') === ${JSON.stringify(text.replace(/\s+/g, ''))})`
    await waitFor(`!!(${expression})`)
    await evaluate(`(${expression}).click()`)
  }
  async function fill(selector, value) {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`)
    await evaluate(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(String(value))}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); input.blur(); })()`
    )
  }
  async function screenshot(file) {
    await waitFor("!document.querySelector('.n-message')", 10000)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })
    await delay(180)
    await evaluate('document.fonts.ready.then(() => true)')
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(file, Buffer.from(shot.data, 'base64'))
  }
  await send('Runtime.enable')
  await send('Page.enable')
  return {
    send,
    evaluate,
    waitFor,
    click,
    clickText,
    fill,
    screenshot,
    exceptions,
    close() {
      for (const item of pending.values()) {
        clearTimeout(item.timer)
        item.reject(new Error('CDP connection closed'))
      }
      pending.clear()
      socket.close()
    }
  }
}
