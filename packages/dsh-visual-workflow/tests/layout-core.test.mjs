import { test } from 'node:test'
import assert from 'node:assert/strict'
import validatorCore from '../../../scripts/validate-core.cjs'
import { layoutCore } from './helpers/load-client-layout.mjs'

const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
const labelRect = (route) => ({ x: route.labelX - 18, y: route.labelY - 18, w: 36, h: 18 })

const graph = {
  id: 'layout-core-test',
  name: '布局内核测试',
  entry: 'start',
  nodes: [
    { id: 'start', profile: 'dispatcher', label: '开始' },
    { id: 'middle', profile: 'dev', label: '处理中' },
    { id: 'finish', profile: 'review', label: '结束前' },
  ],
  edges: [
    { from: 'start', to: 'middle', on: 'success' },
    { from: 'start', to: 'middle', on: 'success', when: '$.alternate == true' },
    { from: 'middle', to: 'finish', on: 'success' },
    { from: 'start', to: 'finish', on: 'success', when: '$.skip == true' },
    { from: 'finish', to: 'middle', on: 'failure' },
    { from: 'finish', to: '$end', on: 'success' },
  ],
}

test('布局内核：公开接口返回完整路线且不修改输入', () => {
  const input = structuredClone(graph)
  const output = layoutCore.layoutGraph(input)

  assert.deepEqual(input, graph)
  assert.equal(output.pos.start.w, 220)
  assert.equal(output.pos.start.h, 66)
  assert.equal(output.pos.$end.w, 140)
  assert.equal(output.routes.size, graph.edges.length)

  for (const [index, route] of output.routes) {
    assert.equal(typeof route.labelX, 'number', '边 ' + index + ' 必须由布局内核提供标签 X')
    assert.equal(typeof route.labelY, 'number', '边 ' + index + ' 必须由布局内核提供标签 Y')
    assert.ok(Number.isFinite(route.labelX) && Number.isFinite(route.labelY))
  }
})

test('布局内核：节点、标签和路线保持当前几何不变量', () => {
  const output = layoutCore.layoutGraph(graph)
  const positions = Object.values(output.pos)

  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      assert.equal(overlap(positions[i], positions[j]), false, '节点矩形不得重叠')
    }
  }

  const placedLabels = []
  for (const [index, route] of output.routes) {
    const rect = labelRect(route)
    assert.equal(positions.some(node => overlap(rect, node)), false, '边 ' + index + ' 标签不得覆盖节点')
    assert.equal(placedLabels.some(previous => overlap(rect, previous)), false, '边 ' + index + ' 标签不得覆盖已有标签')
    placedLabels.push(rect)
  }

  assert.equal(output.routes.get(3).kind, 'down', '跨节点前向边走下方车道')
  assert.equal(output.routes.get(4).kind, 'up', '回退边走上方车道')
  assert.equal(output.routes.get(5).yEnd, output.pos.$end.y + output.pos.$end.h / 2, '终点边落在终点垂直中心')
  assert.equal(output.routes.get(0).labelY, (output.routes.get(0).yStart + output.routes.get(0).yEnd) / 2, '整体下移后直连标签仍与路线同步')
  assert.notEqual(output.routes.get(0).yStart, undefined)
  assert.notEqual(output.routes.get(0).parallelIndex, output.routes.get(1).parallelIndex, '平行边保持可区分')
})

test('布局内核：入口候选与校验内核在有效图纸上保持一致', () => {
  const nodes = graph.nodes
  const edges = graph.edges
  const expected = validatorCore.deriveEntryCandidates(nodes, edges)
  assert.deepEqual(layoutCore.deriveEntryCandidates(graph), expected)
})

test('布局内核：业务结果边参与主链，带轮次的回退边不拉长层级', () => {
  const dsl = {
    ...graph,
    edges: [
      { from: 'start', to: 'middle', on: 'success' },
      { from: 'middle', to: 'finish', outcome: 'PASS' },
      { from: 'finish', to: 'start', outcome: 'RETRY', countRound: 1 },
      { from: 'finish', to: '$end', on: 'success' },
    ],
  }
  const output = layoutCore.layoutGraph(dsl)

  assert.ok(output.pos.finish.x > output.pos.middle.x, '业务结果边参与从左到右的主链分层')
  assert.equal(output.routes.get(2).kind, 'up', '带轮次的回退边走上方车道')
  assert.deepEqual(layoutCore.deriveEntryCandidates(dsl), ['start'])
})

test('布局内核：自环和未知端点有限返回，额外终点不污染节点顺序', () => {
  const dirty = {
    ...graph,
    edges: [
      ...graph.edges,
      { from: 'middle', to: 'middle', on: 'success' },
      { from: 'unknown', to: 'start', on: 'success' },
    ],
  }
  const started = Date.now()
  const output = layoutCore.layoutGraph(dirty, ['$end', '$end'])

  assert.ok(Date.now() - started < 100, '脏数据布局必须在有限时间内返回')
  assert.equal(Object.keys(output.pos).filter(id => id === '$end').length, 1, '额外终点必须去重')
  assert.deepEqual(Array.from(output.order.keys()), ['start', 'middle', 'finish'])
  assert.equal(output.routes.has(7), false, '未知来源边不产生路线')
  assert.equal(output.routes.has(6), true, '自环仍保留可渲染路线')
})
