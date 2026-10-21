import { createMockHost } from './mock-host.js'

export async function mountPreview(React, createRoot, clientFactory) {
  const params = new URLSearchParams(location.search)
  const dark = params.get('theme') === 'dark'
  if (dark) document.body.setAttribute('data-ds-dark-theme', '')
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  const reportSize = () => parent.postMessage({ type: 'prototype-size', width: innerWidth, height: innerHeight }, location.origin)
  addEventListener('resize', reportSize)
  reportSize()
  const settings = document.querySelector('.host-settings')
  const mask = document.querySelector('.host-mask')
  const setOpen = (open) => { settings.hidden = !open; mask.hidden = !open }
  document.querySelector('.host-settings-close').addEventListener('click', () => setOpen(false))
  document.querySelector('.host-show-settings').addEventListener('click', () => setOpen(true))
  try {
    const response = await fetch('/api/seed')
    if (!response.ok) throw new Error('原型样例加载失败')
    const seed = await response.json()
    const host = createMockHost(seed)
    const styles = { insert(css) {
      const tag = document.createElement('style')
      tag.dataset.source = 'workflow-client'
      tag.textContent = css
      document.head.append(tag)
      return () => tag.remove()
    } }
    let Component
    const slots = {
      inject: (_slot, register) => register(),
      register: (_meta, component) => { Component = component; return () => {} },
    }
    const ctx = {
      get: (key) => key === 'slots' ? slots : key === 'locale' ? { getSnapshot: () => ({ active: 'zh' }) } : undefined,
      timeout: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id) },
      interval: (fn, ms) => { const id = setInterval(fn, ms); return () => clearInterval(id) },
    }
    clientFactory(React, host, styles).apply(ctx)
    if (!Component) throw new Error('工作流设置页没有注册')
    createRoot(document.querySelector('#plugin-root')).render(React.createElement(Component))
    const view = params.get('view')
    const workflow = params.get('workflow')
    if (view === 'roles' || view === 'runs' || view === 'editor') {
      const observer = new MutationObserver(() => {
        if (!document.querySelector('.vwf-list-item')) return
        if (view === 'editor') {
          const row = [...document.querySelectorAll('.vwf-list-item')].find((el) => el.textContent.includes(workflow || 'wf-diagnose'))
          const button = row?.querySelector('button')
          if (!button) return
          observer.disconnect(); button.click()
        } else {
          const button = document.querySelector('[data-vwf-nav="' + (view === 'runs' ? 'dashboard' : 'roles') + '"]')
          if (!button) return
          observer.disconnect(); button.click()
        }
      })
      observer.observe(document.querySelector('#plugin-root'), { subtree: true, childList: true })
    }
  } catch (error) {
    const el = document.querySelector('#plugin-root')
    el.className = 'host-boot-error'
    el.textContent = '原型加载失败：' + error.message
    console.error(error)
  }
}
