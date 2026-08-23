const AWARD_TITLES = [
  'Живчик',
  'Кремень',
  'Безумный Шляпник',
  'Снайпер Неудач',
  'Законы Физики? Не Слышал',
  'Гений Абсурда',
  'Абсолютный Выживатель',
  'Грация Кирпича',
  'Мастер Кармы',
  'Магнит для Неприятностей',
  'Пофигист Года',
  'Короткое Замыкание',
  'Фатальный Оптимист',
  'Драма Квин',
  'Тактика Динозавра',
  'Жертва Науки',
  'Ходячая Обуза',
  'Мастер Саботажа',
  'Везунчик из Сказки',
  'Главный Фарш',
  'Выкарабкался из Ада',
  'Быстрые Ноги',
  'Хладнокровный Тактик',
  'Ангел-Хранитель',
  'Аптечка на Ножках',
  'Непробиваемый',
  'Бессмертный Барон',
  'Макгайвер',
  'Мягкая Посадка',
  'Ящерица',
  'Тушитель Катастроф',
  'Последняя Свеча',
  'На Грани Фола',
  'Легенда Выживача',
  'Заклинатель Змей',
  'Актер Без Оскара',
  'Погребенный Заживо',
  'Гений Интуиции',
  'Громоотвод',
  'Сытый и Целый',
  'Ходячий Танк',
  'Компас Судьбы',
  'Ледяные Жилы',
  'Дипломат Хаоса'
]

function shuffleArray(array) {
  const shuffled = [...array]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    ;[shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]]
  }
  return shuffled
}

function fallbackAwards(history, selectedTitles) {
  const survival = { player1: 0, player2: 0 }
  const damage = { player1: 0, player2: 0 }

  history.forEach((round) => {
    const verdict = round.verdict || round.aiVerdict || {}
    survival.player1 += (round.player1?.statusAfter || verdict.player1Status) === 'ALIVE' ? 1 : 0
    survival.player2 += (round.player2?.statusAfter || verdict.player2Status) === 'ALIVE' ? 1 : 0
    damage.player1 += verdict.player1Damage || 0
    damage.player2 += verdict.player2Damage || 0
  })

  const mainWinner = survival.player1 === survival.player2 ? 'both' : survival.player1 > survival.player2 ? 'player1' : 'player2'
  const damageWinner = damage.player1 >= damage.player2 ? 'player1' : 'player2'
  const firstStory = history[0]?.verdict?.story || history[0]?.aiVerdict?.story || 'История первого раунда была зафиксирована системой.'

  return {
    awards: selectedTitles.map((title, index) => ({
      id: index + 1,
      title,
      winner: title === 'Магнит для Неприятностей' || title === 'Главный Фарш' ? damageWinner : index % 3 === 0 ? mainWinner : 'both',
      reason: `По данным истории матча: ${firstStory.slice(0, 120)}`
    }))
  }
}

export async function generateMatchAwards(matchHistory) {
  const selectedTitles = shuffleArray(AWARD_TITLES).slice(0, 8)
  return fallbackAwards(matchHistory, selectedTitles)
}
