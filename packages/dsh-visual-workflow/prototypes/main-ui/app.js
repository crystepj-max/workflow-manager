const params = new URLSearchParams(location.search)
const mode = params.get('source') === 'current' ? 'current' : params.get('source') === 'previous' ? 'previous' : 'preview'
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
const narrow = params.get('viewport') === 'mobile'
const frame = document.querySelector('#preview')
// 可单独复现“系统偏好”和应用主题不一致；只影响此 iframe，不修改系统设置。
frame.style.colorScheme = params.get('system') === 'light' ? 'light' : params.get('system') === 'dark' ? 'dark' : theme
const buttons = [...document.querySelectorAll('[data-source]')]
const frameParams = new URLSearchParams(params)
frameParams.set('theme', theme)
frameParams.set('source', mode)
frame.src = mode === 'previous'
  ? '/previous?variant=A&surface=settings&view=library&theme=' + theme
  : '/frame?' + frameParams
document.body.dataset.theme = theme
if (narrow) document.body.dataset.viewport = 'mobile'
for (const button of buttons) {
  button.classList.toggle('selected', button.dataset.source === mode)
  button.addEventListener('click', () => {
    params.set('source', button.dataset.source)
    location.search = params
  })
}
document.querySelector('#theme').textContent = theme === 'dark' ? '浅色' : '深色'
document.querySelector('#theme').addEventListener('click', () => {
  params.set('theme', theme === 'dark' ? 'light' : 'dark')
  location.search = params
})
document.querySelector('#viewport').textContent = narrow ? '桌面' : '390 px'
document.querySelector('#viewport').addEventListener('click', () => {
  if (narrow) params.delete('viewport')
  else params.set('viewport', 'mobile')
  location.search = params
})
document.querySelector('#reset').addEventListener('click', () => frame.contentWindow.location.reload())
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow) return
  if (event.data?.type === 'prototype-size') document.querySelector('#size').textContent = event.data.width + ' × ' + event.data.height
})
fetch('/api/sync-status').then((r) => r.json()).then((status) => {
  const label = document.querySelector('#sync')
  label.textContent = !status.inSync ? '正式内容已变更，待复核' : mode === 'current' ? '直接读取正式源码' : mode === 'previous' ? '历史设计参照' : status.previewExact ? '正式界面同源' : '原型含独立改动'
  label.dataset.stale = String(!status.inSync)
  label.title = status.baseline
}).catch(() => { document.querySelector('#sync').textContent = '同步状态不可用' })
