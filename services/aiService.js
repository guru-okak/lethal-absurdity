import { generateMatchAwards } from './awardsService'

let lastAiProvider = 'Тестовая заглушка'

function createFallbackVerdict() {
  return {
    story: 'Это тестовая заглушка ведущего для вёрстки. Здесь появится полноценный рассказ AI после подключения защищённого серверного API.',
    player1: { hpChange: -10, sanityChange: 0, status: 'ALIVE' },
    player2: { hpChange: -10, sanityChange: 0, status: 'ALIVE' },
    player1Status: 'ALIVE',
    player2Status: 'ALIVE',
    player1Damage: 10,
    player2Damage: 10
  }
}

export function getLastAiProvider() {
  return lastAiProvider
}

export { generateMatchAwards }

export async function generateRoundVerdict() {
  lastAiProvider = 'Тестовая заглушка'
  return createFallbackVerdict()
}
