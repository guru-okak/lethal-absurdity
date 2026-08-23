import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, ArrowRight, BookMarked, BookOpen, Brain, CalendarDays, Check, Clipboard, Clock3, Crown, Gamepad2, Globe2, Heart, LogIn, MessageCircle, Plus, Settings, Shield, Sparkles, UserRound, Users } from 'lucide-react'
import { useGameTimer } from './hooks/useGameTimer'
import { useWebSpeech } from './hooks/useWebSpeech'
import { useTypingEffect } from './hooks/useTypingEffect'
import { generateMatchAwards, generateRoundVerdict, getLastAiProvider } from './services/aiService'
import { formatRoomCode, generateRoomCode } from './lib/utils'
import { getRandomMutator, MUTATORS } from './types/events'

const ROOM_STORAGE_KEY = 'lethal-absurdity-room'
const TOTAL_ROUNDS = 3
const DEFAULT_LOBBY_SETTINGS = { totalRounds: 3, turnTimer: 45, mutatorChance: 50, disabledMutators: [], awardInterval: 5, ttsRate: 1.25, hostStyle: 'black_humor', blindMode: false }
const DEFAULT_PROFILE = { nickname: '', avatar: '🦝' }
const TIMEOUT_ACTION = 'Игрок ничего не делает и просто стоит на месте'
const FORBIDDEN_LETTERS = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'
const BUTTERFLY_ACTION_LIMIT = 20
const RANDOM_MUTATOR = 'random'
const NO_MUTATOR = 'none'

function createRoundMutatorPlan(totalRounds, existingPlan = []) {
  return Array.from({ length: totalRounds }, (_, index) => existingPlan[index] || RANDOM_MUTATOR)
}

function createRoundMutator(mutator) {
  if (!mutator) return null
  if (mutator.key === 'd20_mode') return { ...mutator, rolls: { creator: 1 + Math.floor(Math.random() * 20), waiting: 1 + Math.floor(Math.random() * 20) } }
  if (mutator.key === 'forbidden_letter') return { ...mutator, forbiddenLetter: FORBIDDEN_LETTERS[Math.floor(Math.random() * FORBIDDEN_LETTERS.length)] }
  if (mutator.key === 'escort_mission') return { ...mutator, vipRole: Math.random() < 0.5 ? 'creator' : 'waiting' }
  return mutator
}

function getLobbySettings(settings) {
  const awardInterval = [5, 8, 12, 'click'].includes(settings?.awardInterval) ? settings.awardInterval : DEFAULT_LOBBY_SETTINGS.awardInterval
  return { ...DEFAULT_LOBBY_SETTINGS, ...(settings || {}), awardInterval, roundMutators: createRoundMutatorPlan(settings?.totalRounds || DEFAULT_LOBBY_SETTINGS.totalRounds, settings?.roundMutators), disabledMutators: settings?.disabledMutators || DEFAULT_LOBBY_SETTINGS.disabledMutators }
}

function getProfile(room, role) {
  return room?.profiles?.[role] || { ...DEFAULT_PROFILE, nickname: role === 'creator' ? 'Игрок 1' : 'Игрок 2' }
}

function getScenarioChooser(room) {
  return (room?.currentRound || 1) % 2 === 1 ? 'creator' : 'waiting'
}

function displayName(room, role) {
  return getProfile(room, role).nickname || (role === 'creator' ? 'Игрок 1' : 'Игрок 2')
}

function formatMatchDate(timestamp) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(timestamp))
}

function formatMatchDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

function getGameModeLabel(gameMode) {
  return gameMode === 'coop_survival' ? 'КООПЕРАТИВНЫЙ ХАОС' : gameMode || 'КООПЕРАТИВНЫЙ ХАОС'
}

function getHistoryMutatorIcon(mutator) {
  if (mutator?.icon) return mutator.icon
  return { 'Без события': '🎲', 'Чёрный юмор': '🃏', 'Полный абсурд': '🤡' }[mutator?.name] || '⚡'
}

const EMERGENCY_VERDICT = { story: 'Из-за помех в связи ведущий ответил мгновенным автоматическим вердиктом: физика сработала непредсказуемо, но оба участника выжили!', player1: { hpChange: -10, sanityChange: 0, status: 'ALIVE' }, player2: { hpChange: -10, sanityChange: 0, status: 'ALIVE' }, player1Status: 'ALIVE', player2Status: 'ALIVE', player1Damage: 10, player2Damage: 10 }
const INITIAL_PLAYER_STATE = { hp: 100, sanity: 100, status: 'ALIVE' }

function applyPlayerState(previousState, result) {
  const hp = Math.max(0, Math.min(100, previousState.hp + (result?.hpChange || 0)))
  const status = previousState.status === 'DEAD' || hp === 0 || result?.status === 'DEAD' ? 'DEAD' : 'ALIVE'
  if (status === 'DEAD') return { hp: 0, sanity: 0, status }
  const sanity = Math.max(0, Math.min(100, previousState.sanity + (result?.sanityChange || 0)))
  return { hp, sanity, status }
}

function applyMutatorEffects(verdict, mutator) {
  if (mutator?.key === 'all_in') {
    const convertWound = (result) => result?.hpChange < 0 ? { ...result, hpChange: Math.min(-70, result.hpChange) } : result
    const player1 = convertWound(verdict.player1)
    const player2 = convertWound(verdict.player2)
    return { ...verdict, player1, player2, player1Damage: Math.max(0, -player1.hpChange), player2Damage: Math.max(0, -player2.hpChange) }
  }
  if (mutator?.key === 'shared_pain') {
    const player1HpLoss = Math.max(0, -(verdict.player1?.hpChange || 0))
    const player2HpLoss = Math.max(0, -(verdict.player2?.hpChange || 0))
    const player1SanityLoss = Math.max(0, -(verdict.player1?.sanityChange || 0))
    const player2SanityLoss = Math.max(0, -(verdict.player2?.sanityChange || 0))
    const player1 = { ...verdict.player1, hpChange: (verdict.player1?.hpChange || 0) - player2HpLoss, sanityChange: (verdict.player1?.sanityChange || 0) - player2SanityLoss }
    const player2 = { ...verdict.player2, hpChange: (verdict.player2?.hpChange || 0) - player1HpLoss, sanityChange: (verdict.player2?.sanityChange || 0) - player1SanityLoss }
    return { ...verdict, player1, player2, player1Damage: Math.max(0, -player1.hpChange), player2Damage: Math.max(0, -player2.hpChange) }
  }
  if (mutator?.key !== 'neuro_link') return verdict
  const mirror = (result) => {
    const hpLoss = Math.max(0, -(result?.hpChange || 0))
    const sanityLoss = Math.max(0, -(result?.sanityChange || 0))
    return {
      ...result,
      hpChange: (result?.hpChange || 0) - sanityLoss,
      sanityChange: (result?.sanityChange || 0) - hpLoss
    }
  }
  const player1 = mirror(verdict.player1)
  const player2 = mirror(verdict.player2)
  return { ...verdict, player1, player2, player1Damage: Math.max(0, -player1.hpChange), player2Damage: Math.max(0, -player2.hpChange) }
}

function readRoom() {
  try {
    return JSON.parse(localStorage.getItem(ROOM_STORAGE_KEY) || 'null')
  } catch {
    return null
  }
}

function getAverageVitals(history, playerKey, fallbackState) {
  let hp = 100
  let sanity = 100
  const rounds = (history || []).map((round) => {
    const state = round[playerKey]
    if (Number.isFinite(state?.hpAfter) && Number.isFinite(state?.sanityAfter)) {
      hp = state.hpAfter
      sanity = state.sanityAfter
    } else {
      const verdictKey = playerKey === 'player1' ? 'player1Damage' : 'player2Damage'
      const result = round.verdict?.[playerKey]
      hp = Math.max(0, hp + (result?.hpChange ?? -(round.verdict?.[verdictKey] || 0)))
      sanity = Math.max(0, Math.min(100, sanity + (result?.sanityChange || 0)))
    }
    return { hp, sanity }
  })
  if (!rounds.length) return { hp: fallbackState.hp, sanity: fallbackState.sanity }
  return {
    hp: Math.round(rounds.reduce((total, state) => total + state.hp, 0) / rounds.length),
    sanity: Math.round(rounds.reduce((total, state) => total + state.sanity, 0) / rounds.length)
  }
}

function createHistoryEntry(room, verdict, player1State, player2State) {
  return {
    roundNumber: room.currentRound || 1,
    situation: room.situation,
    mutator: room.mutator || null,
    player1Action: room.actions?.creator || '',
    player2Action: room.actions?.waiting || '',
    verdict: { ...verdict, player1Damage: verdict.player1Damage || 0, player2Damage: verdict.player2Damage || 0 },
    player1: { ...verdict.player1, hpAfter: player1State.hp, sanityAfter: player1State.sanity, statusAfter: player1State.status },
    player2: { ...verdict.player2, hpAfter: player2State.hp, sanityAfter: player2State.sanity, statusAfter: player2State.status }
  }
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Use the legacy fallback below when Clipboard API is unavailable or blocked.
  }

  const helper = document.createElement('textarea')
  helper.value = text
  helper.setAttribute('readonly', '')
  helper.style.position = 'fixed'
  helper.style.opacity = '0'
  document.body.appendChild(helper)
  helper.select()
  const copied = document.execCommand('copy')
  document.body.removeChild(helper)
  if (!copied) throw new Error('Не удалось скопировать код')
}

function App() {
  const [screen, setScreen] = useState('lobby')
  const [role, setRole] = useState(null)
  const [roomCode, setRoomCode] = useState('')
  const [profile, setProfile] = useState(DEFAULT_PROFILE)
  const [lobbySettings, setLobbySettings] = useState(() => getLobbySettings(DEFAULT_LOBBY_SETTINGS))
  const [selectedMode, setSelectedMode] = useState(null)
  const [room, setRoom] = useState(null)
  const [notice, setNotice] = useState('')
  const [situationDraft, setSituationDraft] = useState('')
  const [actionDraft, setActionDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const verdictRequestStarted = useRef(false)
  const awardsRequestStarted = useRef(false)
  const sessionRestoreReady = useRef(false)
  const { speak, stop, isSpeaking } = useWebSpeech()

  useEffect(() => {
    try {
      const savedSession = JSON.parse(sessionStorage.getItem('lethal-absurdity-session') || 'null')
      const savedRoom = readRoom()
      if (savedSession && savedRoom && savedRoom.code === savedSession.code && savedRoom.profiles?.[savedSession.role]) {
        setRoom(savedRoom)
        setRole(savedSession.role)
        setRoomCode(savedRoom.code)
        setProfile(savedRoom.profiles[savedSession.role])
        setScreen(savedSession.screen || (savedRoom.phase === 'waiting' ? 'room' : 'lobby'))
      }
    } catch {
      sessionStorage.removeItem('lethal-absurdity-session')
    } finally {
      sessionRestoreReady.current = true
    }
  }, [])

  useEffect(() => {
    if (!sessionRestoreReady.current) return
    if (!role || !room?.code) {
      sessionStorage.removeItem('lethal-absurdity-session')
      return
    }
    sessionStorage.setItem('lethal-absurdity-session', JSON.stringify({ code: room.code, role, screen, profile }))
  }, [role, room?.code, screen, profile])

  useEffect(() => {
    if (room?.phase !== 'action_reveal') verdictRequestStarted.current = false
  }, [room?.phase])

  useEffect(() => {
    if (room?.phase === 'actions') setActionDraft('')
  }, [room?.phase])

  useEffect(() => {
    if (room?.phase !== 'reveal' || !room.verdict?.story || room.mutator?.key === 'silent_movie') return undefined
    speak(room.verdict.story, 'ru-RU', room.settings?.ttsRate || DEFAULT_LOBBY_SETTINGS.ttsRate)
    return stop
  }, [room?.phase, room?.verdict?.story, speak, stop])

  useEffect(() => {
    if (!room || room.phase !== 'reveal' || role !== 'creator') return
    if (!room.nextReady?.creator || !room.nextReady?.waiting) return
    stop()
    const nextRoundNumber = (room.currentRound || 1) + 1
    if (nextRoundNumber <= (room.totalRounds || DEFAULT_LOBBY_SETTINGS.totalRounds)) {
      saveRoom({ ...room, currentRound: nextRoundNumber, phase: 'situation', situation: '', mutator: null, actions: {}, verdict: null, verdictError: null, actionDeadline: null, aiProvider: null, player1State: INITIAL_PLAYER_STATE, player2State: INITIAL_PLAYER_STATE, nextReady: { creator: false, waiting: false }, actionRevealReady: { creator: false, waiting: false }, lastEvent: { type: 'NEXT_ROUND', round: nextRoundNumber } })
      setSituationDraft('')
      setActionDraft('')
      setScreen('round')
    } else {
      saveRoom({ ...room, status: 'finished', phase: 'history', matchCompletedAt: Date.now(), verdict: null, actionDeadline: null, nextReady: { creator: false, waiting: false }, lastEvent: { type: 'MATCH_HISTORY_READY' } })
      setScreen('history')
    }
  }, [room, role])

  useEffect(() => {
    const syncRoom = () => {
      const nextRoom = readRoom()
      if (!nextRoom || !room || nextRoom.code !== room.code) return
      setRoom(nextRoom)
      if (['final', 'awards_processing', 'awards'].includes(nextRoom.phase)) setScreen('final')
      else if (nextRoom.phase === 'history') setScreen('history')
      else if (nextRoom.phase === 'waiting') setScreen('room')
      else if (nextRoom.status === 'playing') setScreen('round')
    }
    window.addEventListener('storage', syncRoom)
    const interval = window.setInterval(syncRoom, 800)
    return () => {
      window.removeEventListener('storage', syncRoom)
      window.clearInterval(interval)
    }
  }, [room])

  const saveRoom = (nextRoom) => {
    localStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify(nextRoom))
    setRoom(nextRoom)
  }

  useEffect(() => {
    if (!room || room.phase !== 'action_reveal' || room.verdict || role !== 'creator' || verdictRequestStarted.current) return undefined
    verdictRequestStarted.current = true
    setIsLoading(true)

    const resolveRound = async () => {
      try {
        const switcheroo = room.mutator?.key === 'switcheroo'
        const verdict = applyMutatorEffects(await generateRoundVerdict({
          situation: room.situation,
          player1Action: switcheroo ? room.actions?.waiting : room.actions?.creator,
          player2Action: switcheroo ? room.actions?.creator : room.actions?.waiting,
          player1State: room.player1State || INITIAL_PLAYER_STATE,
          player2State: room.player2State || INITIAL_PLAYER_STATE,
          player1Name: displayName(room, 'creator'),
          player2Name: displayName(room, 'waiting'),
          mutator: room.mutator,
          forbiddenLetter: room.mutator?.forbiddenLetter,
          rolls: room.mutator?.rolls,
          vipRole: room.mutator?.vipRole,
          settings: getLobbySettings(room.settings)
        }), room.mutator)
        let player1State = applyPlayerState(room.player1State || INITIAL_PLAYER_STATE, verdict.player1)
        let player2State = applyPlayerState(room.player2State || INITIAL_PLAYER_STATE, verdict.player2)
        if (room.mutator?.key === 'escort_mission' && (room.mutator.vipRole === 'creator' ? player1State.status : player2State.status) === 'DEAD') {
          player1State = { hp: 0, sanity: 0, status: 'DEAD' }
          player2State = { hp: 0, sanity: 0, status: 'DEAD' }
        }
        const resolvedVerdict = { ...verdict, player1: { ...verdict.player1, status: player1State.status }, player2: { ...verdict.player2, status: player2State.status }, player1Status: player1State.status, player2Status: player2State.status }
        const matchHistory = [...(room.matchHistory || []), createHistoryEntry(room, resolvedVerdict, player1State, player2State)]
        saveRoom({ ...room, phase: 'action_reveal', verdict: resolvedVerdict, player1State, player2State, aiProvider: getLastAiProvider(), matchHistory })
      } catch (error) {
        saveRoom({ ...room, phase: 'action_reveal', verdict: null, aiError: { code: error.code || 'AI_REQUEST_ERROR', message: error.message, status: error.status || null, networkStatus: error.networkStatus || null, rawText: error.rawText || '', cause: error.cause || '' } })
      } finally {
        setIsLoading(false)
      }
    }

    resolveRound()
  }, [room, role])

  useEffect(() => {
    if (room?.phase !== 'awards_processing') awardsRequestStarted.current = false
  }, [room?.phase])

  useEffect(() => {
    if (!room || room.phase !== 'awards_processing' || role !== 'creator' || awardsRequestStarted.current) return undefined
    awardsRequestStarted.current = true
    generateMatchAwards(room.matchHistory || []).then((awards) => {
      saveRoom({ ...room, phase: 'awards', awards })
      setScreen('final')
    }).catch(() => {
      saveRoom({ ...room, phase: 'awards', awards: null })
      setScreen('final')
    })
  }, [room, role])

  const createRoom = () => {
    if (!selectedMode) {
      setNotice('Выберите режим игры перед созданием комнаты.')
      return
    }
    const settings = getLobbySettings(lobbySettings)
    const nextRoom = { code: generateRoomCode(), players: 1, status: 'waiting', phase: 'waiting', currentRound: 1, totalRounds: settings.totalRounds, gameMode: selectedMode, createdAt: Date.now(), settings, matchConfig: { roundMutators: settings.roundMutators, gameMode: selectedMode }, situation: '', mutator: null, actions: {}, draftActions: {}, verdict: null, verdictError: null, aiError: null, aiProvider: null, matchHistory: [], awards: null, actionDeadline: null, matchStartedAt: null, matchCompletedAt: null, player1State: INITIAL_PLAYER_STATE, player2State: INITIAL_PLAYER_STATE, ready: { creator: false, waiting: false }, nextReady: { creator: false, waiting: false }, actionRevealReady: { creator: false, waiting: false }, lastEvent: { type: 'ROOM_CREATED' }, hostRole: 'creator', profiles: { creator: { ...DEFAULT_PROFILE, ...profile, nickname: profile.nickname.trim() || 'Игрок 1' } } }
    saveRoom(nextRoom)
    setRole('creator')
    setScreen('room')
    setNotice('Комната создана. Передайте код второму игроку.')
  }

  const joinRoom = () => {
    const code = formatRoomCode(roomCode)
    const existingRoom = readRoom()
    if (code.length !== 6) {
      setNotice('Введите шестизначный код комнаты.')
      return
    }
    if (!existingRoom || existingRoom.code !== code) {
      setNotice('Комната не найдена. Проверьте код и попробуйте снова.')
      return
    }
    const existingProfiles = existingRoom.profiles || {}
    const joinRole = existingProfiles.creator ? 'waiting' : 'creator'
    if (existingProfiles.creator && existingProfiles.waiting) {
      setNotice('Комната уже заполнена. Дождитесь освобождения места.')
      return
    }
    const nextProfiles = { ...existingProfiles, [joinRole]: { ...DEFAULT_PROFILE, ...profile, nickname: profile.nickname.trim() || (joinRole === 'creator' ? 'Игрок 1' : 'Игрок 2') } }
    const nextRoom = { ...existingRoom, players: Object.keys(nextProfiles).length, profiles: nextProfiles, hostRole: existingRoom.hostRole || joinRole, phase: 'waiting', status: 'waiting', ready: { creator: false, waiting: false } }
    saveRoom(nextRoom)
    setRole(joinRole)
    setScreen('room')
    setNotice(joinRole === 'creator' ? 'Вы вернулись в комнату как хост.' : 'Игрок 2 подключился.')
  }

  const copyCode = async () => {
    try {
      await copyText(room.code)
      setCopied(true)
      setNotice('Код скопирован в буфер обмена.')
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setNotice('Не удалось скопировать код. Выделите его и скопируйте вручную.')
    }
  }

  const setReady = () => {
    const currentRoom = readRoom()
    if (!currentRoom || currentRoom.players < 2 || !role || currentRoom.phase !== 'waiting') return
    saveRoom({ ...currentRoom, ready: { ...(currentRoom.ready || {}), [role]: !currentRoom.ready?.[role] } })
  }

  const updateLobbySettings = (settings) => {
    if (!room || role !== 'creator' || room.phase !== 'waiting') return
    const roundMutators = createRoundMutatorPlan(settings.totalRounds, settings.roundMutators)
    saveRoom({ ...room, settings: { ...settings, roundMutators }, matchConfig: { ...(room.matchConfig || {}), roundMutators }, totalRounds: settings.totalRounds })
  }

  const startGame = () => {
    if (!room || role !== 'creator' || room.phase !== 'waiting' || room.players < 2 || !room.ready?.creator || !room.ready?.waiting) return
    const settings = getLobbySettings(room.settings)
    saveRoom({ ...room, status: 'playing', phase: 'situation', currentRound: 1, totalRounds: settings.totalRounds, matchStartedAt: Date.now(), matchCompletedAt: null, matchConfig: { ...(room.matchConfig || {}), roundMutators: createRoundMutatorPlan(settings.totalRounds, settings.roundMutators) }, situation: '', mutator: null, actions: {}, matchHistory: [], awards: null, actionDeadline: null, player1State: INITIAL_PLAYER_STATE, player2State: INITIAL_PLAYER_STATE, ready: { creator: false, waiting: false }, actionRevealReady: { creator: false, waiting: false } })
    setScreen('round')
  }

  const openAwards = () => {
    if (!room || role !== 'creator' || room.phase !== 'history') return
    saveRoom({ ...room, phase: 'awards_processing' })
    setScreen('final')
  }

  const playAgain = () => {
    if (!room || !role || !['final', 'awards', 'awards_processing'].includes(room.phase)) return
    stop()
    saveRoom({
      ...room,
      status: 'waiting',
      phase: 'waiting',
      currentRound: 1,
      totalRounds: getLobbySettings(room.settings).totalRounds,
      mutator: null,
      situation: '',
      actions: {},
      draftActions: {},
      verdict: null,
      verdictError: null,
      aiError: null,
      aiProvider: null,
      matchHistory: [],
      awards: null,
      actionDeadline: null,
      player1State: INITIAL_PLAYER_STATE,
      player2State: INITIAL_PLAYER_STATE,
      ready: { creator: false, waiting: false },
      nextReady: { creator: false, waiting: false },
      actionRevealReady: { creator: false, waiting: false },
      lastEvent: { type: 'RETURNED_TO_LOBBY' }
    })
    setSituationDraft('')
    setActionDraft('')
    setScreen('room')
  }

  const startHistoryTest = () => {
    if (!room) return
    const profiles = {
      creator: room.profiles?.creator || { ...DEFAULT_PROFILE, nickname: 'Игрок 1' },
      waiting: room.profiles?.waiting || { ...DEFAULT_PROFILE, nickname: 'Игрок 2', avatar: '🐸' }
    }
    const matchHistory = [
      {
        roundNumber: 1,
        situation: 'Вы застряли в музее, где экспонаты просыпаются ночью.',
        mutator: { name: 'Без события' },
        player1Action: 'Поднимаюсь на крышу музея и ищу источник странного света.',
        player2Action: 'Прячусь за витриной и договариваюсь с ожившим манекеном.',
        verdict: {
          story: 'Старый музейный маяк вспыхнул над крышей. Первый игрок нашёл безопасный путь, а второй уговорил манекена открыть запасной выход. Ночная экспозиция всё-таки проводила вас до двери зловещими аплодисментами.',
          player1: { hpChange: -10, sanityChange: -20, status: 'ALIVE' },
          player2: { hpChange: -30, sanityChange: -35, status: 'ALIVE' }
        },
        player1: { hpAfter: 90, sanityAfter: 80, statusAfter: 'ALIVE' },
        player2: { hpAfter: 70, sanityAfter: 65, statusAfter: 'ALIVE' }
      },
      {
        roundNumber: 2,
        situation: 'Лифт застрял между этажами, а из вентиляции доносится хор.',
        mutator: { name: 'Чёрный юмор' },
        player1Action: 'Вскрываю панель управления и перезапускаю лифт через аварийный режим.',
        player2Action: 'Начинаю подпевать хору и открываю вентиляционную решётку.',
        verdict: {
          story: 'Аварийный режим поднял лифт на один этаж, но хор оказался коллективом призрачных техников. Первый игрок выскочил в коридор с остатками достоинства, а второго затянуло в вентиляцию под овации потусторонней публики.',
          player1: { hpChange: -35, sanityChange: -35, status: 'ALIVE' },
          player2: { hpChange: -70, sanityChange: -65, status: 'DEAD' }
        },
        player1: { hpAfter: 55, sanityAfter: 45, statusAfter: 'ALIVE' },
        player2: { hpAfter: 0, sanityAfter: 0, statusAfter: 'DEAD' }
      },
      {
        roundNumber: 3,
        situation: 'На площади появляется гигантская утка и требует немедленных переговоров.',
        mutator: { name: 'Полный абсурд' },
        player1Action: 'Предлагаю утке мирный договор и торжественно вручаю ей последний бутерброд.',
        player2Action: 'Запускаю сирену и пытаюсь отвлечь утку фейерверком.',
        verdict: {
          story: 'Утка подписала договор, но потребовала оплату за каждую букву. Бутерброд спас первого игрока от немедленной расправы, хотя переговоры оставили глубокие шрамы на рассудке. Фейерверк разбудил пустой костюм второго игрока, и площадь окончательно признала его павшим героем.',
          player1: { hpChange: -35, sanityChange: -30, status: 'ALIVE' },
          player2: { hpChange: 0, sanityChange: 0, status: 'DEAD' }
        },
        player1: { hpAfter: 20, sanityAfter: 15, statusAfter: 'ALIVE' },
        player2: { hpAfter: 0, sanityAfter: 0, statusAfter: 'DEAD' }
      }
    ]
    const testRoom = {
      ...room,
      players: 2,
      status: 'finished',
      phase: 'history',
      currentRound: 3,
      totalRounds: 3,
      gameMode: 'coop_survival',
      createdAt: Date.now() - 1122 * 1000,
      matchStartedAt: Date.now() - 1122 * 1000,
      matchCompletedAt: Date.now(),
      profiles,
      matchHistory,
      player1State: { hp: 20, sanity: 15, status: 'ALIVE' },
      player2State: { hp: 0, sanity: 0, status: 'DEAD' },
      verdict: null,
      awards: null,
      aiProvider: 'Тестовая заглушка',
      nextReady: { creator: false, waiting: false },
      actionRevealReady: { creator: false, waiting: false },
      actionDeadline: null,
      lastEvent: { type: 'HISTORY_TEST_STARTED' }
    }
    saveRoom(testRoom)
    setScreen('history')
  }

  const confirmNextRound = () => {
    if (!room || !role || room.phase !== 'reveal' || room.nextReady?.[role]) return
    saveRoom({ ...room, nextReady: { ...(room.nextReady || {}), [role]: true } })
  }

  const confirmActionReveal = () => {
    if (!room || !role || room.phase !== 'action_reveal' || !room.verdict || room.actionRevealReady?.[role]) return
    const actionRevealReady = { ...(room.actionRevealReady || {}), [role]: true }
    saveRoom({ ...room, actionRevealReady, phase: actionRevealReady.creator && actionRevealReady.waiting ? 'reveal' : 'action_reveal' })
  }

  const retryAiGeneration = () => {
    if (!room || role !== 'creator' || room.phase !== 'action_reveal') return
    verdictRequestStarted.current = false
    saveRoom({ ...room, verdict: null, aiError: null, actionRevealReady: { creator: false, waiting: false } })
  }

  const updateActionDraft = (value) => {
    setActionDraft(value)
    if (room?.phase === 'actions' && ['live_typing', 'synchronous_link'].includes(room.mutator?.key)) saveRoom({ ...room, draftActions: { ...(room.draftActions || {}), [role]: value } })
  }

  const submitSituation = () => {
    if (!room || role !== getScenarioChooser(room) || !situationDraft.trim()) return
    const settings = getLobbySettings(room.settings)
    const roundChoice = room.matchConfig?.roundMutators?.[room.currentRound - 1] || settings.roundMutators?.[room.currentRound - 1] || RANDOM_MUTATOR
    const selectedMutator = roundChoice === NO_MUTATOR ? null : roundChoice === RANDOM_MUTATOR ? getRandomMutator({ chance: settings.mutatorChance, disabledKeys: settings.disabledMutators }) : MUTATORS.find((mutator) => mutator.key === roundChoice)
    saveRoom({ ...room, phase: 'actions', situation: situationDraft.trim(), mutator: createRoundMutator(selectedMutator), actions: {}, draftActions: {}, actionDeadline: settings.turnTimer ? Date.now() + settings.turnTimer * 1000 : null })
  }

  const submitAction = (value = actionDraft) => {
    if (!room || room.phase !== 'actions' || room.actions?.[role]) return
    const input = typeof value === 'string' ? value : actionDraft
    const maxLength = room.mutator?.key === 'butterfly_effect' ? BUTTERFLY_ACTION_LIMIT : 120
    if (value !== TIMEOUT_ACTION && input.length > maxLength) return
    const action = input.trim() || TIMEOUT_ACTION
    const actions = { ...room.actions, [role]: action }
    saveRoom({ ...room, actions, draftActions: { ...(room.draftActions || {}), [role]: '' }, phase: actions.creator && actions.waiting ? 'action_reveal' : 'actions', actionRevealReady: { creator: false, waiting: false }, lastEvent: input.trim() ? null : { type: 'ACTION_TIMEOUT', role } })
  }

  const withdrawAction = () => {
    if (!room || room.phase !== 'actions' || !room.actions?.[role]) return
    const actions = { ...(room.actions || {}) }
    const previousAction = actions[role]
    delete actions[role]
    saveRoom({ ...room, actions, phase: 'actions', actionRevealReady: { creator: false, waiting: false }, lastEvent: { type: 'ACTION_WITHDRAWN', role } })
    setActionDraft(previousAction === TIMEOUT_ACTION ? '' : previousAction)
  }

  const leaveRoom = () => {
    stop()
    const currentRoom = readRoom()
    if (currentRoom && role) {
      const nextProfiles = { ...(currentRoom.profiles || {}) }
      delete nextProfiles[role]
      const remainingRole = nextProfiles.creator ? 'creator' : nextProfiles.waiting ? 'waiting' : null
      const nextRoom = { ...currentRoom, players: Object.keys(nextProfiles).length, profiles: nextProfiles, hostRole: remainingRole, phase: 'waiting', status: 'waiting', currentRound: 1, ready: { creator: false, waiting: false }, nextReady: { creator: false, waiting: false }, actionRevealReady: { creator: false, waiting: false }, lastEvent: { type: 'PLAYER_LEFT', role } }
      saveRoom(nextRoom)
    }
    setRoom(null)
    setRole(null)
    setProfile(DEFAULT_PROFILE)
    setRoomCode('')
    setNotice('')
    setScreen('lobby')
  }

  if (screen === 'room' && room) return <RoomScreen room={room} role={role} copied={copied} notice={notice} onCopy={copyCode} onReady={setReady} onStartGame={startGame} onSettingsChange={updateLobbySettings} onTestHistory={startHistoryTest} onBack={leaveRoom} />
  if (screen === 'history' && room) return <MatchHistoryScreen room={room} role={role} onAwards={openAwards} onBack={leaveRoom} />
  if (screen === 'final' && room) return <FinalScreen room={room} onBack={leaveRoom} onPlayAgain={playAgain} />
  if (screen === 'round' && room) return <RoundScreen room={room} role={role} situationDraft={situationDraft} actionDraft={actionDraft} onSituation={setSituationDraft} onAction={updateActionDraft} onSubmitSituation={submitSituation} onSubmitAction={submitAction} onWithdrawAction={withdrawAction} onTimeout={() => submitAction(TIMEOUT_ACTION)} onActionRevealContinue={confirmActionReveal} onRetryAiGeneration={retryAiGeneration} onNextRound={confirmNextRound} isSpeaking={isSpeaking} onBack={() => setScreen('room')} />

  return <LobbyScreen profile={profile} onProfile={setProfile} roomCode={roomCode} notice={notice} onRoomCode={setRoomCode} onCreate={createRoom} onJoin={joinRoom} settings={lobbySettings} onSettingsChange={setLobbySettings} selectedMode={selectedMode} onSelectMode={setSelectedMode} />
}

function SiteHeader() {
  return <header className="lobby-header"><style>{`
    .site-header-guide { transition: color .3s ease, border-color .3s ease, transform .2s ease; }
    .site-header-guide:hover { border-color: rgba(204,255,0,.6); color: #ccff00; }
    .site-header-guide svg { transition: color .3s ease; }
    .site-header-guide:hover svg { color: #ccff00; }
    .site-header-guide:active { transform: scale(.95); }
    .site-header-icon { color: #a1a1aa; filter: none; transition: color .3s ease, filter .3s ease, transform .2s ease; }
    .site-header-icon:hover { color: #ccff00; filter: drop-shadow(0 0 8px rgba(204,255,0,.5)); }
    .site-header-icon:active { transform: scale(.9); }
    @media (max-width: 640px) { .lobby-header { padding: 12px 16px; } .lobby-header .system-brand { font-size: 11px; } .site-header-guide { font-size: 0; gap: 0; padding: 9px; } .site-header-guide svg { height: 18px; width: 18px; } .lobby-nav { gap: 10px; } }
    @media (max-width: 399px) { .lobby-header .system-brand { display: none !important; } .lobby-header .lobby-nav { justify-content: space-between; width: 100%; } }
  `}</style><div className="system-brand hidden min-[400px]:flex items-center gap-3"><span>AI HOST SYSTEM</span><small>v1.0.0</small></div><nav className="lobby-nav flex items-center justify-between min-[400px]:justify-end gap-4 w-full min-[400px]:w-auto"><button className="guide-button site-header-guide transition-colors duration-300 active:scale-95" type="button"><BookMarked size={18} strokeWidth={1.8} /> КАК ИГРАТЬ</button><button className="icon-button site-header-icon text-zinc-400 transition-colors duration-300 active:scale-90" type="button" aria-label="Игроки"><Users size={15} /><i /></button><button className="icon-button site-header-icon text-zinc-400 transition-colors duration-300 active:scale-90" type="button" aria-label="Настройки"><Settings size={15} /></button></nav></header>
}

function SiteFooter() {
  return <footer className="lobby-footer site-footer"><style>{`
    .site-footer { align-items: center; animation: lobby-footer-enter .8s ease-out .6s both; border-top: 0 !important; color: rgba(240,238,232,.74); display: flex; flex-direction: row; font: 15px/1 ui-monospace, SFMono-Regular, monospace; gap: 16px; justify-content: space-between; margin: 0 auto; max-width: 1500px; padding: 24px 48px; position: relative; width: 100%; }
    .site-footer::before { background: #ef4444; border-radius: 999px; content: ''; height: 2px; left: 0; position: absolute; right: 0; top: 0; }
    .site-footer-copy { align-items: center; display: flex; gap: 8px; white-space: nowrap; }
    .site-footer-links { align-items: center; display: flex; gap: 24px; white-space: nowrap; }
    .site-footer-links a { color: #a1a1aa; font: inherit; letter-spacing: inherit; text-decoration: none; transition: color .3s ease, filter .3s ease; }
    .site-footer-links a:hover { color: #ef4444 !important; filter: drop-shadow(0 0 6px rgba(239,68,68,.5)); }
    .site-footer-links > span { color: inherit; }
    .site-footer-icons { align-items: center; display: flex; gap: 24px; }
    .site-footer-icons button { background: transparent; border: 0; color: #a1a1aa !important; padding: 0; transition: color .2s ease, filter .2s ease, transform .2s ease; }
    .site-footer-icons button:hover { color: #ef4444 !important; filter: drop-shadow(0 0 8px rgba(239,68,68,.6)); transform: none; }
    .site-footer-icons button:active { transform: scale(.95); }
    .site-footer-icons svg { height: 24px; width: 24px; }
    @media (max-width: 640px) { .site-footer { align-items: center; flex-direction: column; gap: 16px; justify-content: center; padding: 20px 16px; text-align: center; } .site-footer-links { order: 1; } .site-footer-icons { order: 2; } .site-footer-copy { order: 3; } }
  `}</style><div className="site-footer-copy"><span>© 2026 СМЕРТЕЛЬНЫЙ АБСУРД</span></div><div className="site-footer-links"><a href="#">Правила игры</a><span>|</span><a href="#">Поддержка</a></div><div className="site-footer-icons"><button type="button" aria-label="Discord"><MessageCircle size={14} /></button><button type="button" aria-label="Сайт"><Globe2 size={14} /></button><button type="button" aria-label="Другие сервисы"><Settings size={14} /></button></div></footer>
}

function LobbyScreen({ profile, onProfile, roomCode, notice, onRoomCode, onCreate, onJoin, settings, onSettingsChange, selectedMode, onSelectMode }) {
  return <main className="lobby-shell"><style>{`@media (max-width: 899px) { .lobby-shell .host-status-card { display: none; } .lobby-shell .lobby-hero { justify-content: flex-start; } } @media (max-width: 650px) { .lobby-shell .lobby-hero-copy h1 { font-size: clamp(2.25rem, 10vw, 4.5rem); max-width: none; overflow-wrap: normal; white-space: nowrap; } } @media (max-width: 599px) { .lobby-shell .ecg-line { display: none; } }`}</style><div className="lobby-container"><SiteHeader /><section className="lobby-hero"><div className="lobby-hero-copy"><p className="lobby-kicker"><span /> ТЕКСТОВЫЙ AI-ВЫЖИВАЧ</p><h1>Смертельный<br /><em>Абсурд</em></h1><div className="ecg-line" aria-hidden="true"><span /></div><p className="lobby-tagline hidden min-[600px]:block">AI ВЕДЁТ. ВЫ ПИШЕТЕ. ВЫЖИВАЕТЕ, ЕСЛИ СМОЖЕТЕ.</p></div><article className="host-status-card"><p>AI-ВЕДУЩИЙ</p><h2>Я наблюдаю.</h2><span>Ваши слова формируют историю.<br />Каждое решение имеет цену.</span><strong>Готовы узнать свою?</strong><div className="signal-status"><span className="signal-dots" /><div className="signal-wave" aria-hidden="true"><i /><i /><i /><i /><i /></div><b>СИГНАЛ СТАБИЛЕН</b><span className="signal-dots" /></div></article></section><LobbyControlGrid profile={profile} onProfile={onProfile} roomCode={roomCode} notice={notice} onRoomCode={onRoomCode} onCreate={onCreate} onJoin={onJoin} settings={settings} onSettingsChange={onSettingsChange} selectedMode={selectedMode} onSelectMode={onSelectMode} /><section className="lobby-placeholder-grid" aria-label="Настройки лобби будут добавлены на следующем этапе"><div className="lobby-placeholder"><span>01</span><strong>ВАШ ПРОФИЛЬ</strong><small>Профиль игрока и выбор аватара</small></div><div className="lobby-placeholder"><span>02</span><strong>СОЗДАТЬ / ВОЙТИ</strong><small>Создание комнаты и код подключения</small></div><div className="lobby-placeholder"><span>03</span><strong>ИНСТРУМЕНТЫ ХОСТА</strong><small>Раунды и планировщик мутаторов</small></div></section><SiteFooter /></div></main>
}

function LobbyControlGrid({ profile, onProfile, roomCode, notice, onRoomCode, onCreate, onJoin, settings, onSettingsChange, selectedMode, onSelectMode }) {
  const lobbySettings = getLobbySettings(settings)
  const updateSettings = (key, value) => onSettingsChange?.(getLobbySettings({ ...lobbySettings, [key]: value }))
  const updateRoundMutator = (index, value) => updateSettings('roundMutators', lobbySettings.roundMutators.map((mutator, itemIndex) => itemIndex === index ? value : mutator))

  return <section className="lobby-control-grid" aria-label="Управление лобби">
    <section className="lobby-control-card lobby-profile-card">
      <div className="lobby-card-heading"><div><span>ВАШ ПРОФИЛЬ</span></div></div>
      <div className="lobby-profile-columns">
        <label className="lobby-field">НИКНЕЙМ<div className="lobby-input-wrap"><input maxLength={16} value={profile.nickname} onChange={(event) => onProfile({ ...profile, nickname: event.target.value })} placeholder="Введите никнейм" /><small>{profile.nickname.length} / 16</small></div></label>
        <div className="lobby-field">АВАТАР<div className="lobby-avatar-row">{AVATAR_OPTIONS.slice(0, 6).map((avatar) => <button key={avatar} type="button" className={`lobby-avatar-option ${profile.avatar === avatar ? 'is-selected' : ''}`} onClick={() => onProfile({ ...profile, avatar })} aria-label={`Выбрать аватар ${avatar}`}>{avatar}</button>)}<button className="lobby-avatar-option lobby-avatar-option--add" type="button" aria-label="Добавить аватар">+</button></div></div>
      </div>
    </section>

    <section className="lobby-control-card lobby-create-card">
      <div><h2><Sparkles size={16} /> СОЗДАТЬ КОМНАТУ</h2><p>Вы станете хостом комнаты и сможете настроить раунды и мутаторы.</p></div>
      <button className={`lobby-create-button ${selectedMode ? 'is-enabled' : 'is-disabled'}`} type="button" disabled={!selectedMode} onClick={onCreate}>СОЗДАТЬ КОМНАТУ <ArrowRight size={17} /></button><small className="lobby-create-hint">{selectedMode ? 'Режим выбран — можно создавать комнату.' : '* Выберите режим игры справа, чтобы создать комнату'}</small>
    </section>

    <section className="lobby-control-card lobby-join-card">
      <div><h2><Users size={16} /> ВОЙТИ В КОМНАТУ</h2><p>Введите код комнаты, чтобы присоединиться к игре.</p></div>
      <div className="lobby-code-entry"><input maxLength={6} value={roomCode} onChange={(event) => onRoomCode(event.target.value.toUpperCase())} placeholder="X7K9M2" aria-label="Код комнаты" /><button type="button" onClick={() => onRoomCode('')} aria-label="Очистить код">×</button></div>
      <button className="lobby-join-button" type="button" onClick={onJoin}>ВОЙТИ В ИГРУ <ArrowRight size={17} /></button>
      <small>{notice || 'Введите шестизначный код комнаты.'}</small>
    </section>

    <section className="lobby-control-card lobby-mode-card">
      <div className="lobby-mode-heading"><div><h2><Gamepad2 size={16} /> ВЫБОР РЕЖИМА ИГРЫ</h2><p>Выберите формат испытания перед созданием комнаты.</p></div></div>
      <div className="lobby-mode-options" role="radiogroup" aria-label="Режим игры">
        <button type="button" role="radio" aria-checked={selectedMode === 'coop_survival'} className={`lobby-mode-option lobby-mode-option--coop ${selectedMode === 'coop_survival' ? 'is-selected' : ''}`} onClick={() => onSelectMode('coop_survival')}><div className="lobby-mode-option-top"><strong>🤝 КООПЕРАТИВНЫЙ ХАОС</strong><span>PVE<br />2 ИГРОКА</span></div><p>Вы придумываете действия, а ИИ сплетает их в единый сюжет. Кооперируйтесь, чтобы выжить под давлением мутаторов.</p></button>
        <button type="button" role="radio" aria-checked={false} aria-disabled="true" title="Режим временно недоступен. Ведутся технические работы." className="lobby-mode-option lobby-mode-option--pvp lobby-mode-option--disabled"><div className="lobby-mode-option-top"><strong>⚔️ СМЕРТЕЛЬНАЯ ДУЭЛЬ</strong><span>PVP<br />2 ИГРОКА</span></div><b className="lobby-mode-coming-soon">В РАЗРАБОТКЕ</b><p>Прямое противостояние игроков. ИИ выступает в роли беспристрастного судьи и описывает последствия ваших столкновений.</p></button>
      </div>
      <div className="lobby-mode-info"><span></span><p>Режим определяет правила взаимодействия игроков и тональность решений ведущего.</p></div>
    </section>
  </section>
}

const AVATAR_OPTIONS = ['🦝', '🐸', '🦊', '🐙', '🦇', '🐲', '🤖', '👽']

function ProfileEditor({ profile, onChange }) {
  return <div className="profile-editor"><div><span className="section-kicker">Ваш профиль</span><h2>Кто входит в хаос?</h2></div><div className="profile-editor-row"><div className="profile-avatar-preview">{profile.avatar}</div><label className="profile-name-field">Никнейм<input maxLength={24} value={profile.nickname} onChange={(event) => onChange({ ...profile, nickname: event.target.value })} placeholder="Введите имя" /></label></div><div className="avatar-picker" aria-label="Выберите аватарку">{AVATAR_OPTIONS.map((avatar) => <button key={avatar} type="button" className={`avatar-option ${profile.avatar === avatar ? 'avatar-option--selected' : ''}`} onClick={() => onChange({ ...profile, avatar })} aria-label={`Аватар ${avatar}`}>{avatar}</button>)}</div></div>
}

function Rule({ number, icon, title, text }) { return <div className="rule-item"><span className="rule-number">{number}</span>{icon}<div><strong>{title}</strong><span>{text}</span></div></div> }

function ScreenFrame({ children, eyebrow, title, onBack }) {
  const isRoomFrame = title === 'Соберите свою КАТАСТРОФУ'
  const isActionRevealFrame = title === 'Ваши действия'
  const isVerdictFrame = title === 'Решение ведущего'
  const isHistoryFrame = title === 'Хроника Матча'
  const isAwardsFrame = title === 'Церемония награждения'
  return <main className={`app-shell ${isRoomFrame ? 'room-waiting-shell' : ''} ${isActionRevealFrame ? 'action-reveal-shell' : ''} ${isVerdictFrame ? 'verdict-reveal-shell' : ''} ${isHistoryFrame ? 'match-history-shell' : ''} ${isAwardsFrame ? 'awards-ceremony-shell' : ''}`}><SiteHeader /><style>{`.app-shell .topbar { display: none !important; } .action-reveal-shell { background: url('../ui/bg/bg-lethal_v3.png') center / cover no-repeat fixed; box-sizing: border-box; display: flex; flex-direction: column; min-height: 100vh; overflow-x: hidden; padding: 24px 48px; } .action-reveal-shell .site-footer { box-sizing: border-box; flex-shrink: 0; } @keyframes action-reveal-heading-from-top { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } } @keyframes action-reveal-heading-title { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: scale(1); } } .action-reveal-shell .screen-heading { margin: 58px auto 28px; max-width: 1280px; text-align: left; width: 100%; } .action-reveal-shell .screen-heading .eyebrow { align-items: center; animation: action-reveal-heading-from-top .5s ease .1s both; color: #ef4444 !important; display: flex; font: 700 14px/1.3 ui-monospace, SFMono-Regular, monospace; gap: 12px; justify-content: flex-start; letter-spacing: .12em; opacity: 0; text-transform: uppercase; } .action-reveal-shell .screen-heading .eyebrow::before, .action-reveal-shell .screen-heading .eyebrow::after { background: #ef4444 !important; box-shadow: none; content: ''; display: block !important; flex: 0 0 48px; height: 1px; opacity: 1; width: 48px; } .action-reveal-shell .screen-heading .eyebrow span { display: none; } .action-reveal-shell .screen-heading h1 { animation: action-reveal-heading-title .5s ease .2s both; color: #f4f4f5; font: 400 clamp(60px, 8vw, 96px)/.96 Georgia, serif; letter-spacing: normal; margin: 24px 0 12px; opacity: 0; } .action-reveal-shell .back-button { display: none; } @media (max-width: 1023px) { .action-reveal-shell { padding: 24px; } } @media (max-width: 767px) { .action-reveal-shell { padding: 16px; } .action-reveal-shell .screen-heading { margin-top: 16px; } .action-reveal-shell .screen-heading h1 { font-size: 36px; } .action-reveal-shell .site-footer { align-items: center; flex-direction: column; gap: 16px; justify-content: center; padding: 20px 16px; text-align: center; } .action-reveal-shell .site-footer-links { order: 1; } .action-reveal-shell .site-footer-icons { order: 2; } .action-reveal-shell .site-footer-copy { order: 3; } } @keyframes lineExpand { from { opacity: 0; transform: scaleX(0); } to { opacity: 1; transform: scaleX(1); } } @media (max-width: 469px) { .room-waiting-shell .room-code-display { font-size: clamp(1.25rem, 8vw, 2.5rem); letter-spacing: .08em; white-space: nowrap; } .room-waiting-shell .room-action-buttons { gap: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 0 8px; } .room-waiting-shell .room-action-buttons .room-button { font-size: clamp(10px, 2.5vw, 12px); letter-spacing: .04em; line-height: 1.15; min-width: 0; padding: 10px 8px; white-space: normal; overflow-wrap: anywhere; } } @media (max-width: 359px) { .room-waiting-shell .room-action-buttons { grid-template-columns: 1fr; } } @media (max-width: 469px) { .room-waiting-shell .mutator-options { display: grid; grid-template-columns: 1fr; gap: 12px; width: 100%; } .room-waiting-shell .mutator-options label { align-items: center; display: flex; gap: 10px; min-width: 0; padding: 8px; width: 100%; } .room-waiting-shell .mutator-options label span { min-width: 0; overflow-wrap: anywhere; white-space: normal; } } .room-waiting-shell .screen-heading h1::after { display: none; } @media (max-width: 999px) { .room-waiting-shell .screen-heading h1 { font-size: clamp(1.875rem, 7vw, 3.75rem); margin-left: 0; margin-right: 0; max-width: 100%; overflow-wrap: anywhere; white-space: normal; } }`}</style><div className="ambient-glow ambient-glow--top" /><div className="ambient-glow ambient-glow--bottom" />{isRoomFrame ? <SiteHeader /> : <header className="topbar"><button className="back-button" onClick={onBack}><ArrowLeft size={15} /> Назад</button><div className="brand-lockup"><span className="brand-mark"><Sparkles size={16} /></span><span>LA / 001</span></div><span className="topbar-status"><span className="status-dot" /> Система готова</span></header>}{isRoomFrame && <button className="room-back-button room-back-stagger transition-all duration-500 delay-75 animate-in fade-in slide-in-from-left-2 fill-mode-forwards" onClick={onBack}><ArrowLeft size={15} /> НАЗАД В ЛОББИ</button>}<section className={`screen-heading ${isRoomFrame ? 'room-stagger-heading w-full flex flex-col items-center justify-center text-center my-6 px-4' : ''}`}>{isRoomFrame ? <div className="w-full flex flex-col items-center justify-center text-center my-6 px-4"><div className="flex items-center gap-3 mb-2"><span className="w-12 sm:w-16 md:w-20 h-[2px] bg-red-600/60 animate-line-left" /><span className="font-mono text-sm sm:text-base md:text-lg font-semibold tracking-[0.2em] text-red-500 uppercase room-eyebrow-label">{eyebrow}</span><span className="w-12 sm:w-16 md:w-20 h-[2px] bg-red-600/60 animate-line-right" /></div><div className="inline-flex flex-col items-center w-fit max-w-full"><h1 className="room-stagger-title text-3xl sm:text-5xl md:text-6xl lg:text-7xl font-serif leading-tight tracking-tight break-words">КОМНАТА СОЗДАНА<span className="text-red-500 italic font-bold"></span></h1><div className="hidden min-[1000px]:block w-full h-[3px] bg-red-600 rounded-full shadow-[0_0_10px_rgba(239,68,68,0.7)] mt-4 origin-center" style={{ animation: 'lineExpand 0.8s ease-out forwards' }} /></div></div> : <><p className="eyebrow"><span /> {eyebrow}</p><h1>{title}</h1></>}</section>{children}<SiteFooter /></main>
}

function RoomScreen({ room, role, copied, notice, onCopy, onReady, onStartGame, onSettingsChange, onTestHistory, onBack }) {
  const isReady = room.players === 2
  const isHost = role === (room.hostRole || 'creator')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const playerReady = Boolean(room.ready?.[role])
  const opponentRole = role === 'creator' ? 'waiting' : 'creator'
  const opponentReady = Boolean(room.ready?.[opponentRole])

  return <ScreenFrame eyebrow="Настройки комнаты" title="Соберите свою КАТАСТРОФУ" onBack={onBack}>
    <section className="room-card room-stagger-card">
      <div className="room-code-label room-stagger-code-label">Код вашей комнаты</div>
      <div className="room-code-display room-stagger-code text-2xl sm:text-4xl md:text-5xl font-mono font-bold tracking-normal sm:tracking-[0.4em] whitespace-nowrap text-red-500 drop-shadow-[0_0_12px_rgba(239,68,68,0.6)]">{room.code.split('').join(' ')}</div>
      <button className="copy-code-button room-stagger-copy" onClick={onCopy}>{copied ? <Check size={17} /> : <Clipboard size={17} />} {copied ? 'Скопировано' : 'Скопировать код'}</button>
      <div className={`connection-status room-stagger-connection ${isReady ? 'connection-status--ready' : ''}`}><span className="connection-pulse" /><div><strong>{isReady ? 'Игрок 2 подключился' : 'Ожидание второго игрока...'}</strong><span>{isReady ? 'Комната готова начать первый раунд.' : 'Откройте игру на втором устройстве и введите код.'}</span></div></div>
      <div className="room-players"><div className="room-stagger-player room-stagger-player--left"><PlayerSlot number="01" profile={getProfile(room, 'creator')} isYou={Boolean(room.profiles?.creator) && role === 'creator'} isHost={Boolean(room.profiles?.creator) && room.hostRole === 'creator'} connected={Boolean(room.profiles?.creator)} subtitle="Выбирает ситуацию в нечётных раундах" /></div><div className="room-stagger-player room-stagger-player--right"><PlayerSlot number="02" profile={getProfile(room, 'waiting')} isYou={Boolean(room.profiles?.waiting) && role === 'waiting'} isHost={Boolean(room.profiles?.waiting) && room.hostRole === 'waiting'} connected={Boolean(room.profiles?.waiting)} subtitle={room.profiles?.waiting ? 'Выбирает ситуацию в чётных раундах' : 'Свободное место'} /></div></div>
      <div className="readiness-status room-stagger-readiness"><span className={`readiness-player-status ${room.ready?.creator ? 'is-ready' : 'is-not-ready'}`}>{displayName(room, 'creator')}: {room.ready?.creator ? 'ГОТОВ' : 'НЕ ГОТОВ'}</span><span className={`readiness-player-status ${room.ready?.waiting ? 'is-ready' : 'is-not-ready'}`}>{displayName(room, 'waiting')}: {room.ready?.waiting ? 'ГОТОВ' : 'НЕ ГОТОВ'}</span></div>
      <div className="room-action-buttons room-stagger-actions">
        {isHost ? <button className="secondary-button room-button room-button--settings" type="button" onClick={() => setSettingsOpen((value) => !value)}>НАСТРОЙКИ КОМНАТЫ</button> : <div className="room-button room-button--settings room-button--readonly">ПРОСМОТР НАСТРОЕК</div>}
        <button className="secondary-button room-button room-button--ceremony" type="button" onClick={onTestHistory}>ТЕСТ ХРОНИКИ</button>
        <button className={`secondary-button room-button room-button--ready readiness-toggle-button ${playerReady ? 'is-ready' : ''}`} type="button" disabled={!isReady} onClick={onReady}>{playerReady ? 'НЕ ГОТОВ' : 'ГОТОВ'}</button>
        <button className="primary-button room-button room-button--start" type="button" disabled={!isReady || !isHost || !playerReady || !opponentReady} onClick={onStartGame}>НАЧАТЬ ИГРУ <span>→</span></button>
      </div>
      {settingsOpen && <SettingsPanel settings={getLobbySettings(room.settings)} readOnly={!isHost} onChange={onSettingsChange} />}
      {notice && <p className="notice">{notice}</p>}
    </section>
  </ScreenFrame>
}

function PlayerSlot({ number, profile, isYou, isHost, connected = true, subtitle }) {
  return <div className={`player-slot ${connected ? 'player-slot--filled' : ''} ${isYou ? 'player-slot--you' : 'player-slot--opponent'}`}><span>{number}</span><div className="player-slot-avatar">{connected ? profile.avatar : <span className="empty-slot-mark">×</span>}</div><strong>{isHost && '👑 '}{isYou ? `${profile.nickname || 'Игрок'} (Вы)` : profile.nickname}</strong><small>{isYou ? 'Ваш профиль' : subtitle}</small></div>
}

function RoundScreen({ room, role, situationDraft, actionDraft, onSituation, onAction, onSubmitSituation, onSubmitAction, onWithdrawAction, onTimeout, onActionRevealContinue, onRetryAiGeneration, onNextRound, isSpeaking, onBack }) {
  const hasSubmittedAction = Boolean(room.actions?.[role])
  const handleTimeout = useCallback(() => {
    if (room.phase === 'actions' && !hasSubmittedAction) onTimeout()
  }, [room.phase, hasSubmittedAction, onTimeout])
  const remaining = useGameTimer(room.actionDeadline, handleTimeout)
  const canSubmitTimeout = Boolean(room.actionDeadline) && remaining === 0
  const isScenarioChooser = role === getScenarioChooser(room)
  const isProcessing = room.phase === 'processing'
  const roundNumber = room.currentRound || 1
  const totalRounds = room.totalRounds || TOTAL_ROUNDS
  const { visibleText, isComplete, revealAll } = useTypingEffect(room.verdict?.story || '', 35)
  const isBlindChoice = room.mutator?.key === 'dark_streak'
  const showVitals = !isBlindChoice && isComplete && !isSpeaking
  const playerNextReady = Boolean(room.nextReady?.[role])

  if (room.phase === 'action_reveal') return <ActionRevealScreen room={room} role={role} isHost={role === 'creator'} onContinue={onActionRevealContinue} onRetry={onRetryAiGeneration} onBack={onBack} />

  if (isProcessing) return <ScreenFrame eyebrow="Раунд 01 / 07" title="AI-ведущий готовит вердикт" onBack={onBack}><section className="processing-card"><div className="ai-provider-badge"><span className="status-dot" /> AI: Gemini 3.1 Flash Lite → Groq fallback</div><div className="processing-orbit"><Sparkles size={28} /></div><h2>История собирается...</h2><p>Оба хода зафиксированы. AI изучает ситуацию, событие и последствия.</p><div className="processing-dots"><span /><span /><span /></div></section></ScreenFrame>

  if (room.phase === 'reveal') return <ScreenFrame eyebrow="Вердикт" title="Решение ведущего" onBack={onBack}><section className="verdict-card"><style>{`
          .verdict-reveal-shell { background: url('../ui/bg/bg-lethal_v3.png') center / cover no-repeat fixed; box-sizing: border-box; display: flex; flex-direction: column; min-height: 100vh; overflow-x: hidden; padding: 24px 48px; }
          .verdict-reveal-shell .site-footer { box-sizing: border-box; flex-shrink: 0; }
          .verdict-reveal-shell .screen-heading { margin: 58px auto 28px; max-width: 1280px; width: 100%; }
          @keyframes verdict-heading-from-top { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } } @keyframes verdict-heading-title { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: scale(1); } }
          .verdict-reveal-shell .screen-heading .eyebrow { align-items: center; animation: verdict-heading-from-top .5s ease .1s both; color: #ef4444 !important; display: flex; font: 700 14px/1.3 ui-monospace, SFMono-Regular, monospace; gap: 12px; letter-spacing: .12em; opacity: 0; text-transform: uppercase; }
          .verdict-reveal-shell .screen-heading .eyebrow span { display: none; }
          .verdict-reveal-shell .screen-heading .eyebrow::before, .verdict-reveal-shell .screen-heading .eyebrow::after { background: #ef4444 !important; content: ''; display: block; flex: 0 0 48px; height: 1px; opacity: 1; width: 48px; }
          .verdict-reveal-shell .screen-heading h1 { animation: verdict-heading-title .5s ease .2s both; color: #f4f4f5; font: 400 clamp(60px, 8vw, 96px)/.96 Georgia, serif; letter-spacing: normal; margin: 24px 0 12px; opacity: 0; }
          .verdict-reveal-shell .verdict-card { -webkit-backdrop-filter: blur(14px); align-items: stretch; backdrop-filter: blur(14px); background: rgba(0,0,0,.6); border: 1px solid rgba(63,63,70,.8); border-radius: 16px; box-shadow: none; color: #f4f4f5; display: flex; flex-direction: column; gap: 18px; margin: 0 auto 58px; max-width: 1180px; padding: clamp(24px, 4vw, 42px); position: relative; width: 100%; z-index: 1; }
          .verdict-reveal-shell .event-badge, .verdict-reveal-shell .ai-provider-badge { align-self: flex-start; color: #bef264; font: 600 12px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .1em; text-transform: uppercase; }
          .verdict-reveal-shell .event-badge { align-self: stretch; border-bottom: 1px solid rgba(255,255,255,.1); display: flex; gap: 8px; padding: 0 0 14px; }
          .verdict-reveal-shell .ai-provider-badge { background: rgba(0,0,0,.5); border: 1px solid rgba(63,63,70,.8); border-radius: 8px; color: #9ca3af; padding: 10px 14px; }
          .verdict-reveal-shell .round-vitals { display: grid; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .verdict-reveal-shell .player-vitals { -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); background: rgba(0,0,0,.6); border: 1px solid rgba(63,63,70,.8); border-radius: 12px; color: #f4f4f5; padding: 20px; }
          .verdict-reveal-shell .vitals-heading { align-items: center; border-bottom: 1px solid rgba(255,255,255,.1); display: flex; justify-content: space-between; margin-bottom: 18px; padding-bottom: 12px; }
          .verdict-reveal-shell .vitals-heading strong { color: #ccff00; font: 700 14px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .08em; text-transform: uppercase; }
          .verdict-reveal-shell .vitals-heading span { color: #ccff00; font: 600 11px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .08em; text-transform: uppercase; }
          .verdict-reveal-shell .vital-row { align-items: center; display: flex; font: 600 12px/1.3 ui-monospace, SFMono-Regular, monospace; justify-content: space-between; letter-spacing: .08em; }
          .verdict-reveal-shell .vital-row span { align-items: center; display: inline-flex; gap: 7px; }
          .verdict-reveal-shell .vital-row--health span, .verdict-reveal-shell .vital-row--health b { color: inherit; }
          .verdict-reveal-shell .vital-row--sanity span, .verdict-reveal-shell .vital-row--sanity b { color: inherit; }
          .verdict-reveal-shell .vital-row--health svg, .verdict-reveal-shell .vital-row--sanity svg { color: inherit; }
          .verdict-reveal-shell .vital-track { background: rgba(255,255,255,.12); border-radius: 999px; height: 7px; margin-top: 8px; overflow: visible; }
          .verdict-reveal-shell .vital-track span { border-radius: inherit; display: block; height: 100%; }
          .verdict-reveal-shell .vital-track--hp span, .verdict-reveal-shell .vital-track--sanity span { transition: background .5s ease, box-shadow .5s ease, width .8s ease; }
          .verdict-reveal-shell .vital-change { color: #ef4444; font: 600 11px/1.3 ui-monospace, SFMono-Regular, monospace; }
          .verdict-reveal-shell .vital-change--sanity { color: #bef264; }
          .verdict-reveal-shell .verdict-story { background: rgba(0,0,0,.5); border: 1px solid rgba(63,63,70,.8); border-left: 2px solid #ccff00; border-radius: 8px; color: #f4f4f5; font: 20px/1.6 ui-monospace, SFMono-Regular, monospace; margin: 0; max-width: none; padding: 24px; }
          .verdict-reveal-shell .verdict-player-cards { display: grid; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .verdict-reveal-shell .verdict-player-card { -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); background: rgba(0,0,0,.6); border: 1px solid rgba(63,63,70,.8); border-radius: 12px; min-width: 0; padding: 20px; }
          .verdict-reveal-shell .verdict-player-card { border-top: 2px solid #bef264; }
          .verdict-reveal-shell .verdict-player-card.is-dead { border-top-color: #ef4444; }
          .verdict-reveal-shell .verdict-player-card-heading { align-items: center; display: flex; gap: 12px; }
          .verdict-reveal-shell .verdict-player-card-avatar { align-items: center; background: #090b0e; border: 1px solid currentColor; border-radius: 50%; display: flex; flex: 0 0 42px; font-size: 24px; height: 42px; justify-content: center; line-height: 1; overflow: hidden; width: 42px; }
          .verdict-reveal-shell .verdict-player-card .verdict-player-card-avatar { color: #bef264; }
          .verdict-reveal-shell .verdict-player-card.is-dead .verdict-player-card-avatar { color: #ef4444; }
          .verdict-reveal-shell .verdict-player-card-heading div:nth-child(2) { display: flex; flex-direction: column; min-width: 0; }
          .verdict-reveal-shell .verdict-player-card-heading span { color: #ccff00; font: 600 10px/1.2 ui-monospace, SFMono-Regular, monospace; letter-spacing: .12em; } .verdict-reveal-shell .verdict-player-card.is-dead .verdict-player-card-heading span { color: #ef4444; }
          .verdict-reveal-shell .verdict-player-card-heading strong { color: #f4f4f5; font: 400 22px/1.1 Georgia, serif; margin-top: 5px; overflow-wrap: anywhere; }
          .verdict-reveal-shell .verdict-player-card-heading b { font: 600 11px/1.2 ui-monospace, SFMono-Regular, monospace; letter-spacing: .08em; margin-left: auto; }
          .verdict-reveal-shell .verdict-player-card-action { background: rgba(0,0,0,.5); border-left: 2px solid #bef264; color: #f4f4f5; font: 16px/1.5 ui-monospace, SFMono-Regular, monospace; margin: 20px 0; min-height: 84px; overflow-wrap: anywhere; padding: 16px; }
          .verdict-reveal-shell .verdict-player-card.is-dead .verdict-player-card-action { border-left-color: #ef4444; }
          .verdict-reveal-shell .verdict-player-card .player-vitals { background: transparent; border: 0; border-radius: 0; padding: 0; }
          .verdict-reveal-shell .verdict-statuses { display: none; }
          .verdict-reveal-shell .verdict-statuses strong { align-items: center; display: flex; font: 600 14px/1.4 ui-monospace, SFMono-Regular, monospace; gap: 9px; letter-spacing: .08em; }
          .verdict-reveal-shell .verdict-status-avatar { align-items: center; background: #090b0e; border: 1px solid currentColor; border-radius: 50%; display: inline-flex; flex: 0 0 38px; font-size: 22px; height: 38px; justify-content: center; line-height: 1; overflow: hidden; padding: 0; text-align: center; width: 38px; }
          .verdict-reveal-shell .verdict-status--alive { color: #bef264; }
          .verdict-reveal-shell .verdict-status--dead { color: #ef4444; }
          .verdict-reveal-shell .blind-vitals { border-top: 1px solid rgba(255,255,255,.1); color: #9ca3af; display: flex; flex-wrap: wrap; gap: 18px; justify-content: center; padding-top: 18px; }
          .verdict-reveal-shell .primary-button, .verdict-reveal-shell .secondary-button { border-radius: 8px; min-height: 46px; }
          .verdict-reveal-shell .primary-button { background: #ccff00; color: #090b0e; }
          .verdict-reveal-shell .secondary-button { background: transparent; border: 1px solid rgba(255,255,255,.18); color: #d4d4d8; }
          .verdict-reveal-shell .verdict-card > * { animation: verdict-reveal-rise .55s ease both; opacity: 0; }
          .verdict-reveal-shell .verdict-card > *:nth-child(1) { animation-delay: .1s; }
          .verdict-reveal-shell .verdict-card > *:nth-child(2) { animation-delay: .2s; }
          .verdict-reveal-shell .verdict-card > *:nth-child(3) { animation-delay: .3s; }
          .verdict-reveal-shell .verdict-card > *:nth-child(4) { animation-delay: .4s; }
          .verdict-reveal-shell .verdict-card > *:nth-child(5) { animation-delay: .5s; }
          @keyframes verdict-reveal-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
          @media (max-width: 1023px) { .verdict-reveal-shell { padding: 24px; } }
          @media (max-width: 767px) { .verdict-reveal-shell { padding: 16px; } .verdict-reveal-shell .screen-heading { margin-top: 16px; } .verdict-reveal-shell .screen-heading h1 { font-size: 36px; } .verdict-reveal-shell .verdict-card { padding: 20px 16px; } .verdict-reveal-shell .round-vitals, .verdict-reveal-shell .verdict-player-cards, .verdict-reveal-shell .verdict-statuses { grid-template-columns: 1fr; } .verdict-reveal-shell .verdict-player-card-action { font-size: 16px; } .verdict-reveal-shell .verdict-story { font-size: 18px; padding: 18px; } .verdict-reveal-shell .site-footer { align-items: center; flex-direction: column; gap: 16px; justify-content: center; padding: 20px 16px; text-align: center; } .verdict-reveal-shell .site-footer-links { order: 1; } .verdict-reveal-shell .site-footer-icons { order: 2; } .verdict-reveal-shell .site-footer-copy { order: 3; } }
        `}</style>{room.verdict ? <><div className="event-badge"><Crown size={16} /> Раунд завершён</div><div className="ai-provider-badge ai-provider-badge--result">Использован: {room.aiProvider || 'Gemini 3.1 Flash Lite'}</div>{isBlindChoice ? <div className="blind-vitals"><span>Игрок 1: HP ??? · Рассудок ???</span><span>Игрок 2: HP ??? · Рассудок ???</span></div> : null}<p className="verdict-story" onClick={revealAll} role="button" tabIndex={0} title="Нажмите, чтобы показать весь текст">{visibleText}</p>{showVitals && <div className="verdict-player-cards"><VerdictPlayerCard profile={getProfile(room, 'creator')} action={room.actions?.creator} label={displayName(room, 'creator')} isYou={role === 'creator'} state={room.player1State || INITIAL_PLAYER_STATE} changes={room.verdict.player1} status={room.verdict.player1Status} /><VerdictPlayerCard profile={getProfile(room, 'waiting')} action={room.actions?.waiting} label={displayName(room, 'waiting')} isYou={role === 'waiting'} state={room.player2State || INITIAL_PLAYER_STATE} changes={room.verdict.player2} status={room.verdict.player2Status} /></div>}<div className="verdict-statuses">{isBlindChoice ? <><strong><span className="verdict-status-avatar">{getProfile(room, 'creator').avatar}</span>Игрок 1: ???</strong><strong><span className="verdict-status-avatar">{getProfile(room, 'waiting').avatar}</span>Игрок 2: ???</strong></> : <><strong className={room.verdict.player1Status === 'ALIVE' ? 'verdict-status--alive' : 'verdict-status--dead'}><span className="verdict-status-avatar">{getProfile(room, 'creator').avatar}</span>{displayName(room, 'creator')}: {room.verdict.player1Status === 'ALIVE' ? 'Выжил' : 'Погиб'}</strong><strong className={room.verdict.player2Status === 'ALIVE' ? 'verdict-status--alive' : 'verdict-status--dead'}><span className="verdict-status-avatar">{getProfile(room, 'waiting').avatar}</span>{displayName(room, 'waiting')}: {room.verdict.player2Status === 'ALIVE' ? 'Выжил' : 'Погиб'}</strong></>}</div><button className="primary-button next-round-button" disabled={playerNextReady} onClick={onNextRound}>{playerNextReady ? 'ОЖИДАНИЕ СОПЕРНИКА...' : roundNumber < totalRounds ? <>Следующий раунд <ArrowRight size={17} /></> : <>Итоги матча <Crown size={17} /></>}</button></> : <><h2>Не удалось получить вердикт</h2><p>{room.verdictError}</p></>}</section></ScreenFrame>

  if (room.phase === 'situation') return <SituationCreationPage room={room} isScenarioChooser={isScenarioChooser} situationDraft={situationDraft} onSituation={onSituation} onSubmitSituation={onSubmitSituation} onBack={onBack} />
  if (room.phase === 'actions') return <ActionsPhaseScreen room={room} role={role} actionDraft={actionDraft} onAction={onAction} onSubmitAction={onSubmitAction} onWithdrawAction={onWithdrawAction} canSubmitTimeout={canSubmitTimeout} remaining={remaining} hasSubmittedAction={hasSubmittedAction} onBack={onBack} />

  return <ScreenFrame eyebrow="Раунд 01 / 07 · Скрытые действия" title="Ваш ход" onBack={onBack}>{room.mutator && <MutatorBanner mutator={room.mutator} />}<section className="round-grid actions-phase"><div className="round-intro"><div className="event-badge"><Sparkles size={16} /> Роль: общий ввод действий</div><p className="submitted-situation">{room.situation}</p>{['live_typing', 'synchronous_link'].includes(room.mutator?.key) && <p className="opponent-status">Напарник пишет: {room.draftActions?.[role === 'creator' ? 'waiting' : 'creator'] || '...'}</p>}{!room.settings?.blindMode && room.actions?.[role === 'creator' ? 'waiting' : 'creator'] && <p className="opponent-status">Соперник уже зафиксировал ход.</p>}<div className="round-room-code">Осталось времени <strong>{remaining} сек</strong></div></div><div className="round-form"><label htmlFor="action">{['live_typing', 'synchronous_link'].includes(room.mutator?.key) ? 'Открытое действие' : 'Скрытое действие'} <span>{actionDraft.length} / {room.mutator?.key === 'butterfly_effect' ? 20 : 120}</span></label><textarea id="action" maxLength={room.mutator?.key === 'butterfly_effect' ? 20 : 120} value={actionDraft} disabled={hasSubmittedAction} onChange={(event) => onAction(event.target.value)} placeholder="Что вы делаете? Напишите смелее..." /><button className="primary-button" disabled={hasSubmittedAction || actionDraft.length > (room.mutator?.key === 'butterfly_effect' ? 20 : 120) || (!actionDraft.trim() && !canSubmitTimeout)} onClick={() => onSubmitAction()}>{hasSubmittedAction ? <><Check size={17} /> Ход сделан. Ожидаем соперника...</> : <>Зафиксировать ход <ArrowRight size={17} /></>}</button></div></section></ScreenFrame>
}

function RoundTimer({ timeLeft = 0, totalTime = 0, isInfinite = false }) {
  const radius = 26
  const circumference = 2 * Math.PI * radius
  const progress = totalTime > 0 ? timeLeft / totalTime : 0
  const strokeDashoffset = circumference - progress * circumference
  const isWarning = timeLeft <= 10 && !isInfinite
  const activeColor = isWarning ? '#ef4444' : '#bef264'
  const minutes = String(Math.floor(timeLeft / 60)).padStart(2, '0')
  const seconds = String(timeLeft % 60).padStart(2, '0')

  return <div className="actions-round-timer"><div className="actions-round-timer-copy"><span>ДО КОНЦА ХОДА:</span><strong style={{ color: activeColor }}>{isInfinite ? 'БЕЗ ЛИМИТА' : `${minutes}:${seconds}`}</strong></div><div className="actions-round-timer-visual">{isInfinite ? <div className="actions-infinite-ring"><span>∞</span></div> : <svg viewBox="0 0 56 56" aria-label={`Осталось ${timeLeft} секунд`}><circle className="actions-round-timer-track" cx="28" cy="28" r={radius} /><circle className="actions-round-timer-progress" cx="28" cy="28" r={radius} style={{ stroke: activeColor, strokeDasharray: circumference, strokeDashoffset }} /></svg>}</div></div>
}

function ActionsPhaseScreen({ room, role, actionDraft, onAction, onSubmitAction, onWithdrawAction, canSubmitTimeout, remaining, hasSubmittedAction, onBack }) {
  const roundNumber = String(room.currentRound || 1).padStart(2, '0')
  const totalRounds = String(room.totalRounds || TOTAL_ROUNDS).padStart(2, '0')
  const scenarioChooser = getScenarioChooser(room)
  const maxLength = room.mutator?.key === 'butterfly_effect' ? 20 : 120
  const readyPlayers = { creator: Boolean(room.actions?.creator), waiting: Boolean(room.actions?.waiting) }
  const submitAction = () => {
    if (!actionDraft.trim() && !canSubmitTimeout) return
    onSubmitAction()
  }

  return <main className="app-shell actions-screen-shell">
    <style>{`
      .actions-screen-shell { background: url('/ui/bg/bg-lethal_v3.png') center / cover no-repeat fixed; display: flex; flex-direction: column; min-height: 100vh; overflow-x: hidden; padding: 24px 48px; }
      .actions-screen-shell .actions-screen-inner { flex: 1; margin: 0 auto; max-width: 1280px; padding: 24px 0; transform: translateY(-24px); width: 100%; }
      .actions-screen-shell .site-footer { flex-shrink: 0; margin-top: auto; }
      .actions-screen-shell .actions-back { align-items: center; background: transparent; border: 0; color: #a1a1aa; display: flex; font: 10px/1 ui-monospace, SFMono-Regular, monospace; gap: 7px; letter-spacing: .12em; margin-bottom: 30px; padding: 0; text-transform: uppercase; }
      .actions-screen-shell .actions-page-heading { margin: 58px 0 28px; }
      .actions-screen-shell .actions-entry-badge { animation: actions-entry-from-top .5s ease .1s both; opacity: 0; }
      .actions-screen-shell .actions-entry-title { animation: actions-entry-title .5s ease .2s both; opacity: 0; }
      .actions-screen-shell .actions-entry-left { animation: actions-entry-from-left .55s ease .3s both; opacity: 0; }
      .actions-screen-shell .actions-entry-right { animation: actions-entry-from-right .55s ease .4s both; opacity: 0; }
      @keyframes actions-entry-from-top { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes actions-entry-title { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: scale(1); } }
      @keyframes actions-entry-from-left { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
      @keyframes actions-entry-from-right { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
      .actions-screen-shell .actions-info .actions-kicker { animation: actions-copy-rise .5s ease .45s both; opacity: 0; }
      .actions-screen-shell .actions-info .actions-scenario-title { animation: actions-copy-rise .55s ease .55s both; opacity: 0; }
      .actions-screen-shell .actions-info .actions-author { animation: actions-copy-rise .55s ease .65s both; opacity: 0; }
      .actions-screen-shell .actions-info .actions-round-timer { animation: actions-copy-rise .55s ease .75s both; opacity: 0; }
      .actions-screen-shell .actions-info .actions-rounds { animation: actions-copy-rise .55s ease .85s both; opacity: 0; }
      .actions-screen-shell .actions-form-card .actions-field-heading { animation: actions-copy-rise .5s ease .55s both; opacity: 0; }
      .actions-screen-shell .actions-form-card .actions-textarea { animation: actions-copy-rise .55s ease .65s both; opacity: 0; }
      .actions-screen-shell .actions-form-card .actions-form-actions { animation: actions-copy-rise .55s ease .75s both; opacity: 0; }
      .actions-screen-shell .actions-form-card .actions-ready-title { animation: actions-copy-rise .55s ease .85s both; opacity: 0; }
      .actions-screen-shell .actions-form-card .actions-player { animation: actions-card-pop .7s cubic-bezier(.2,.8,.2,1) both; opacity: 0; }
      .actions-screen-shell .actions-form-card .actions-player:nth-child(1) { animation-delay: .95s; }
      .actions-screen-shell .actions-form-card .actions-player:nth-child(2) { animation-delay: 1.1s; }
      @keyframes actions-copy-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes actions-card-pop { from { opacity: 0; box-shadow: 0 0 0 rgba(190,242,100,0); transform: translateY(18px) scale(.94); } 65% { box-shadow: 0 0 12px rgba(190,242,100,.05); opacity: 1; transform: translateY(-2px) scale(1.01); } to { box-shadow: 0 0 0 rgba(190,242,100,0); opacity: 1; transform: translateY(0) scale(1); } }
      .actions-screen-shell .actions-eyebrow { align-items: center; color: #ef4444; display: flex; font: 700 14px/1.3 ui-monospace, SFMono-Regular, monospace; gap: 12px; letter-spacing: .12em; text-transform: uppercase; }
      .actions-screen-shell .actions-eyebrow::before, .actions-screen-shell .actions-eyebrow::after { background: #ef4444; content: ''; flex: 0 0 48px; height: 1px; }
      .actions-screen-shell .actions-title { color: #f4f4f5; font: 400 clamp(60px, 8vw, 96px)/.96 Georgia, serif; letter-spacing: normal; margin: 24px 0 12px; }
      .actions-screen-shell .actions-subtitle { color: #d4d4d8; font: 14px/1.5 ui-monospace, SFMono-Regular, monospace; letter-spacing: .1em; margin: 0; text-transform: uppercase; }
      .actions-screen-shell .actions-divider { align-items: center; display: flex; margin-top: 12px; max-width: 610px; }
      .actions-screen-shell .actions-divider::before, .actions-screen-shell .actions-divider::after { background: #ef4444; content: ''; flex: 1; height: 2px; opacity: .7; }
      .actions-screen-shell .actions-divider span { color: #ef4444; font-size: 12px; margin: 0 8px; }
      .actions-screen-shell .actions-grid { align-items: start; display: grid; gap: 24px; grid-template-columns: repeat(12, minmax(0, 1fr)); }
      .actions-screen-shell .actions-info, .actions-screen-shell .actions-form-card { backdrop-filter: blur(14px); background: rgba(0,0,0,.6); border: 1px solid rgba(63,63,70,.8); border-radius: 16px; min-height: 0; }
      .actions-screen-shell .actions-info { display: flex; flex-direction: column; gap: 28px; grid-column: span 5; padding: 32px; }
      .actions-screen-shell .actions-form-card { grid-column: span 7; padding: 32px; }
      .actions-screen-shell .actions-kicker { align-items: center; color: #ef4444; display: flex; font: 600 14px/1.4 ui-monospace, SFMono-Regular, monospace; gap: 8px; letter-spacing: .12em; text-transform: uppercase; }
      .actions-screen-shell .actions-scenario-title { color: #f4f4f5; font: 400 24px/1.2 Georgia, serif; margin: 16px 0; overflow-wrap: anywhere; word-break: break-word; }
      .actions-screen-shell .actions-scenario-copy { color: #d4d4d8; font: 14px/1.6 ui-monospace, SFMono-Regular, monospace; margin: 16px 0; max-width: 460px; }
      .actions-screen-shell .actions-author { align-items: center; border-top: 1px solid rgba(255,255,255,.08); color: #9ca3af; display: flex; flex-wrap: wrap; font: 15px/1.4 ui-monospace, SFMono-Regular, monospace; gap: 10px; justify-content: flex-start; letter-spacing: .06em; margin-top: 18px; min-width: 0; padding-top: 16px; text-transform: uppercase; }
      .actions-screen-shell .actions-author strong { align-items: center; color: #bef264; display: inline-flex; flex: 0 0 auto; font-size: 17px; gap: 5px; margin-right: auto; white-space: nowrap; }
      .actions-screen-shell .actions-author-break { flex-basis: 100%; height: 0; }
      .actions-screen-shell .actions-report { align-items: center; background: transparent; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; color: #d1d5db; display: inline-flex; flex: 0 0 auto; font: 14px/1.2 ui-monospace, SFMono-Regular, monospace; gap: 8px; justify-content: center; margin-left: 0; margin-right: auto; max-width: 100%; padding: 10px 18px 10px 15px; transition: background .2s ease, border-color .2s ease, box-shadow .2s ease, color .2s ease; white-space: nowrap; width: 35%; }
      .actions-screen-shell .actions-report svg { color: currentColor; flex: 0 0 16px; height: 16px; transition: color .2s ease, filter .2s ease; width: 16px; }
      .actions-screen-shell .actions-report:hover { background: transparent; border-color: #ef4444; box-shadow: none; color: #ef4444; }
      .actions-screen-shell .actions-report:hover svg { color: #ef4444; filter: none; }
      .actions-screen-shell .actions-timer-label, .actions-screen-shell .actions-round-label, .actions-screen-shell .actions-ready-title { color: #9ca3af; font: 600 12px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .1em; text-transform: uppercase; }
      .actions-screen-shell .actions-round-timer { align-items: center; display: flex; justify-content: space-between; margin-top: 10px; width: 100%; }
      .actions-screen-shell .actions-round-timer-copy { display: flex; flex-direction: column; gap: 5px; }
      .actions-screen-shell .actions-round-timer-copy span { color: #9ca3af; font: 600 12px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .1em; text-transform: uppercase; }
      .actions-screen-shell .actions-round-timer-copy strong { font: 700 clamp(1.5rem, 4vw, 1.875rem)/1 ui-monospace, SFMono-Regular, monospace; letter-spacing: .04em; transition: color .3s ease; }
      .actions-screen-shell .actions-round-timer-visual { align-items: center; display: flex; height: 58px; justify-content: center; width: 58px; }
      .actions-screen-shell .actions-round-timer-visual svg { height: 58px; transform: rotate(-90deg); width: 58px; }
      .actions-screen-shell .actions-round-timer-visual circle { fill: transparent; stroke-width: 4; }
      .actions-screen-shell .actions-round-timer-track { stroke: #22262a; stroke-dasharray: 4 2; }
      .actions-screen-shell .actions-round-timer-progress { stroke-linecap: round; transition: stroke .3s ease, stroke-dashoffset .5s linear; }
      .actions-screen-shell .actions-infinite-ring { align-items: center; background: transparent; border: 4px solid #bef264; border-radius: 50%; box-shadow: 0 0 14px rgba(190,242,100,.5), inset 0 0 10px rgba(190,242,100,.12); display: flex; height: 56px; justify-content: center; width: 56px; }
      .actions-screen-shell .actions-infinite-ring span { color: #bef264; filter: drop-shadow(0 0 8px rgba(190,242,100,.65)); font: 700 32px/1 ui-monospace, SFMono-Regular, monospace; transform: translateY(-2px); }
      .actions-screen-shell .actions-rounds { border-top: 1px solid rgba(255,255,255,.08); padding-top: 16px; }
      .actions-screen-shell .actions-dots { display: flex; gap: 7px; margin-top: 12px; }
      .actions-screen-shell .actions-dot { border: 1px solid rgba(255,255,255,.25); border-radius: 50%; height: 8px; width: 8px; }
      .actions-screen-shell .actions-dot.is-active { background: radial-gradient(circle, #ef4444 0 2px, transparent 2.5px); border: 1px solid #ef4444; box-shadow: 0 0 0 2px rgba(239,68,68,.15), 0 0 8px rgba(239,68,68,.7); height: 10px; width: 10px; }
      .actions-screen-shell .actions-field-heading { align-items: center; color: #a1a1aa; display: flex; font: 600 14px/1.3 ui-monospace, SFMono-Regular, monospace; justify-content: space-between; letter-spacing: .12em; text-transform: uppercase; }
      .actions-screen-shell .actions-field-heading label { color: #ccff00; }
      .actions-screen-shell .actions-field-heading span { color: #ccff00; font: 12px/1.3 ui-monospace, SFMono-Regular, monospace; }
      .actions-screen-shell .actions-textarea { background: rgba(0,0,0,.5); border: 1px solid #3f3f46; border-radius: 12px; color: #f4f4f5; display: block; font: 20px/1.5 ui-monospace, SFMono-Regular, monospace; margin-top: 16px; min-height: 200px; outline: 0; padding: 24px; resize: vertical; width: 100%; }
      .actions-screen-shell .actions-textarea:focus { border-color: rgba(163,230,53,.55); box-shadow: 0 0 0 1px rgba(163,230,53,.12); }
      .actions-screen-shell .actions-textarea:disabled { cursor: not-allowed; opacity: .6; }
      .actions-screen-shell .actions-textarea::placeholder { color: #6b7280; }
      .actions-screen-shell .actions-form-actions { align-items: center; display: flex; gap: 12px; justify-content: flex-end; margin-top: 14px; }
      .actions-screen-shell .actions-ready-button { align-items: center; border-radius: 12px; display: flex; font: 800 20px/1 ui-monospace, SFMono-Regular, monospace; justify-content: center; letter-spacing: .08em; padding: 20px 32px; text-transform: uppercase; transition: background .2s ease, border-color .2s ease, color .2s ease, transform .2s ease; width: 100%; }
      .actions-screen-shell .actions-ready-button { background: #ccff00; border: 0; box-shadow: 0 10px 24px rgba(0,0,0,.35); color: #090b0e; }
      .actions-screen-shell .actions-ready-button.is-submitted { background: #ef4444; box-shadow: 0 10px 24px rgba(239,68,68,.24); color: #fff; }
      .actions-screen-shell .actions-ready-button:hover:not(:disabled) { background: #b8e600; transform: scale(1.01); }
      .actions-screen-shell .actions-ready-button.is-submitted:hover:not(:disabled) { background: #dc2626; }
      .actions-screen-shell .actions-ready-button:disabled { cursor: not-allowed; filter: grayscale(.6); opacity: .5; }
      .actions-screen-shell .actions-ready-title { color: #ccff00; margin-top: 26px; }
      .actions-screen-shell .actions-ready-grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 12px; }
      .actions-screen-shell .actions-player { align-items: center; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.1); border-radius: 12px; display: flex; gap: 16px; justify-content: space-between; min-height: 124px; min-width: 0; padding: 20px; }
      .actions-screen-shell .actions-player.is-ready { background: rgba(54,83,20,.12); border-color: rgba(190,242,100,.5); }
      .actions-screen-shell .actions-player-avatar { align-items: center; background: rgba(0,0,0,.35); border: 1px solid rgba(190,242,100,.45); border-radius: 50%; color: #bef264; display: flex; flex: 0 0 48px; font-size: 26px; height: 48px; justify-content: center; width: 48px; }
      .actions-screen-shell .actions-player-info { flex: 1; min-width: 0; }
      .actions-screen-shell .actions-player-name { color: #fff; display: block; font: 700 14px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .04em; overflow-wrap: anywhere; text-transform: uppercase; }
      .actions-screen-shell .actions-player-status { color: #9ca3af; display: block; font: 12px/1.4 ui-monospace, SFMono-Regular, monospace; margin-top: 3px; }
      .actions-screen-shell .actions-player.is-ready .actions-player-status { color: #bef264; }
      .actions-screen-shell .actions-player-mark { align-items: center; border: 1px solid rgba(255,255,255,.2); border-radius: 50%; color: #71717a; display: flex; flex: 0 0 28px; font: 700 14px/1; height: 28px; justify-content: center; width: 28px; }
      .actions-screen-shell .actions-player.is-ready .actions-player-mark { border-color: #bef264; color: #bef264; }
      .actions-screen-shell .actions-waiting-dots { align-items: center; display: inline-flex; gap: 2px; height: 12px; }
      .actions-screen-shell .actions-waiting-dots i { animation: actions-dot-bounce 2s ease-in-out infinite; background: currentColor; border-radius: 50%; display: block; height: 3px; width: 3px; }
      .actions-screen-shell .actions-waiting-dots i:nth-child(2) { animation-delay: .25s; }
      .actions-screen-shell .actions-waiting-dots i:nth-child(3) { animation-delay: .5s; }
      .actions-screen-shell .actions-thinking-label { animation: actions-thinking-label 1.4s ease-in-out infinite; }
      .actions-screen-shell .actions-thinking-dots { display: inline-flex; min-width: 18px; }
      .actions-screen-shell .actions-thinking-dots i { animation: actions-thinking-dot 1.4s ease-in-out infinite; font-style: normal; opacity: 0; }
      .actions-screen-shell .actions-thinking-dots i:nth-child(2) { animation-delay: .2s; }
      .actions-screen-shell .actions-thinking-dots i:nth-child(3) { animation-delay: .4s; }
      @keyframes actions-thinking-label { 0%, 20% { opacity: .58; } 35%, 65% { opacity: 1; } 80%, 100% { opacity: .58; } }
      @keyframes actions-thinking-dot { 0%, 20% { opacity: 0; } 35%, 65% { opacity: 1; } 80%, 100% { opacity: 0; } }
      @keyframes actions-dot-bounce { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-3px); } }
            @media (max-width: 1023px) { .actions-screen-shell { padding: 24px; } }
      @media (min-width: 768px) and (max-width: 1960px) { .actions-screen-shell .actions-report { flex-basis: 220px; width: 220px; } }
      @media (max-width: 900px) { .actions-screen-shell .actions-info, .actions-screen-shell .actions-form-card { grid-column: 1 / -1; } }
      @media (max-width: 767px) { .actions-screen-shell { padding: 16px; } .actions-screen-shell .actions-screen-inner { padding: 16px 0 40px; transform: translateY(-12px); } .actions-screen-shell .site-footer { align-items: center; flex-direction: column; gap: 16px; justify-content: center; padding: 20px 16px; text-align: center; } .actions-screen-shell .site-footer-links { order: 1; } .actions-screen-shell .site-footer-icons { order: 2; } .actions-screen-shell .site-footer-copy { order: 3; } }
      @media (max-width: 767px) { .actions-screen-shell .actions-page-heading { margin-top: 16px; } .actions-screen-shell .actions-title { font-size: 36px; } .actions-screen-shell .actions-scenario-copy { font-size: 16px; } .actions-screen-shell .actions-textarea { min-height: 160px; } .actions-screen-shell .actions-info, .actions-screen-shell .actions-form-card { min-height: 0; padding: 24px; } .actions-screen-shell .actions-report { font-size: 12px; } }
      @media (max-width: 560px) { .actions-screen-shell .actions-form-actions, .actions-screen-shell .actions-ready-grid { grid-template-columns: 1fr; display: grid; } .actions-screen-shell .actions-ready-button { width: 100%; } .actions-screen-shell .actions-info, .actions-screen-shell .actions-form-card { padding: 16px; } .actions-screen-shell .actions-report { font-size: 11px; padding-right: 14px; width: 42%; } }
    `}</style>
    <SiteHeader />
    <div className="actions-screen-inner">
      <header className="actions-page-heading"><div className="actions-eyebrow actions-entry-badge">СКРЫТЫЕ ДЕЙСТВИЯ</div><h1 className="actions-title actions-entry-title">Ваш ход</h1></header>
      <section className="actions-grid">
        <aside className="actions-info actions-entry-left">
          <div><div className="actions-kicker"><Shield size={14} /> СЦЕНАРИЙ</div><h2 className="actions-scenario-title">{room.situation || 'Ситуация раунда'}</h2><div className="actions-author"><span>АВТОР СЦЕНАРИЯ:</span><strong><Crown size={12} /> {displayName(room, scenarioChooser)}</strong><span className="actions-author-break" aria-hidden="true" /><button className="actions-report" type="button"><AlertTriangle size={16} aria-hidden="true" /> ПОЖАЛОВАТЬСЯ</button></div></div>
          <RoundTimer timeLeft={remaining} totalTime={room.settings?.turnTimer || 0} isInfinite={!room.settings?.turnTimer} />
          <div className="actions-rounds"><div className="actions-round-label">РАУНД {roundNumber} ИЗ {totalRounds}</div><div className="actions-dots">{Array.from({ length: Number(totalRounds) }, (_, index) => <span className={`actions-dot ${index + 1 === Number(roundNumber) ? 'is-active' : ''}`} key={index} />)}</div></div>
        </aside>
        <section className="actions-form-card actions-entry-right"><div className="actions-field-heading"><label htmlFor="action">ВАШЕ ДЕЙСТВИЕ</label><span>СИМВОЛОВ: {actionDraft.length} / {maxLength}</span></div><textarea className="actions-textarea" id="action" maxLength={maxLength} value={actionDraft} disabled={hasSubmittedAction} onChange={(event) => onAction(event.target.value)} placeholder="Опишите ваше действие..." /><div className="actions-form-actions"><button className={`actions-ready-button ${hasSubmittedAction ? 'is-submitted' : ''}`} type="button" disabled={!hasSubmittedAction && (!actionDraft.trim() && !canSubmitTimeout)} onClick={hasSubmittedAction ? onWithdrawAction : submitAction}>{hasSubmittedAction ? 'НЕ ГОТОВ' : 'ГОТОВ'}</button></div><div className="actions-ready-title">ГОТОВНОСТЬ ИГРОКОВ</div><div className="actions-ready-grid"><div className={`actions-player ${readyPlayers.creator ? 'is-ready' : ''}`}><span className="actions-player-avatar" aria-hidden="true">{getProfile(room, 'creator').avatar}</span><div className="actions-player-info"><span className="actions-player-name">{displayName(room, 'creator')}{role === 'creator' ? ' (ВЫ)' : ''}</span><span className="actions-player-status">{readyPlayers.creator ? 'Готов' : <><span className="actions-thinking-label">Думает</span><span className="actions-thinking-dots"><i>.</i><i>.</i><i>.</i></span></>}</span></div><span className="actions-player-mark">{readyPlayers.creator ? '✓' : <span className="actions-waiting-dots" aria-label="Ожидание"><i /><i /><i /></span>}</span></div><div className={`actions-player ${readyPlayers.waiting ? 'is-ready' : ''}`}><span className="actions-player-avatar" aria-hidden="true">{getProfile(room, 'waiting').avatar}</span><div className="actions-player-info"><span className="actions-player-name">{displayName(room, 'waiting')}{role === 'waiting' ? ' (ВЫ)' : ''}</span><span className="actions-player-status">{readyPlayers.waiting ? 'Вы готовы' : <><span className="actions-thinking-label">Думает</span><span className="actions-thinking-dots"><i>.</i><i>.</i><i>.</i></span></>}</span></div><span className="actions-player-mark">{readyPlayers.waiting ? '✓' : <span className="actions-waiting-dots" aria-label="Ожидание"><i /><i /><i /></span>}</span></div></div><p className="actions-hint"><span></span> </p></section>
      </section>
    </div>
    <SiteFooter />
  </main>
}

function SituationCreationPage({ room, isScenarioChooser, situationDraft, onSituation, onSubmitSituation, onBack }) {
  const roundNumber = String(room.currentRound || 1).padStart(2, '0')
  const totalRounds = String(room.totalRounds || TOTAL_ROUNDS).padStart(2, '0')
  const activePlayer = getProfile(room, getScenarioChooser(room))
  const chooserName = displayName(room, getScenarioChooser(room))
  return <main className="situation-creation-page">
    <style>{`
      .situation-creation-page { background: url('/ui/bg/bg-lethal_v3.png') center / cover no-repeat fixed; color: #d4d4d8; display: flex; flex-direction: column; justify-content: space-between; min-height: 100vh; overflow-x: hidden; overflow-y: auto; padding: 24px 48px; position: relative; width: 100%; }
      .situation-creation-page::before { display: none; }
      .situation-creation-page__art { background: center / cover no-repeat; inset: 0 0 0 54%; opacity: .8; pointer-events: none; position: absolute; z-index: 0; }
      .situation-creation-page__inner { margin: 0 auto; max-width: 1400px; position: relative; width: 100%; z-index: 1; }
      .situation-creation-page__main { display: flex; flex: 1; flex-direction: column; justify-content: flex-start; margin: 0 auto; max-width: 1500px; padding: 24px 48px 48px; width: 100%; }
      .situation-creation-page__header { align-items: center; border-bottom: 1px solid rgba(63,63,70,.28); display: flex; justify-content: space-between; min-height: 58px; }
      .situation-creation-page__brand { align-items: center; color: #d4d4d8; display: flex; font: 700 10px/1 ui-monospace, SFMono-Regular, monospace; gap: 10px; letter-spacing: .14em; }
      .situation-creation-page__version { border: 1px solid rgba(204,255,0,.55); border-radius: 3px; color: #ccff00; font-size: 9px; letter-spacing: .08em; padding: 4px 6px; }
      .situation-creation-page__nav { align-items: center; display: flex; gap: 15px; }
      .situation-creation-page__guide { align-items: center; background: rgba(9,11,14,.7); border: 1px solid rgba(63,63,70,.75); border-radius: 5px; color: #d4d4d8; display: inline-flex; font: 700 9px/1 ui-monospace, SFMono-Regular, monospace; gap: 7px; letter-spacing: .08em; padding: 9px 12px; text-transform: uppercase; }
      .situation-creation-page__icon { background: transparent; border: 0; color: #a1a1aa; padding: 4px; }
      .situation-creation-page__stage { margin: 58px 0 28px; }
      .situation-creation-page__eyebrow { align-items: center; color: #ef4444; display: flex; font: 700 14px/1.3 ui-monospace, SFMono-Regular, monospace; gap: 12px; letter-spacing: .12em; text-transform: uppercase; }
      .situation-creation-page__eyebrow::before, .situation-creation-page__eyebrow::after { background: #ef4444; content: ''; display: inline-block; flex: 0 0 48px; height: 1px; }
      .situation-creation-page__title { color: #f4f4f5; font: 400 clamp(60px, 8vw, 96px)/.96 Georgia, serif; letter-spacing: normal; margin: 24px 0 0; }
      .situation-creation-page__content { align-items: stretch; display: grid; gap: 32px; grid-template-columns: repeat(12, minmax(0, 1fr)); margin-top: 24px; width: 100%; }
      .situation-creation-page__card { backdrop-filter: blur(14px); background: rgba(0,0,0,.6); border: 1px solid rgba(63,63,70,.8); border-radius: 16px; min-height: 420px; padding: 32px; }
      .situation-creation-page__intro { display: flex; flex-direction: column; grid-column: span 4; justify-content: space-between; }
      .situation-creation-page__role { color: #ef4444; font: 600 14px/1.4 ui-monospace, SFMono-Regular, monospace; letter-spacing: .12em; text-transform: uppercase; }
      .situation-creation-page__description { color: #d4d4d8; font: 400 20px/1.6 ui-monospace, SFMono-Regular, monospace; margin: 16px 0; max-width: 460px; }
      .situation-creation-page__description-line { display: block; }
      .situation-creation-page__round-progress { border-top: 1px solid rgba(63,63,70,.5); margin-top: auto; padding-top: 17px; }
      .situation-creation-page__round-label { color: #9ca3af; display: block; font: 600 12px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .1em; text-transform: uppercase; }
      .situation-creation-page__round-dots { display: flex; gap: 7px; margin-top: 14px; }
      .situation-creation-page__round-dot { border: 1px solid rgba(255,255,255,.25); border-radius: 50%; height: 8px; width: 8px; }
      .situation-creation-page__round-dot.is-active { background: radial-gradient(circle, #ef4444 0 2px, transparent 2.5px); border-color: #ef4444; box-shadow: 0 0 0 2px rgba(239,68,68,.15), 0 0 8px rgba(239,68,68,.7); height: 10px; width: 10px; }
      .situation-creation-page__round-dots { color: #ccff00; }
      .situation-creation-page__copy { background: rgba(24,24,27,.8); border: 1px solid rgba(63,63,70,.6); border-radius: 8px; color: #d4d4d8; font: 14px/1 ui-monospace, SFMono-Regular, monospace; letter-spacing: .08em; padding: 10px 20px; text-transform: uppercase; transition: color .3s ease, transform .2s ease, border-color .3s ease; }
      .situation-creation-page__copy:hover { border-color: rgba(204,255,0,.6); color: #ccff00; }
      .situation-creation-page__copy:active { transform: scale(.95); }
      .situation-entry-badge { animation: situation-entry-from-top .5s ease .1s both; opacity: 0; }
      .situation-entry-title { animation: situation-entry-title .5s ease .2s both; opacity: 0; }
      .situation-entry-left { animation: situation-entry-from-left .55s ease .3s both; opacity: 0; }
      .situation-entry-right { animation: situation-entry-from-right .55s ease .4s both; opacity: 0; }
      @keyframes situation-entry-from-top { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes situation-entry-title { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: scale(1); } }
      @keyframes situation-entry-from-left { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
      @keyframes situation-entry-from-right { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
      .situation-creation-page__form { display: flex; flex-direction: column; grid-column: span 8; justify-content: space-between; }
      .situation-creation-page__form-label { color: #ccff00; display: flex; font: 600 14px/1 ui-monospace, SFMono-Regular, monospace; justify-content: space-between; letter-spacing: .12em; text-transform: uppercase; }
      .situation-creation-page__form-label span { color: #ccff00; }
      .situation-creation-page__textarea { background: rgba(0,0,0,.5); border: 1px solid #3f3f46; border-radius: 12px; color: #f4f4f5; flex: 1; font: 20px/1.5 ui-monospace, SFMono-Regular, monospace; margin-top: 16px; min-height: 200px; outline: 0; padding: 24px; resize: none; transition: border-color .2s ease; }
      .situation-creation-page__textarea::placeholder { color: #52525b; }
      .situation-creation-page__textarea:focus { border-color: rgba(204,255,0,.7); box-shadow: 0 0 0 1px rgba(204,255,0,.16); }
      .situation-creation-page__submit { align-items: center; width: 100%; background: #ccff00; border: 0; border-radius: 12px; box-shadow: 0 10px 24px rgba(0,0,0,.35); color: #090b0e; display: flex; font: 800 20px/1 ui-monospace, SFMono-Regular, monospace; gap: 12px; justify-content: center; letter-spacing: .08em; margin-top: 16px; padding: 20px 32px; text-transform: uppercase; transition: transform .2s ease, background .2s ease; }
      .situation-creation-page__submit:hover { background: #b8e600; transform: scale(1.01); }
      .situation-creation-page__submit:disabled { cursor: not-allowed; filter: grayscale(.7); opacity: .45; }
      .situation-creation-page__waiting { align-items: center; background: rgba(69,10,10,.1); border: 1px dashed rgba(239,68,68,.3); border-radius: 12px; display: flex; flex: 1; flex-direction: column; justify-content: center; min-height: 300px; overflow: hidden; padding: 32px; position: relative; text-align: center; }
      @keyframes breathingIcon { 0%, 100% { border-color: rgba(239,68,68,.3); box-shadow: 0 0 10px rgba(239,68,68,.2); } 50% { border-color: rgba(239,68,68,.8); box-shadow: 0 0 25px rgba(239,68,68,.5); } }
      .situation-creation-page__waiting-icon { align-items: center; animation: breathingIcon 3.5s ease-in-out infinite; background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.4); border-radius: 50%; color: #ef4444; display: flex; height: 64px; justify-content: center; margin-bottom: 16px; overflow: hidden; position: relative; width: 64px; z-index: 1; }
      .situation-creation-page__waiting-avatar { font-size: 32px !important; line-height: 1 !important; margin: 0 !important; }
      .situation-creation-page__waiting h3 { color: #f4f4f5; font: 400 24px/1.2 Georgia, serif; margin: 0 0 8px; position: relative; z-index: 1; }
      .situation-creation-page__waiting h3 .situation-waiting-player { color: #f87171; font-weight: 700; margin: 0; }
      .situation-creation-page__waiting .situation-thinking-label { animation: situation-thinking-label 2s ease-in-out infinite; }
      .situation-creation-page__waiting .situation-thinking-dots { display: inline-flex; min-width: 18px; }
      .situation-creation-page__waiting .situation-thinking-dots i { animation: situation-thinking-dot 2s ease-in-out infinite; font-style: normal; opacity: 0; }
      .situation-creation-page__waiting .situation-thinking-dots i:nth-child(2) { animation-delay: .3s; }
      .situation-creation-page__waiting .situation-thinking-dots i:nth-child(3) { animation-delay: .6s; }
      @keyframes situation-thinking-label { 0% { opacity: .58; } 20% { opacity: .62; } 35% { opacity: .78; } 50% { opacity: .88; } 65% { opacity: .78; } 80% { opacity: .62; } 100% { opacity: .58; } }
      @keyframes situation-thinking-dot { 0% { opacity: 0; } 20% { opacity: .08; } 35% { opacity: .5; } 50% { opacity: .8; } 65% { opacity: .5; } 80% { opacity: .08; } 100% { opacity: 0; } }
      .situation-creation-page__waiting p { color: #71717a; font: 14px/1.4 ui-monospace, SFMono-Regular, monospace; margin: 0; position: relative; z-index: 1; }
            .situation-creation-page .site-footer { align-items: center; animation: lobby-footer-enter .8s ease-out .6s both; border-top: 1px solid #c94b4b; color: rgba(240,238,232,.74); display: flex; flex-direction: row; font: 15px/1 ui-monospace, SFMono-Regular, monospace; gap: 16px; justify-content: space-between; margin: 0 auto; max-width: 1500px; padding: 24px 48px; width: 100%; }
      .situation-creation-page .site-footer-copy { align-items: center; display: flex; gap: 8px; white-space: nowrap; }
      .situation-creation-page .site-footer-links { align-items: center; display: flex; gap: 24px; white-space: nowrap; }
      .situation-creation-page .site-footer-links a { color: inherit; font: inherit; letter-spacing: inherit; text-decoration: none; transition: color .2s ease; }
      .situation-creation-page .site-footer-links a:hover { color: #f4f4f5; }
      .situation-creation-page .site-footer-links > span { color: inherit; }
      .situation-creation-page .site-footer-icons { align-items: center; display: flex; gap: 24px; }
      .situation-creation-page .site-footer-icons button { background: transparent; border: 0; color: inherit; padding: 0; transition: color .2s ease; }
      .situation-creation-page .site-footer-icons svg { height: 22px; width: 22px; }
      .situation-creation-page .site-footer-icons button:hover { color: #fff; }
      @media (max-width: 1023px) { .situation-creation-page { padding: 24px; } .situation-creation-page__main { padding: 24px 24px 48px; } .situation-creation-page__content { grid-template-columns: 1fr; } .situation-creation-page__intro, .situation-creation-page__form { grid-column: auto; } }
      @media (max-width: 767px) { .situation-creation-page { padding: 16px; } .situation-creation-page__main { padding: 16px 0 40px; } .situation-creation-page__stage { margin-top: 16px; } .situation-creation-page__title { font-size: 36px; } .situation-creation-page__textarea { min-height: 160px; } .situation-creation-page__card { min-height: 380px; padding: 24px; } .situation-creation-page .site-footer { align-items: center; flex-direction: column; gap: 16px; justify-content: center; padding: 20px 16px; text-align: center; } .situation-creation-page .site-footer-links { order: 1; } .situation-creation-page .site-footer-icons { order: 2; } .situation-creation-page .site-footer-copy { order: 3; } }
    `}</style>
    <SiteHeader />
    <main className="situation-creation-page__main">
      <section className="situation-creation-page__stage"><div className="situation-creation-page__eyebrow situation-entry-badge">СОЗДАНИЕ СИТУАЦИИ</div><h1 className="situation-creation-page__title situation-entry-title">{isScenarioChooser ? 'Придумайте ситуацию' : 'Ожидаем ситуацию'}</h1></section>
      <section className="situation-creation-page__content">
        <article className="situation-creation-page__card situation-creation-page__intro situation-entry-left"><div className="situation-creation-page__role">✦ СЦЕНАРИЙ ВЫБИРАЕТ: {chooserName}</div><p className="situation-creation-page__description">{isScenarioChooser ? <><span className="situation-creation-page__description-line">Задайте сцену для обоих игроков.</span><span className="situation-creation-page__description-line">В следующем раунде право выбора перейдёт сопернику.</span></> : `${chooserName} придумывает ситуацию...`}</p><div className="situation-creation-page__round-progress"><span className="situation-creation-page__round-label">РАУНД {roundNumber} ИЗ {totalRounds}</span><div className="situation-creation-page__round-dots">{Array.from({ length: Number(totalRounds) }, (_, index) => <span className={`situation-creation-page__round-dot ${index + 1 === Number(roundNumber) ? 'is-active' : ''}`} key={index} />)}</div></div></article>
        <article key={isScenarioChooser ? 'input' : 'waiting'} className="situation-creation-page__card situation-creation-page__form situation-entry-right">{isScenarioChooser ? <><label className="situation-creation-page__form-label" htmlFor="situation">СИТУАЦИОННЫЙ КОНТЕКСТ <span>{situationDraft.length} / 240</span></label><textarea className="situation-creation-page__textarea" id="situation" maxLength={240} value={situationDraft} onChange={(event) => onSituation(event.target.value)} placeholder="Например: вы застряли в музее, где экспонаты просыпаются ночью..." /><button className="situation-creation-page__submit" type="button" disabled={!situationDraft.trim()} onClick={onSubmitSituation}>ОТПРАВИТЬ СИТУАЦИЮ <ArrowRight size={15} /></button></> : <div className="situation-creation-page__waiting"><div className="situation-creation-page__waiting-icon">{activePlayer.avatar ? <span className="situation-creation-page__waiting-avatar">{activePlayer.avatar}</span> : <UserRound size={32} />}</div><h3><span className="situation-waiting-player">{chooserName}</span> <span className="situation-thinking-label">придумывает ситуацию</span><span className="situation-thinking-dots"><i>.</i><i>.</i><i>.</i></span></h3><p></p></div>}</article>
      </section>
      </main>
    <SiteFooter />
  </main>
}

function ActionRevealScreen({ room, role, isHost, onContinue, onRetry, onBack }) {
  const [showErrorDetails, setShowErrorDetails] = useState(false)
  const ready = Boolean(room.actionRevealReady?.[role])
  const verdictReady = Boolean(room.verdict)
  const aiError = room.aiError
  const player1 = getProfile(room, 'creator')
  const player2 = getProfile(room, 'waiting')
  const player1Ready = Boolean(room.actionRevealReady?.creator)
  const player2Ready = Boolean(room.actionRevealReady?.waiting)
  const scenarioChooser = getScenarioChooser(room)
  const scenarioAuthor = displayName(room, scenarioChooser)
  const readyCount = Number(player1Ready) + Number(player2Ready)
  const roundNumber = String(room.currentRound || 1).padStart(2, '0')
  const totalRounds = Number(room.totalRounds || TOTAL_ROUNDS)
  const totalRoundsLabel = String(totalRounds).padStart(2, '0')
  return <ScreenFrame eyebrow="ПРОСМОТР ДЕЙСТВИЙ" title="Ваши действия" onBack={onBack}><section className="action-reveal-stage"><style>{`
          .action-reveal-stage { animation: action-reveal-stage-in .7s ease .3s both; -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); background: rgba(0,0,0,.6); box-sizing: border-box; border: 1px solid rgba(63,63,70,.8); border-radius: 16px; box-shadow: none; color: #f4f4f5; margin: 0 auto 58px; max-width: 1180px; padding: clamp(24px, 4vw, 42px); position: relative; width: 100%; z-index: 1; }
          @keyframes action-reveal-stage-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } } @keyframes action-reveal-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } } @keyframes action-reveal-from-left { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } } @keyframes action-reveal-from-right { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } } .action-reveal-meta { animation: action-reveal-rise .5s ease .12s both; } .action-reveal-player { opacity: 0; } .action-reveal-player:first-child { animation: action-reveal-from-left .55s ease .25s both; } .action-reveal-player:last-child { animation: action-reveal-from-right .55s ease .35s both; } .action-reveal-actions { animation: action-reveal-rise .55s ease .5s both; }
          .action-reveal-meta { align-items: center; display: flex; justify-content: space-between; margin-bottom: 28px; } .action-reveal-description { align-items: center; color: #ef4444; display: flex; font: 600 14px/1.4 ui-monospace, SFMono-Regular, monospace; gap: 8px; justify-content: flex-start; letter-spacing: .12em; margin: 0; text-transform: uppercase; } .action-reveal-description svg { flex: 0 0 14px; } .action-reveal-author { align-items: center; color: #9ca3af; display: flex; flex-wrap: wrap; font: 15px/1.4 ui-monospace, SFMono-Regular, monospace; gap: 10px; justify-content: flex-end; letter-spacing: .06em; text-transform: uppercase; } .action-reveal-author strong { align-items: center; color: #bef264; display: inline-flex; flex: 0 0 auto; font-size: 17px; gap: 5px; white-space: nowrap; }
          .action-reveal-cards { align-items: start; display: grid; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); position: relative; }
          .action-reveal-cards::after { background: rgba(255,255,255,.13); content: ''; height: 100%; left: 50%; position: absolute; top: 0; transform: translateX(-50%); width: 1px; }
          .action-reveal-player { background: rgba(15,17,22,.86); border: 1px solid rgba(255,255,255,.1); border-radius: 4px; min-height: 300px; padding: 24px; position: relative; }
          .action-reveal-player { border-top: 2px solid #bef264; }
          .action-reveal-player.is-dead { border-top-color: #ef4444; }
          .action-reveal-player-heading { align-items: center; display: flex; gap: 14px; }
          .action-reveal-player-avatar { align-items: center; background: #090b0e; border: 1px solid rgba(255,255,255,.2); border-radius: 50%; color: #f4f4f5; display: flex; flex: 0 0 52px; font-size: 30px; height: 52px; justify-content: center; line-height: 1; width: 52px; }
          .action-reveal-player .action-reveal-player-avatar { border-color: rgba(190,242,100,.7); color: #bef264; }
          .action-reveal-player.is-dead .action-reveal-player-avatar { border-color: rgba(239,68,68,.7); color: #f87171; }
          .action-reveal-player-heading span { color: #71717a; display: block; font: 10px/1 ui-monospace, SFMono-Regular, monospace; letter-spacing: .14em; text-transform: uppercase; }
          .action-reveal-player-heading strong { color: #f4f4f5; display: block; font: 400 24px/1.1 Georgia, serif; margin-top: 7px; overflow-wrap: anywhere; }
          .action-reveal-action-copy { background: #090b0e; border: 1px solid rgba(255,255,255,.06); border-radius: 2px; color: #f4f4f5; font: 18px/1.5 ui-monospace, SFMono-Regular, monospace; margin: 24px 0 0; min-height: 112px; padding: 20px; overflow-wrap: anywhere; } .action-reveal-player .action-reveal-action-copy { border-left: 2px solid #bef264; } .action-reveal-player.is-dead .action-reveal-action-copy { border-left-color: #ef4444; }
          .action-reveal-ready { align-items: center; color: #9ca3af; display: grid; font: 600 12px/1.3 ui-monospace, SFMono-Regular, monospace; gap: 8px; grid-template-columns: 28px auto 1fr; letter-spacing: .1em; margin-top: 12px; text-transform: uppercase; }
          .action-reveal-ready-mark { align-items: center; border: 1px solid #ef4444; border-radius: 50%; color: #ef4444; display: flex; height: 28px; justify-content: center; width: 28px; }
          .action-reveal-player:last-child .action-reveal-ready-mark { border-color: #bef264; color: #bef264; }
          .action-reveal-player .action-reveal-ready { color: #bef264; }
          .action-reveal-player.is-dead .action-reveal-ready { color: #ef4444; }
          .action-reveal-player .action-reveal-ready-mark { border-color: #bef264; color: #bef264; box-shadow: 0 0 7px rgba(190,242,100,.42); }
          .action-reveal-player.is-dead .action-reveal-ready-mark { border-color: #ef4444; color: #ef4444; box-shadow: 0 0 7px rgba(239,68,68,.42); }
          .action-reveal-ready.is-ready { color: inherit; } .action-reveal-char-count { color: inherit; font: 600 11px/1.3 ui-monospace, SFMono-Regular, monospace; grid-column: 3; letter-spacing: .08em; text-align: right; } .action-reveal-player .action-reveal-char-count { color: #bef264; } .action-reveal-player.is-dead .action-reveal-char-count { color: #ef4444; }
          .action-reveal-actions { align-items: center; display: flex; gap: 18px; justify-content: space-between; margin-top: 18px; padding-top: 18px; position: relative; } .action-reveal-actions::before { background: #ef4444; content: ''; height: 2px; left: 0; opacity: .7; position: absolute; right: 0; top: 0; } .action-reveal-round-progress { color: #9ca3af; font: 600 12px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .1em; text-transform: uppercase; } .action-reveal-round-dots { display: flex; gap: 7px; margin-top: 12px; } .action-reveal-round-dot { border: 1px solid rgba(255,255,255,.25); border-radius: 50%; height: 8px; width: 8px; } .action-reveal-round-dot.is-active { background: radial-gradient(circle, #ef4444 0 2px, transparent 2.5px); border-color: #ef4444; box-shadow: 0 0 0 2px rgba(239,68,68,.15), 0 0 8px rgba(239,68,68,.7); height: 10px; width: 10px; } .action-reveal-fate-wrap { align-items: flex-end; display: flex; flex-direction: column; gap: 8px; } .action-reveal-ready-count { color: #ccff00; font: 600 12px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .08em; text-transform: uppercase; }
          .action-reveal-fate-button { align-items: center; display: inline-flex; font: 700 13px/1.2 ui-monospace, SFMono-Regular, monospace; gap: 8px; letter-spacing: .08em; min-height: 42px; text-transform: uppercase; }
                    .action-reveal-fate-button { background: #ccff00; border: 1px solid #ccff00; border-radius: 3px; color: #090b0e; font-size: 13px; justify-content: center; min-width: 260px; padding: 0 26px; transition: background .2s ease, transform .2s ease; }
          .action-reveal-fate-button:hover:not(:disabled) { background: #b8e600; transform: translateY(-1px); }
          .action-reveal-fate-button:disabled { cursor: not-allowed; filter: grayscale(.5); opacity: .55; }
          .action-reveal-error { background: rgba(69,10,10,.42); border: 1px solid rgba(239,68,68,.5); color: #fca5a5; margin-top: 18px; padding: 16px; }
          .action-reveal-error > strong, .action-reveal-error > span { display: block; }
          .action-reveal-error > strong { color: #fecaca; font: 400 18px/1.2 Georgia, serif; }
          .action-reveal-error > span { font: 12px/1.5 ui-monospace, SFMono-Regular, monospace; margin-top: 7px; }
          @media (max-width: 760px) { .action-reveal-stage { margin-bottom: 36px; padding: 20px 16px; } .action-reveal-meta { align-items: flex-start; flex-direction: column; gap: 16px; } .action-reveal-author { justify-content: flex-start; } .action-reveal-cards { grid-template-columns: 1fr; } .action-reveal-cards::after { display: none; } .action-reveal-player { min-height: 0; padding: 20px; } .action-reveal-actions { align-items: stretch; flex-direction: column; } .action-reveal-fate-button { justify-content: center; width: 100%; } .action-reveal-fate-wrap { align-items: stretch; } .action-reveal-ready-count { text-align: center; } }
          @media (max-width: 420px) { .action-reveal-player-heading strong { font-size: 21px; } .action-reveal-action-copy { font-size: 18px; min-height: 96px; padding: 18px; } .action-reveal-player-avatar { flex-basis: 48px; height: 48px; width: 48px; } }
        `}</style><div className="action-reveal-meta"><div className="action-reveal-description"><Shield size={14} aria-hidden="true" /><span>Решения раскрыты</span></div><div className="action-reveal-author"><span>АВТОР СЦЕНАРИЯ:</span><strong><Crown size={12} /> {scenarioAuthor}</strong></div></div><div className="action-reveal-cards"><ActionRevealPlayer profile={player1} action={room.actions?.creator} isReady={player1Ready} isYou={role === 'creator'} /><ActionRevealPlayer profile={player2} action={room.actions?.waiting} isReady={player2Ready} isYou={role === 'waiting'} /></div>{aiError && <div className="action-reveal-error"><strong>ИИ не смог подготовить историю</strong><span>{aiError.message}</span><div className="ai-error-actions">{isHost && <button className="secondary-button" onClick={onRetry}>🔄 Попробовать сгенерировать снова</button>}<button className="text-button" onClick={() => setShowErrorDetails((value) => !value)}>📋 Детали ошибки</button></div>{showErrorDetails && <pre className="ai-error-details">{JSON.stringify(aiError, null, 2)}</pre>}</div>}<div className="action-reveal-actions"><div className="action-reveal-round-progress"><span>РАУНД {roundNumber} ИЗ {totalRoundsLabel}</span><div className="action-reveal-round-dots">{Array.from({ length: totalRounds }, (_, index) => <span className={`action-reveal-round-dot ${index + 1 === Number(roundNumber) ? 'is-active' : ''}`} key={index} />)}</div></div><div className="action-reveal-fate-wrap"><button className="action-reveal-fate-button" type="button" disabled={!verdictReady || ready} onClick={onContinue}>{ready ? 'ОЖИДАНИЕ СОПЕРНИКА...' : verdictReady ? 'УЗНАТЬ СУДЬБУ' : 'ИИ ПИШЕТ ИСТОРИЮ...'} <ArrowRight size={17} /></button><span className="action-reveal-ready-count">{readyCount}/2 ИГРОКОВ ГОТОВЫ</span></div></div></section></ScreenFrame>
}

function ActionRevealPlayer({ profile, action, isReady, isYou }) {
  return <article className="action-reveal-player"><header className="action-reveal-player-heading"><div className="action-reveal-player-avatar">{profile.avatar}</div><div><strong>{profile.nickname}{isYou ? ' (Вы)' : ''}</strong></div></header><p className="action-reveal-action-copy">{action || 'Игрок ничего не делает и просто стоит на месте'}</p><div className={`action-reveal-ready ${isReady ? 'is-ready' : ''}`}><span className="action-reveal-ready-mark"><Check size={16} strokeWidth={2.5} /></span><span>ГОТОВ</span><span className="action-reveal-char-count">СИМВОЛОВ: {(action || '').length}</span></div></article>
}

function WaitingCard({ text }) { return <div className="waiting-card"><div className="waiting-spinner"><Users size={25} /></div><strong>{text}</strong><span>.</span></div> }

function MutatorBanner({ mutator }) {
  return <div className="mutator-banner"><span className="mutator-icon">{mutator.icon}</span><div><span className="mutator-kicker">Событие раунда</span><strong>{mutator.name}</strong><p>{mutator.description}</p>{mutator.key === 'forbidden_letter' && <p>Запрещённая буква: <b>{mutator.forbiddenLetter}</b>. Каждое употребление отнимает Рассудок.</p>}{mutator.key === 'd20_mode' && <p>Броски: Игрок 1 — <b>{mutator.rolls?.creator}</b>, Игрок 2 — <b>{mutator.rolls?.waiting}</b>.</p>}{mutator.key === 'escort_mission' && <p>VIP этого раунда: <b>{mutator.vipRole === 'creator' ? 'Игрок 1' : 'Игрок 2'}</b>.</p>}</div></div>
}

function CustomSelect({ value, onChange, options = [], label, disabled = false, readOnly = false, children }) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef(null)
  const isReadOnly = disabled || readOnly
  const childOptions = children ? (Array.isArray(children) ? children : [children]).filter(Boolean).map((option) => ({ value: option.props.value, label: option.props.children })) : []
  const selectOptions = options.length ? options : childOptions
  const selectedOption = selectOptions.find((option) => String(option.value) === String(value)) || selectOptions[0]

  useEffect(() => {
    const handleOutsideMouseDown = (event) => {
      if (!containerRef.current?.contains(event.target)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideMouseDown)
    return () => document.removeEventListener('mousedown', handleOutsideMouseDown)
  }, [])

  const choose = (nextValue) => {
    if (isReadOnly) return
    onChange?.({ target: { value: nextValue } })
    setIsOpen(false)
  }

  return <div className={`custom-select ${isOpen ? 'custom-select--open' : ''} ${isReadOnly ? 'custom-select--disabled' : ''}`} ref={containerRef}>
    {label && <span className="custom-select-label">{label}</span>}
    <button type="button" className={`custom-select-trigger ${isOpen ? 'custom-select-trigger--open' : ''}`} disabled={isReadOnly} aria-haspopup="listbox" aria-expanded={isOpen} onClick={() => !isReadOnly && setIsOpen((open) => !open)}><span>{selectedOption?.label || value}</span><span className={`custom-select-chevron ${isOpen ? 'custom-select-chevron--open' : ''}`} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg></span></button>
    {isOpen && <div className="custom-select-menu custom-scrollbar" role="listbox">{selectOptions.map((option) => <button type="button" role="option" aria-selected={String(option.value) === String(value)} className={`custom-select-option ${String(option.value) === String(value) ? 'custom-select-option--selected' : ''}`} key={String(option.value)} onClick={() => choose(option.value)}>{option.label}</button>)}</div>}
  </div>
}

function SettingsPanel({ settings, readOnly, onChange }) {
  const update = (key, value) => onChange?.({ ...settings, [key]: value })
  const toggleMutator = (key) => update('disabledMutators', settings.disabledMutators.includes(key) ? settings.disabledMutators.filter((item) => item !== key) : [...settings.disabledMutators, key])
  const options = (values) => values.map(([value, label]) => ({ value, label }))
  const totalRoundsOptions = options([['3', '3 раунда'], ['5', '5 раундов'], ['7', '7 раундов']])
  const awardOptions = options([['5', '5 секунд'], ['8', '8 секунд'], ['12', '12 секунд'], ['click', 'По клику']])
  const timerOptions = options([['30', '30 секунд'], ['45', '45 секунд'], ['60', '60 секунд'], ['0', 'Без времени']])
  const chanceOptions = options([['0', '0%'], ['25', '25%'], ['50', '50%'], ['75', '75%'], ['100', '100%']])
  const speechOptions = options([['1', '1.0x'], ['1.25', '1.25x'], ['1.5', '1.5x']])
  const styleOptions = options([['black_humor', 'Чёрный Юмор & Ирония'], ['epic_fantasy', 'Эпик & Фэнтези'], ['noir_detective', 'Нуар & Детектив'], ['full_absurd', 'Полный Абсурд']])
  const mutatorOptions = [{ value: RANDOM_MUTATOR, label: 'Случайно' }, { value: NO_MUTATOR, label: 'Без события' }, ...MUTATORS.map((mutator) => ({ value: mutator.key, label: `${mutator.icon} ${mutator.name}` }))]
  return <section className={`settings-panel ${readOnly ? 'settings-panel--readonly' : ''}`}><div className="settings-heading"><div><span className="section-kicker">Параметры лобби</span><h2>{readOnly ? 'Настройки комнаты' : 'Настройки Хоста'}</h2></div>{readOnly && <span className="readonly-badge">Только просмотр</span>}</div><label className="setting-field">Количество раундов<CustomSelect disabled={readOnly} value={settings.totalRounds} options={totalRoundsOptions} onChange={(event) => update('totalRounds', Number(event.target.value))} /></label><fieldset className="round-mutator-planner"><legend>События по раундам</legend>{Array.from({ length: settings.totalRounds }, (_, index) => <label className="setting-field" key={index}>Раунд {index + 1}<CustomSelect disabled={readOnly} value={(settings.roundMutators || [])[index] || RANDOM_MUTATOR} options={mutatorOptions} onChange={(event) => update('roundMutators', createRoundMutatorPlan(settings.totalRounds, settings.roundMutators).map((value, itemIndex) => itemIndex === index ? event.target.value : value))} /></label>)}</fieldset><label className="setting-field settings-animation-field"><span className="settings-animation-description">Время между номинациями</span><CustomSelect disabled={readOnly} value={settings.awardInterval} options={awardOptions} onChange={(event) => update('awardInterval', event.target.value === 'click' ? 'click' : Number(event.target.value))} /></label><label className="setting-field">Таймер хода<CustomSelect disabled={readOnly} value={settings.turnTimer} options={timerOptions} onChange={(event) => update('turnTimer', Number(event.target.value))} /></label><label className="setting-field">Шанс мутаторов<CustomSelect disabled={readOnly} value={settings.mutatorChance} options={chanceOptions} onChange={(event) => update('mutatorChance', Number(event.target.value))} /></label><label className="setting-field">Скорость озвучки ИИ<CustomSelect disabled={readOnly} value={settings.ttsRate} options={speechOptions} onChange={(event) => update('ttsRate', Number(event.target.value))} /></label><label className="setting-field">Стиль ИИ-ведущего<CustomSelect disabled={readOnly} value={settings.hostStyle} options={styleOptions} onChange={(event) => update('hostStyle', event.target.value)} /></label><fieldset className="mutator-options"><legend>Доступные события</legend>{MUTATORS.map((mutator) => <label key={mutator.key}><input type="checkbox" disabled={readOnly} checked={!settings.disabledMutators.includes(mutator.key)} onChange={() => toggleMutator(mutator.key)} /> <span>{mutator.icon} {mutator.name}</span></label>)}</fieldset></section>
}
/*
  const update = (key, value) => onChange?.({ ...settings, [key]: value })
  const toggleMutator = (key) => update('disabledMutators', settings.disabledMutators.includes(key) ? settings.disabledMutators.filter((item) => item !== key) : [...settings.disabledMutators, key])
  return <section className={`settings-panel ${readOnly ? 'settings-panel--readonly' : ''}`}><div className="settings-heading"><div><span className="section-kicker">Параметры лобби</span><h2>{readOnly ? 'Настройки комнаты' : 'Настройки Хоста'}</h2></div>{readOnly && <span className="readonly-badge">Только просмотр</span>}</div><label className="setting-field">Количество раундов<select disabled={readOnly} value={settings.totalRounds} onChange={(event) => update('totalRounds', Number(event.target.value))}><option value="3">3 раунда</option><option value="5">5 раундов</option><option value="7">7 раундов</option></select></label><fieldset className="round-mutator-planner"><legend>События по раундам</legend>{Array.from({ length: settings.totalRounds }, (_, index) => <label className="setting-field" key={index}>Раунд {index + 1}<select disabled={readOnly} value={(settings.roundMutators || [])[index] || RANDOM_MUTATOR} onChange={(event) => update('roundMutators', createRoundMutatorPlan(settings.totalRounds, settings.roundMutators).map((value, itemIndex) => itemIndex === index ? event.target.value : value))}><option value={RANDOM_MUTATOR}>🎲 Случайно (50% шанс)</option><option value={NO_MUTATOR}>❌ Без события</option>{MUTATORS.map((mutator) => <option key={mutator.key} value={mutator.key}>{mutator.icon} {mutator.name}</option>)}</select></label>)}</fieldset><label className="setting-field"><span className="settings-animation-label">ВРЕМЯ АНИМАЦИЙ</span>Время между номинациями<select disabled={readOnly} value={settings.awardInterval} onChange={(event) => update('awardInterval', event.target.value === 'click' ? 'click' : Number(event.target.value))}><option value="5">5 секунд</option><option value="8">8 секунд</option><option value="12">12 секунд</option><option value="click">По кнопке продолжить</option></select></label><label className="setting-field">Таймер хода<select disabled={readOnly} value={settings.turnTimer} onChange={(event) => update('turnTimer', Number(event.target.value))}><option value="30">30 секунд</option><option value="45">45 секунд</option><option value="60">60 секунд</option><option value="0">Без времени</option></select></label><label className="setting-field">Шанс мутаторoв<select disabled={readOnly} value={settings.mutatorChance} onChange={(event) => update('mutatorChance', Number(event.target.value))}><option value="0">0%</option><option value="25">25%</option><option value="50">50%</option><option value="75">75%</option><option value="100">100%</option></select></label><fieldset className="mutator-options"><legend>Доступные события</legend>{MUTATORS.map((mutator) => <label key={mutator.key}><input type="checkbox" disabled={readOnly} checked={!settings.disabledMutators.includes(mutator.key)} onChange={() => toggleMutator(mutator.key)} /> <span>{mutator.icon} {mutator.name}</span></label>)}</fieldset><label className="setting-field"><select disabled={readOnly} value={settings.awardInterval} onChange={(event) => update('awardInterval', event.target.value === 'click' ? 'click' : Number(event.target.value))}><option value="2">Быстро — 2 секунды</option><option value="3.5">Стандарт — 3,5 секунды</option><option value="5">Медленно — 5 секунд</option><option value="click">По клику — кнопка «Дальше»</option></select></label><label className="setting-field">Скорость озвучки ИИ<select disabled={readOnly} value={settings.ttsRate} onChange={(event) => update('ttsRate', Number(event.target.value))}><option value="1">1.0x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option></select></label><label className="setting-field">Стиль ИИ-ведущего<select disabled={readOnly} value={settings.hostStyle} onChange={(event) => update('hostStyle', event.target.value)}><option value="black_humor">😼 Чёрный Юмор &amp; Ирония</option><option value="epic_fantasy">🗡 Эпик &amp; Фэнтези</option><option value="noir_detective">🕵️ Нуар &amp; Детектив</option><option value="full_absurd">🤡 Полный Абсурд</option></select></label><label className="setting-toggle"><input type="checkbox" disabled={readOnly} checked={settings.blindMode} onChange={(event) => update('blindMode', event.target.checked)} /> <span><strong>Скрывать ввод соперника</strong><small>Blind Mode — полная секретность действий</small></span></label></section>
}

*/
function getVitalityColor(value) {
  const normalized = Math.max(0, Math.min(100, Number(value) || 0)) / 100
  return `hsl(${Math.round(normalized * 120)} 90% 52%)`
}

function getVitalityLevel(value) {
  const normalized = Math.max(0, Math.min(100, Number(value) || 0))
  if (normalized <= 25) return 'critical'
  if (normalized <= 50) return 'warning'
  if (normalized <= 75) return 'caution'
  return 'healthy'
}

function PlayerVitals({ label, state, changes, average, hideHeading = false }) {
  const hpChange = changes?.hpChange || 0
  const sanityChange = changes?.sanityChange || 0
  const hpColor = getVitalityColor(state.hp)
  const sanityColor = getVitalityColor(state.sanity)
  return <div className="player-vitals">{!hideHeading && <div className="vitals-heading"><strong>{label}</strong><span className={state.status === 'DEAD' ? 'vitals-dead' : 'vitals-alive'}>{state.status === 'DEAD' ? 'Погиб' : 'В строю'}</span></div>}{average ? <div className="vitals-average"><span className={`vitals-average-item vitality-${getVitalityLevel(average.hp)}`}><small><Heart size={15} aria-hidden="true" /> Среднее здоровье:</small><b>{average.hp} / 100</b></span><span className={`vitals-average-item vitality-${getVitalityLevel(average.sanity)}`}><small><Brain size={15} aria-hidden="true" /> Средний рассудок:</small><b>{average.sanity} / 100</b></span></div> : <><div className="vital-row vital-row--health" style={{ color: hpColor }}><span><Heart size={14} /> Здоровье</span><b>{state.hp} / 100</b></div><div className="vital-track vital-track--hp"><span style={{ width: `${state.hp}%`, background: hpColor, boxShadow: `0 0 8px ${hpColor}` }} /></div>{hpChange !== 0 && <em className="vital-change" style={{ color: hpColor }}>{hpChange > 0 ? '+' : ''}{hpChange} Здоровье</em>}<div className="vital-row vital-row--sanity" style={{ color: sanityColor }}><span><Brain size={14} /> Рассудок</span><b>{state.sanity} / 100</b></div><div className="vital-track vital-track--sanity"><span style={{ width: `${state.sanity}%`, background: sanityColor, boxShadow: `0 0 8px ${sanityColor}` }} /></div>{sanityChange !== 0 && <em className="vital-change vital-change--sanity" style={{ color: sanityColor }}>{sanityChange > 0 ? '+' : ''}{sanityChange} Рассудок</em>}</>}</div>
}

function VerdictPlayerCard({ profile, action, label, isYou, state, changes, status }) {
  return <article className={`verdict-player-card ${status === 'DEAD' ? 'is-dead' : ''}`}><header className="verdict-player-card-heading"><div className="verdict-player-card-avatar">{profile.avatar}</div><div><span>ИГРОК</span><strong>{label}{isYou ? ' (Вы)' : ''}</strong></div><b className={status === 'ALIVE' ? 'verdict-status--alive' : 'verdict-status--dead'}>{status === 'ALIVE' ? 'ВЫЖИЛ' : 'ПОГИБ'}</b></header><p className="verdict-player-card-action">{action || 'Без действия'}</p><PlayerVitals label={label} state={state} changes={changes} hideHeading /></article>
}

function MatchHistoryScreen({ room, role, onAwards, onBack }) {
  const history = room.matchHistory || []
  const completedAt = room.matchCompletedAt || room.createdAt || Date.now()
  const startedAt = room.matchStartedAt || completedAt
  const matchDuration = formatMatchDuration(completedAt - startedAt)
  const matchDate = formatMatchDate(completedAt)
  const playerCount = room.players || Object.keys(room.profiles || {}).length || 2
  const gameMode = getGameModeLabel(room.gameMode || room.matchConfig?.gameMode)
  return <ScreenFrame eyebrow="Хроника" title="Хроника Матча" onBack={onBack}><section className="match-history-screen"><style>{`
    .match-history-shell { background: url('/ui/bg/bg-lethal_v3.png') center / cover no-repeat fixed; box-sizing: border-box; display: flex; flex-direction: column; min-height: 100vh; overflow-x: hidden; padding: 24px 48px; }
    .match-history-shell .site-footer { box-sizing: border-box; flex-shrink: 0; }
    @keyframes match-history-heading-rise { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes match-history-title-in { from { opacity: 0; transform: scale(.98) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
    @keyframes match-history-info-in { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes match-history-info-row-in { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: translateX(0); } }
    @keyframes match-history-round-content-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes match-history-awards-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
    .match-history-shell .screen-heading { margin: 58px auto 28px; max-width: 1280px; width: 100%; }
    .match-history-shell .screen-heading .eyebrow { align-items: center; animation: match-history-heading-rise .5s ease .1s both; color: #ef4444; display: flex; font: 700 14px/1.3 ui-monospace, SFMono-Regular, monospace; gap: 12px; letter-spacing: .12em; opacity: 0; text-transform: uppercase; }
    .match-history-shell .screen-heading h1 { animation: match-history-title-in .55s ease .2s both; opacity: 0; }
    .match-history-shell .screen-heading .eyebrow span { display: none; }
    .match-history-shell .screen-heading .eyebrow::before, .match-history-shell .screen-heading .eyebrow::after { background: #ef4444; content: ''; display: block; flex: 0 0 48px; height: 1px; }
    .match-history-shell .screen-heading h1 { color: #f4f4f5; font: 400 clamp(60px, 8vw, 96px)/.96 Georgia, serif; letter-spacing: normal; margin: 24px 0 12px; }
    .match-history-shell .match-history-screen { background: transparent !important; border: 0; box-sizing: border-box; color: #f4f4f5; display: flex; flex-direction: column; gap: 18px; margin: 0 auto 58px; max-width: 1180px; padding: 0; position: relative; width: 100%; z-index: 1; }
    .match-history-shell .match-history-intro { color: #ccff00; font: 16px/1.6 ui-monospace, SFMono-Regular, monospace; margin: 0 0 4px; max-width: 820px; }
    .match-history-shell .match-info-card { -webkit-backdrop-filter: blur(14px); animation: match-history-info-in .6s ease .5s both; backdrop-filter: blur(14px); background: rgba(0,0,0,.6); border: 1px solid rgba(63,63,70,.8); border-radius: 16px; box-sizing: border-box; margin-top: 2px; opacity: 0; padding: 28px 30px; width: 100%; }
    .match-history-shell .match-info-title { border-bottom: 1px solid rgba(255,255,255,.14); color: #ccff00; font: 700 16px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .12em; margin: 0 0 22px; padding-bottom: 16px; text-transform: uppercase; }
    .match-history-shell .match-info-row { animation: match-history-info-row-in .45s ease both; opacity: 0; }
    .match-history-shell .match-info-row:nth-child(1) { animation-delay: .68s; }
    .match-history-shell .match-info-row:nth-child(2) { animation-delay: .78s; }
    .match-history-shell .match-info-row:nth-child(3) { animation-delay: .88s; }
    .match-history-shell .match-info-row:nth-child(4) { animation-delay: .98s; }
    .match-history-shell .match-info-list { display: flex; flex-direction: column; gap: 18px; }
    .match-history-shell .match-info-row { align-items: center; display: grid; gap: 14px; grid-template-columns: 24px minmax(0, 1fr); }
    .match-history-shell .match-info-row svg { color: #bef264; height: 22px; width: 22px; }
    .match-history-shell .match-info-row small, .match-history-shell .match-info-row strong { display: block; font: 11px/1.3 ui-monospace, SFMono-Regular, monospace; }
    .match-history-shell .match-info-row small { color: #bef264; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; }
    .match-history-shell .match-info-row strong { color: #f4f4f5; font-size: 17px; font-weight: 500; margin-top: 4px; }
    .match-history-shell .match-info-row--mode strong { color: #f4f4f5; }
    .match-history-shell .match-history-list { display: flex; flex-direction: column; gap: 16px; }
    .match-history-shell .match-history-card { -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); background: rgba(0,0,0,.6); border: 1px solid rgba(63,63,70,.8); border-radius: 16px; color: #f4f4f5; overflow: hidden; transition: border-color .25s ease, box-shadow .25s ease; }
    .match-history-shell .match-history-card[open] { border-color: rgba(204,255,0,.9); box-shadow: 0 0 0 1px rgba(204,255,0,.16), 0 0 18px rgba(204,255,0,.1); }
    .match-history-shell .match-history-card summary { align-items: center; cursor: pointer; display: flex; gap: 18px; justify-content: space-between; list-style: none; padding: 20px 24px; }
    .match-history-shell .match-history-card summary::-webkit-details-marker { display: none; }
    .match-history-shell .match-history-card summary span { color: #ccff00; font: 600 12px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .1em; text-transform: uppercase; }
    .match-history-shell .match-history-card summary strong { color: #f4f4f5; font: 400 22px/1.1 Georgia, serif; text-align: right; }
    .match-history-shell .match-history-card summary strong .match-history-mutator-icon { color: #bef264; display: inline-block; font: inherit; font-size: 20px; letter-spacing: normal; margin-right: 9px; text-transform: none; vertical-align: -1px; }
    .match-history-shell .match-history-content { border-top: 1px solid rgba(255,255,255,.1); display: flex; flex-direction: column; gap: 18px; padding: 24px; }
    .match-history-shell .match-history-card[open] .history-actions, .match-history-shell .match-history-card[open] .history-story, .match-history-shell .match-history-card[open] .history-results { animation: match-history-round-content-in .5s ease both; opacity: 0; }
    .match-history-shell .match-history-card[open] .history-actions { animation-delay: .12s; }
    .match-history-shell .match-history-card[open] .history-story { animation-delay: .24s; }
    .match-history-shell .match-history-card[open] .history-results { animation-delay: .36s; }
    .match-history-shell .history-actions, .match-history-shell .history-results { display: grid; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .match-history-shell .history-actions article { animation: match-history-round-content-in .45s ease both; background: rgba(0,0,0,.5); border: 1px solid rgba(63,63,70,.8); border-left: 2px solid #bef264; border-radius: 8px; min-width: 0; opacity: 0; padding: 18px; }
    .match-history-shell .history-actions article:nth-child(2) { animation-delay: .2s; }
    .match-history-shell .history-results .history-result { animation: match-history-round-content-in .45s ease both; opacity: 0; }
    .match-history-shell .history-results .history-result:nth-child(2) { animation-delay: .16s; }
    .match-history-shell .history-actions article span { color: #ccff00; font: 600 10px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .12em; text-transform: uppercase; }
    .match-history-shell .history-actions article p { color: #f4f4f5; font: 16px/1.5 ui-monospace, SFMono-Regular, monospace; margin: 12px 0 0; overflow-wrap: anywhere; }
    .match-history-shell .history-story { background: rgba(0,0,0,.5); border: 1px solid rgba(63,63,70,.8); border-left: 2px solid #ccff00; border-radius: 8px; color: #f4f4f5; font: 18px/1.6 ui-monospace, SFMono-Regular, monospace; margin: 0; padding: 22px; }
    .match-history-shell .history-result { background: rgba(0,0,0,.5); border: 1px solid rgba(63,63,70,.8); border-radius: 8px; display: flex; flex-direction: column; gap: 14px; padding: 18px; }
    .match-history-shell .history-result-heading { align-items: center; display: flex; gap: 12px; justify-content: space-between; }
    .match-history-shell .history-result-player { align-items: center; display: flex; gap: 10px; min-width: 0; }
    .match-history-shell .history-result-avatar { align-items: center; background: #090b0e; border: 1px solid rgba(190,242,100,.7); border-radius: 50%; color: #bef264; display: flex; flex: 0 0 42px; font-size: 23px; height: 42px; justify-content: center; line-height: 1; width: 42px; }
    .match-history-shell .history-result-avatar.is-dead { border-color: rgba(239,68,68,.75); color: #ef4444; }
    .match-history-shell .history-result-heading strong { color: #bef264; font: 400 22px/1.1 Georgia, serif; min-width: 0; overflow-wrap: anywhere; }
    .match-history-shell .history-result-heading strong.is-dead { color: #ef4444; }
    .match-history-shell .history-result-heading span { color: #bef264; font: 700 11px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .1em; text-transform: uppercase; }
    .match-history-shell .history-result-heading span.is-dead { color: #ef4444; }
    .match-history-shell .history-result .player-vitals { width: 100%; }
    .match-history-shell .history-result .vital-row { font: 600 11px/1.3 ui-monospace, SFMono-Regular, monospace; margin-top: 8px; }
    .match-history-shell .history-result .vital-row span, .match-history-shell .history-result .vital-row svg { color: inherit !important; }
    .match-history-shell .history-result .vital-row b { color: inherit !important; font-size: 12px; }
    .match-history-shell .history-result .vital-track { background: rgba(255,255,255,.16); height: 8px; margin-top: 6px; }
    .match-history-shell .history-result .vitals-heading { display: none; }
    .match-history-shell .history-result .vital-change { display: none; }
    .match-history-shell .history-awards-button { align-self: stretch; animation: match-history-awards-in .55s ease 1.12s both; background: #ccff00; border: 1px solid #ccff00; border-radius: 8px; color: #090b0e; font: 800 18px/1 ui-monospace, SFMono-Regular, monospace; min-height: 52px; transition: background .25s ease, box-shadow .25s ease, transform .25s ease; }
    .match-history-shell .history-awards-button:hover:not(:disabled) { background: #bef264; box-shadow: 0 0 18px rgba(204,255,0,.36); transform: translateY(-2px); }
    .match-history-shell .history-awards-button svg { transition: transform .25s ease; }
    .match-history-shell .history-awards-button:hover:not(:disabled) svg { transform: translateX(4px); }
    .match-history-shell .match-history-card { animation: match-history-card-in .55s ease both; opacity: 0; }
    .match-history-shell .match-history-card:nth-child(2) { animation-delay: .1s; }
    .match-history-shell .match-history-card:nth-child(3) { animation-delay: .2s; }
    .match-history-shell .match-history-card:nth-child(4) { animation-delay: .3s; }
    @keyframes match-history-card-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
    @media (max-width: 1023px) { .match-history-shell { padding: 24px; } }
    @media (max-width: 767px) { .match-history-shell { padding: 16px; } .match-history-shell .screen-heading { margin-top: 16px; } .match-history-shell .screen-heading h1 { font-size: 36px; } .match-history-shell .match-history-screen { margin-bottom: 36px; } .match-history-shell .match-history-card summary { align-items: flex-start; flex-direction: column; gap: 10px; padding: 18px; } .match-history-shell .match-history-card summary strong { text-align: left; } .match-history-shell .match-history-content { padding: 16px; } .match-history-shell .history-actions, .match-history-shell .history-results { grid-template-columns: 1fr; } .match-history-shell .history-story { font-size: 16px; padding: 18px; } .match-history-shell .site-footer { align-items: center; flex-direction: column; gap: 16px; justify-content: center; padding: 20px 16px; text-align: center; } .match-history-shell .site-footer-links { order: 1; } .match-history-shell .site-footer-icons { order: 2; } .match-history-shell .site-footer-copy { order: 3; } }
  `}</style><div className="match-history-list">{history.map((round) => <details className="match-history-card" key={round.roundNumber} open><summary><span>Раунд {round.roundNumber}</span><strong><span className="match-history-mutator-icon" aria-hidden="true">{getHistoryMutatorIcon(round.mutator)}</span>{round.mutator?.name || 'Без события'}</strong></summary><div className="match-history-content"><div className="history-actions"><article><span>{displayName(room, 'creator')}</span><p>{round.player1Action || 'Без действия'}</p></article><article><span>{displayName(room, 'waiting')}</span><p>{round.player2Action || 'Без действия'}</p></article></div><p className="history-story">{round.verdict?.story || 'История не была сохранена.'}</p><div className="history-results"><HistoryResult label={displayName(room, 'creator')} profile={getProfile(room, 'creator')} result={round.verdict?.player1} state={round.player1} /><HistoryResult label={displayName(room, 'waiting')} profile={getProfile(room, 'waiting')} result={round.verdict?.player2} state={round.player2} /></div></div></details>)}</div><section className="match-info-card" aria-label="Информация о матче"><h2 className="match-info-title">О МАТЧЕ</h2><div className="match-info-list"><div className="match-info-row match-info-row--mode"><Gamepad2 size={16} aria-hidden="true" /><div><small>Режим</small><strong>{gameMode}</strong></div></div><div className="match-info-row"><Users size={16} aria-hidden="true" /><div><small>Игроки</small><strong>{playerCount} игрока</strong></div></div><div className="match-info-row"><Clock3 size={16} aria-hidden="true" /><div><small>Длительность</small><strong>{matchDuration}</strong></div></div><div className="match-info-row"><CalendarDays size={16} aria-hidden="true" /><div><small>Дата</small><strong>{matchDate}</strong></div></div></div></section><button className="primary-button history-awards-button" disabled={role !== 'creator'} onClick={onAwards}>Перейти к Награждению <ArrowRight size={17} /></button></section></ScreenFrame>
}

function HistoryResult({ label, profile, result, state }) {
  const currentState = {
    hp: state?.hpAfter ?? 100,
    sanity: state?.sanityAfter ?? 100,
    status: state?.statusAfter || result?.status || 'ALIVE'
  }
  const isDead = currentState.status === 'DEAD'
  return <article className="history-result"><div className="history-result-heading"><div className="history-result-player"><div className={`history-result-avatar ${isDead ? 'is-dead' : ''}`}>{profile?.avatar}</div><strong className={isDead ? 'is-dead' : ''}>{label}</strong></div><span className={isDead ? 'is-dead' : ''}>{isDead ? 'МЁРТВ' : 'ЖИВ'}</span></div><PlayerVitals label={label} state={currentState} hideHeading /></article>
}

function FinalScreen({ room, onBack, onPlayAgain }) {
  return <>
    <FinalAwardsContent room={room} onBack={onBack} onPlayAgain={onPlayAgain} />
  </>
}

function FinalAwardsContent({ room, onBack, onPlayAgain }) {
  const awards = room.awards?.awards || []
  const settings = getLobbySettings(room.settings)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isFinished, setIsFinished] = useState(false)
  const awardSignature = awards.map((award) => `${award.id}:${award.title}:${award.winner}:${award.reason}`).join('|')

  useEffect(() => {
    setCurrentIndex(0)
    setIsFinished(false)
  }, [awardSignature])

  const advanceAward = () => {
    if (currentIndex < awards.length - 1) setCurrentIndex((previousIndex) => previousIndex + 1)
    else setIsFinished(true)
  }

  useEffect(() => {
    if (awards.length === 0 || isFinished || settings.awardInterval === 'click') return undefined
    const timer = window.setTimeout(advanceAward, Number(settings.awardInterval || 3.5) * 1000)
    return () => window.clearTimeout(timer)
  }, [currentIndex, awards.length, isFinished, settings.awardInterval])

  const shownAwards = awards.slice(0, currentIndex + 1)
  const player1Cups = shownAwards.filter((award) => award.winner === 'player1' || award.winner === 'both').length
  const player2Cups = shownAwards.filter((award) => award.winner === 'player2' || award.winner === 'both').length
  const activeAward = awards[currentIndex]
  const player1State = room.player1State || INITIAL_PLAYER_STATE
  const player2State = room.player2State || INITIAL_PLAYER_STATE
  const player1Average = getAverageVitals(room.matchHistory, 'player1', player1State)
  const player2Average = getAverageVitals(room.matchHistory, 'player2', player2State)

  return <ScreenFrame eyebrow="Матч завершён" title="Церемония награждения" onBack={onBack}><style>{`\n    .awards-ceremony-shell { background: url('/ui/bg/bg-lethal_v3.png') center / cover no-repeat fixed; box-sizing: border-box; display: flex; flex-direction: column; min-height: 100vh; overflow-x: hidden; padding: 24px 48px; }\n    .awards-ceremony-shell .site-footer { box-sizing: border-box; flex-shrink: 0; margin-top: auto; }\n    .awards-ceremony-shell .screen-heading { margin: 58px auto 28px; max-width: 1280px; width: 100%; }\n    .awards-ceremony-shell .screen-heading .eyebrow { align-items: center; color: #ef4444; display: flex; gap: 12px; }\n    .awards-ceremony-shell .screen-heading .eyebrow::after { background: #ef4444; content: ''; display: block; flex: 0 0 48px; height: 1px; } .awards-ceremony-shell .screen-heading .eyebrow span { background: #ef4444; display: block; flex: 0 0 48px; height: 1px; }\n    .awards-ceremony-shell .screen-heading h1 { color: #f4f4f5; }\n    .awards-ceremony-layout { align-content: center; background: transparent; box-sizing: border-box; color: #f4f4f5; display: grid; flex: 1; gap: 18px; grid-template-columns: minmax(190px, .72fr) minmax(0, 1.7fr) minmax(190px, .72fr); margin: 0 auto 58px; max-width: 1280px; padding: 0; position: relative; width: 100%; z-index: 1; }\n    .awards-ceremony-layout::before { background: radial-gradient(circle, rgba(204,255,0,.1), transparent 68%); content: ''; height: 560px; left: 50%; pointer-events: none; position: absolute; top: 50%; transform: translate(-50%, -50%); width: 760px; }\n    .awards-ceremony-layout .award-player-card, .awards-ceremony-layout .awards-arena { -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); background: rgba(0,0,0,.6); border: 1px solid rgba(63,63,70,.8); border-radius: 16px; box-sizing: border-box; color: #f4f4f5; position: relative; }\n    .awards-ceremony-layout .award-player-card { align-items: center; border-top: 2px solid #ccff00; display: flex; flex-direction: column; min-height: 470px; padding: 30px 24px 24px; text-align: center; }\n    .awards-ceremony-layout .award-player-card--player1, .awards-ceremony-layout .award-player-card--player2 { border-top-color: #ccff00; }\n    .awards-ceremony-layout .award-player-card::after { border: 1px solid rgba(255,255,255,.05); border-radius: 12px; content: ''; inset: 7px; pointer-events: none; position: absolute; }\n    .awards-ceremony-layout .player-avatar { background: #090b0e; border: 1px solid rgba(204,255,0,.75); color: #f4f4f5; font-size: 30px; height: 68px; margin: 0 auto 18px; position: relative; width: 68px; z-index: 1; }\n    .awards-ceremony-layout .award-player-card--player1 .player-avatar, .awards-ceremony-layout .award-player-card--player2 .player-avatar { border-color: rgba(204,255,0,.75); }\n    .awards-ceremony-layout .award-player-card > span { color: #bef264; font: 700 11px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .12em; position: relative; text-transform: uppercase; z-index: 1; }\n    .awards-ceremony-layout .award-player-card > strong { color: #f4f4f5; font: 400 clamp(22px, 2vw, 28px)/1.1 Georgia, serif; margin-top: 8px; max-width: 100%; overflow-wrap: anywhere; position: relative; z-index: 1; }\n    .awards-ceremony-layout .player-vitals { margin-top: 28px; position: relative; z-index: 1; }\n    .awards-ceremony-layout .vitals-average { align-items: center; border-color: rgba(255,255,255,.12); gap: 12px; margin-top: 0; padding-top: 18px; text-align: center; width: 100%; } .awards-ceremony-layout .vitals-average span { align-items: center; display: flex; flex-direction: column; gap: 4px; }\n    .awards-ceremony-layout .vitals-average span { color: #bef264; font: 700 clamp(14px, 1.4vw, 18px)/1.4 ui-monospace, SFMono-Regular, monospace; text-shadow: 0 0 9px rgba(190,242,100,.28); } .awards-ceremony-layout .vitals-average small { align-items: center; color: inherit; display: flex; font: inherit; gap: 6px; justify-content: center; } .awards-ceremony-layout .vitals-average-item.vitality-critical { color: #ef4444; text-shadow: 0 0 10px rgba(239,68,68,.35); } .awards-ceremony-layout .vitals-average-item.vitality-warning { color: #fb923c; text-shadow: 0 0 10px rgba(251,146,60,.3); } .awards-ceremony-layout .vitals-average-item.vitality-caution { color: #facc15; text-shadow: 0 0 10px rgba(250,204,21,.3); } .awards-ceremony-layout .vitals-average-item.vitality-healthy { color: #bef264; text-shadow: 0 0 10px rgba(190,242,100,.35); }\n    .awards-ceremony-layout .vitals-average b { color: inherit; }\n    .awards-ceremony-layout .cup-counter { align-items: center; border-top: 1px solid rgba(255,255,255,.12); color: #71717a; font: 400 34px/1 Georgia, serif; gap: 10px; justify-content: center; margin-top: auto; padding-top: 22px; position: relative; width: 100%; z-index: 1; }\n    .awards-ceremony-layout .cup-icon { align-items: center; display: inline-flex; height: 19px; justify-content: center; width: 19px; } .awards-ceremony-layout .cup-counter svg { color: #71717a; } .awards-ceremony-layout .cup-counter--active .cup-icon { animation: ceremony-crown-pulse 2.8s ease-in-out infinite; }\n    .awards-ceremony-layout .cup-counter--active { color: #ccff00; } .awards-ceremony-layout .cup-counter--active .cup-icon, .awards-ceremony-layout .cup-counter--active svg { color: #ccff00; filter: drop-shadow(0 0 7px rgba(204,255,0,.45)); }\n    .awards-ceremony-layout .awards-arena { align-items: center; display: flex; flex-direction: column; min-height: 470px; overflow: hidden; padding: 34px clamp(24px, 4vw, 56px); text-align: center; }\n    .awards-ceremony-layout .awards-arena::before { background: linear-gradient(90deg, transparent, rgba(239,68,68,.8), transparent); content: ''; height: 1px; left: 15%; position: absolute; right: 15%; top: 0; }\n    .awards-ceremony-layout .awards-title { color: #ef4444; font: 700 clamp(15px, 1.5vw, 19px)/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .18em; margin-top: -10px; position: relative; text-shadow: 0 0 12px rgba(239,68,68,.28); text-transform: uppercase; }\n    .awards-ceremony-layout .award-reveal { animation: ceremony-award-in .55s ease both; display: flex; flex: 1; flex-direction: column; justify-content: center; min-width: 0; position: relative; width: 100%; }\n    .awards-ceremony-layout .award-kicker { color: #ccff00; font: 600 11px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: .12em; text-transform: uppercase; }\n    .awards-ceremony-layout .award-cup { color: #ccff00; filter: drop-shadow(0 0 12px rgba(204,255,0,.38)); margin: 24px auto 18px; }\n    .awards-ceremony-layout .award-reveal h2 { color: #f4f4f5; font: 400 clamp(30px, 4vw, 54px)/1 Georgia, serif; margin: 0; max-width: 620px; }\n    .awards-ceremony-layout .award-reveal p { color: #d4d4d8; font: 15px/1.6 ui-monospace, SFMono-Regular, monospace; margin: 18px auto 0; max-width: 560px; }\n    .awards-ceremony-layout .award-flight { color: #ccff00; margin: 24px auto 0; }\n    .awards-ceremony-layout .award-recipient { color: #bef264; font: 700 clamp(14px, 1.35vw, 18px)/1.45 ui-monospace, SFMono-Regular, monospace; letter-spacing: .08em; margin-top: 13px; text-shadow: 0 0 10px rgba(190,242,100,.35); text-transform: uppercase; }\n    .awards-ceremony-layout .award-flight--none, .awards-ceremony-layout .award-flight--none + .award-recipient { color: #71717a; }\n    .awards-ceremony-layout .award-waiting { align-items: center; color: #a1a1aa; display: flex; flex: 1; font: 400 24px/1.3 Georgia, serif; justify-content: center; }\n    .awards-ceremony-layout .award-next-button { align-self: center; border-radius: 10px; box-sizing: border-box; margin-top: 20px; max-width: 100%; min-height: 48px; padding: 0 24px; white-space: nowrap; width: 190px; } .awards-ceremony-layout .new-game-button { align-self: center; border-radius: 10px; box-sizing: border-box; margin: 22px auto 0; max-width: 100%; min-height: 48px; padding: 0 24px; white-space: nowrap; width: 190px; }n       @keyframes ceremony-award-in { from { opacity: 0; transform: translateY(18px) scale(.97); } to { opacity: 1; transform: translateY(0) scale(1); } } @keyframes ceremony-crown-pulse { 0%, 100% { filter: drop-shadow(0 0 2px rgba(204,255,0,.15)); transform: translateY(0) scale(1); } 50% { filter: drop-shadow(0 0 10px rgba(204,255,0,.65)); transform: translateY(-3px) scale(1.08); } }\n    @media (max-width: 1023px) { .awards-ceremony-shell { padding: 24px; } .awards-ceremony-layout { grid-template-columns: minmax(160px, .7fr) minmax(0, 1.5fr) minmax(160px, .7fr); } .awards-ceremony-layout .award-player-card { padding-inline: 18px; } }\n    @media (max-width: 767px) { .awards-ceremony-shell { padding: 16px; } .awards-ceremony-shell .screen-heading { margin-top: 16px; } .awards-ceremony-shell .screen-heading h1 { font-size: 36px; } .awards-ceremony-layout { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-bottom: 36px; } .awards-ceremony-layout .awards-arena { grid-column: 1 / -1; grid-row: 1; min-height: 440px; order: -1; } .awards-ceremony-layout .award-player-card { min-height: 280px; padding: 24px 18px 20px; } .awards-ceremony-layout .award-player-card > strong { font-size: 21px; } .awards-ceremony-layout .player-vitals { margin-top: 20px; } }\n    @media (max-width: 520px) { .awards-ceremony-layout { grid-template-columns: 1fr; } .awards-ceremony-layout .award-player-card { min-height: 250px; } .awards-ceremony-layout .awards-arena { min-height: 420px; padding-inline: 20px; } .awards-ceremony-layout .award-reveal h2 { font-size: 34px; } .awards-ceremony-layout .award-reveal p { font-size: 13px; } }\n  `}</style><section className="awards-layout awards-ceremony-layout"><AwardPlayerCard player="player1" profile={getProfile(room, 'creator')} name={displayName(room, 'creator')} receiving={activeAward?.winner === 'player1' || activeAward?.winner === 'both'} awardId={activeAward?.id} cups={player1Cups} state={player1State} average={player1Average} /><div key={activeAward?.id} className="awards-arena"><div className="awards-title">ЦЕРЕМОНИЯ НАГРАЖДЕНИЯ</div>{activeAward && !isFinished ? <div className="award-reveal" key={`${activeAward.id}-${currentIndex}`}><span className="award-kicker">Номинация {currentIndex + 1} / {awards.length}</span><Crown className="award-cup" size={40} /><h2>{activeAward.title}</h2><p>{activeAward.reason}</p><div className={`award-flight award-flight--${activeAward.winner}`} aria-label={`Победитель: ${activeAward.winner}`}><Crown size={20} />{activeAward.winner === 'both' && <Crown size={20} />}</div><div className={`award-recipient award-recipient--${activeAward.winner}`}>{activeAward.winner === 'player1' && `Кубок получает ${displayName(room, 'creator')}`}{activeAward.winner === 'player2' && `Кубок получает ${displayName(room, 'waiting')}`}{activeAward.winner === 'both' && `Кубки получают ${displayName(room, 'creator')} и ${displayName(room, 'waiting')}`}{activeAward.winner === 'none' && 'Кубок сгорает — никто не получает награду'}</div></div> : <div className="award-waiting">{isFinished ? 'Все кубки нашли своих героев.' : 'Ведущий подсчитывает последствия...'}</div>}{settings.awardInterval === 'click' && !isFinished && <button className="primary-button award-next-button" onClick={advanceAward}>Дальше <ArrowRight size={17} /></button>}{isFinished && <button className="primary-button new-game-button" onClick={onBack}>Ещё раз! <ArrowRight size={17} /></button>}</div><AwardPlayerCard player="player2" profile={getProfile(room, 'waiting')} name={displayName(room, 'waiting')} receiving={activeAward?.winner === 'player2' || activeAward?.winner === 'both'} awardId={activeAward?.id} cups={player2Cups} state={player2State} average={player2Average} /></section></ScreenFrame>
}

function AwardPlayerCard({ player, profile, cups, state, average, name, receiving, awardId }) {
  return <div className={`award-player-card award-player-card--${player}`}><div className="player-avatar">{profile?.avatar || <Users size={24} />}</div><span>ВЫЖИВШИЙ УЧАСТНИК</span><strong>{name || (player === 'player1' ? 'Игрок 1' : 'Игрок 2')}</strong><PlayerVitals label="" state={state} average={average} hideHeading /><div key={receiving ? `${cups}-${awardId}` : cups} className={`cup-counter ${cups ? 'cup-counter--active' : ''} ${receiving ? 'cup-counter--receiving' : ''}`}><span className="cup-icon"><Crown size={23} /></span><b>{cups}</b></div></div>
}

export default App
