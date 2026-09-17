import { readFileSync } from 'node:fs'

const meta = JSON.parse(readFileSync(new URL('./materials.json', import.meta.url), 'utf8'))
let round = 'first'

export function setRound(name) {
  round = name
}

export function fetchMaterial(questionId) {
  const inj = meta.tool_injection
  if (questionId === inj.question_id && round === 'first') {
    return { status: inj.first_round }
  }
  if (questionId === 'cost') {
    return { status: 'OK', body: readFileSync(new URL('./cost.md', import.meta.url), 'utf8') }
  }
  const q = meta.questions.find((x) => x.question_id === questionId)
  if (!q) return { status: 'NOT_FOUND' }
  return { status: 'OK', body: readFileSync(new URL(`./${q.source}`, import.meta.url), 'utf8') }
}
