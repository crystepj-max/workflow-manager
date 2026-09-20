#!/usr/bin/env node
/**
 * 登记册 `remote` 字段 → 远端锚点列表（唯一真源）。
 *
 * 历史取值形态不一（CHORE-111 §11 实测 8 条不规范取值）：
 *   `cnb#106`、`github#215`、双锚点 `cnb#111 + github#215`、空格式 `GitHub #208`。
 * 只认一种形态会让另一侧 issue 静默常开（收口）或漏掉标签（批量任务源）。
 *
 * 本模块从 local-task-merge 抽出，供收口链路与 issue 通道链路共用；
 * local-task-merge 以 re-export 保留既有公开 API，调用方无需改动。
 */

/**
 * @returns {{ system: string, issue: number }[]} 无锚点取值（pending / none）返回空数组
 */
export function parseRemoteAnchors(remote) {
  const anchors = []
  for (const token of String(remote ?? '').split(/[+,;&]+/)) {
    const m = /^\s*([a-z]{2,})\s*#\s*(\d+)\s*$/i.exec(token)
    if (!m) continue
    const anchor = { system: m[1].toLowerCase(), issue: Number(m[2]) }
    if (!anchors.some((x) => x.system === anchor.system && x.issue === anchor.issue)) anchors.push(anchor)
  }
  return anchors
}

/**
 * 取 GitHub 锚点号（主源）。双锚点取值只认 github 一侧——CNB 是灾备镜像，不承载施工认领。
 * @returns {number|null}
 */
export function githubAnchorOf(remote) {
  const hit = parseRemoteAnchors(remote).find((a) => a.system === 'github')
  return hit ? hit.issue : null
}
