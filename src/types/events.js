export const MUTATORS = [
  {
    key: 'apocalypse',
    name: 'Апокалипсис',
    icon: '☣️',
    description: 'Выжить в пять раз сложнее, урон удваивается, любая ошибка может стать фатальной.'
  },
  {
    key: 'truce',
    name: 'Перемирие',
    icon: '🕊',
    description: 'Чистый кооператив: игроки не вредят друг другу даже случайно.'
  },
  {
    key: 'russian_roulette',
    name: 'Русская Рулетка',
    icon: '🎯',
    description: 'Один игрок гарантированно выживает, второй гарантированно погибает; проигрывает менее логичное действие.'
  },
  {
    key: 'mental_storm',
    name: 'Ментальный Шторм',
    icon: '🧠',
    description: 'Урон по Рассудку удваивается, атмосфера становится сюрреалистичным кошмаром.'
  },
  {
    key: 'mirror_world',
    name: 'Зеркальный Мир',
    icon: '🪞',
    description: 'Глупые и безумные действия работают идеально, логичные приводят к фейлу.'
  },
  {
    key: 'grace',
    name: 'Благодать',
    icon: '🎁',
    description: 'Раунд-отдушина: минимальный урон, возможны восстановление Здоровья и Рассудка.'
  },
  {
    key: 'absurd_mode',
    name: 'Режим Абсурда',
    icon: '🤡',
    description: 'Оцениваются юмор и бредовость; серьёзные действия гарантированно проваливаются.'
  },
  {
    key: 'chain_reaction',
    name: 'Цепная Реакция',
    icon: '🌊',
    description: 'Действие Игрока 1 напрямую задаёт физические условия для Игрока 2.'
  },
  {
    key: 'silent_movie',
    name: 'Немое Кино',
    icon: '🔇',
    description: 'Без озвучки: только текстовая драма в стиле нуара и старого кинематографа.'
  },
  {
    key: 'trouble_magnet',
    name: 'Магнит для Неприятностей',
    icon: '🧲',
    description: 'Мелкие катастрофы окружающей среды одновременно преследуют обоих игроков.'
  },
  {
    key: 'switcheroo',
    name: 'Обмен Телами',
    icon: '🔄',
    description: 'Перед оценкой AI игроки получают действия друг друга: Игрок 1 выполняет ход Игрока 2, а Игрок 2 — ход Игрока 1.'
  },
  {
    key: 'butterfly_effect',
    name: 'Эффект Бабочки',
    icon: '⏱',
    description: 'Действие каждого игрока ограничено двадцатью символами, включая пробелы.'
  },
  {
    key: 'd20_mode',
    name: 'Критический Успех / Провал',
    icon: '🎲',
    description: 'Каждому игроку выпадает число от 1 до 20: единица означает фатальный провал, двадцатка — грандиозный успех.'
  },
  {
    key: 'forbidden_letter',
    name: 'Запретная Буква',
    icon: '🔤',
    description: 'В начале раунда выбирается запрещённая буква. Каждое её употребление в действии отнимает Рассудок.'
  },
  {
    key: 'neuro_link',
    name: 'Нейро-Связь',
    icon: '🧠⚡',
    description: 'Потеря HP зеркально уменьшает Рассудок, а потеря Рассудка зеркально уменьшает HP.'
  },
  {
    key: 'all_in',
    name: 'Ва-Банк',
    icon: '🔋',
    description: 'Любое физическое ранение, даже самое мелкое, превращается в урон от 70 до 100 HP.'
  },
  {
    key: 'live_typing',
    name: 'Громкий Рупор',
    icon: '📢',
    description: 'Игроки видят черновик действия напарника в реальном времени.'
  },
  {
    key: 'shared_pain',
    name: 'Зеркальная Бронха',
    icon: '🪞',
    description: 'Любая потеря HP или Рассудка одним игроком в том же объёме наносится второму.'
  },
  {
    key: 'escort_mission',
    name: 'VIP-Защита',
    icon: '👑',
    description: 'Один игрок становится VIP: его смерть мгновенно завершает миссию для обоих.'
  },
  {
    key: 'dark_streak',
    name: 'Тёмная Полоса',
    icon: '🌑',
    description: 'Полный результат раунда скрывается до Хроники Матча, а игра сразу продолжается.'
  },
  {
    key: 'synchronous_link',
    name: 'Синхронная Связка',
    icon: '🔗',
    description: 'Слаженная команда получает 0 урона, а эгоистичные или мешающие действия дают обоим -50 HP.'
  }
]

export function getRandomMutator({ chance = 50, disabledKeys = [] } = {}) {
  if (Math.random() * 100 >= chance) return null
  const availableMutators = MUTATORS.filter((mutator) => !disabledKeys.includes(mutator.key))
  if (!availableMutators.length) return null
  return availableMutators[Math.floor(Math.random() * availableMutators.length)]
}
