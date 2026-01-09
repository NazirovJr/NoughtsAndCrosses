import './App.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getBestMove, getWinner, isDraw, type Cell, type Mark } from './lib/game'
import { generatePromoCode } from './lib/promo'
import { sendTelegram } from './lib/telegram'

const HUMAN: Mark = 'X'
const AI: Mark = 'O'

type Turn = 'human' | 'ai'
type Result = 'playing' | 'win' | 'loss' | 'draw'
type TelegramStatus = 'idle' | 'sending' | 'sent' | 'error'
type Difficulty = 'soft' | 'balanced' | 'smart'

type TelegramLinkState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; code: string; deepLink: string | null }
  | { status: 'linked'; code: string }
  | { status: 'error'; message: string }

const TG_CODE_STORAGE_KEY = 'xo_tg_link_code'
const TG_PROMPT_DISMISSED_KEY = 'xo_tg_prompt_dismissed'
const FAIL_RETRIES_LEFT_STORAGE_KEY = 'xo_fail_retries_left'
const FAIL_RETRIES_MAX = 3

function App() {
  const [board, setBoard] = useState<Cell[]>(() => Array(9).fill(null))
  const [turn, setTurn] = useState<Turn>('human')
  const [result, setResult] = useState<Result>('playing')
  const [winningLine, setWinningLine] = useState<number[] | null>(null)
  const [promoCode, setPromoCode] = useState<string | null>(null)
  const [difficulty, setDifficulty] = useState<Difficulty>('balanced')
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus>('idle')
  const [copied, setCopied] = useState(false)
  const [tgModalOpen, setTgModalOpen] = useState(false)
  const [tgLink, setTgLink] = useState<TelegramLinkState>({ status: 'idle' })
  const [endModalOpen, setEndModalOpen] = useState(false)
  const [failRetriesLeft, setFailRetriesLeft] = useState<number>(FAIL_RETRIES_MAX)

  const telegramSentRef = useRef(false)

  const lockBoard = result !== 'playing' || turn !== 'human'
  const isFailResult = result === 'loss' || result === 'draw'

  const statusText = useMemo(() => {
    if (result === 'win') return 'Победа!'
    if (result === 'loss') return 'Проигрыш'
    if (result === 'draw') return 'Ничья'
    return turn === 'human' ? 'Твой ход' : 'Ход компьютера'
  }, [result, turn])

  const statusDotClass = useMemo(() => {
    if (result === 'win') return 'dot--pink'
    if (result === 'loss') return 'dot--violet'
    return turn === 'human' ? 'dot--pink' : 'dot--violet'
  }, [result, turn])

  function resetRound() {
    setBoard(Array(9).fill(null))
    setTurn('human')
    setResult('playing')
    setWinningLine(null)
    setPromoCode(null)
    setTelegramStatus('idle')
    setCopied(false)
    telegramSentRef.current = false
    setEndModalOpen(false)
  }

  function setFailRetriesLeftPersist(next: number) {
    const safe = Math.max(0, Math.min(FAIL_RETRIES_MAX, next))
    setFailRetriesLeft(safe)
    window.localStorage.setItem(FAIL_RETRIES_LEFT_STORAGE_KEY, String(safe))
  }

  function onTryAgain() {
    if (result === 'loss' || result === 'draw') {
      if (failRetriesLeft <= 0) return
      setFailRetriesLeftPersist(failRetriesLeft - 1)
    }
    resetRound()
  }

  function onResetClick() {
    // If the game is already ended with loss/draw, treat reset as a retry (consumes attempts).
    if (result === 'loss' || result === 'draw') {
      onTryAgain()
      return
    }
    resetRound()
  }

  async function checkLinkStatus(code: string): Promise<boolean> {
    const res = await fetch(`/api/telegram/link/${encodeURIComponent(code)}`)
    if (!res.ok) return false
    const data = (await res.json().catch(() => null)) as { linked?: boolean } | null
    return Boolean(data?.linked)
  }

  async function loadExistingLink() {
    const stored = window.localStorage.getItem(TG_CODE_STORAGE_KEY)
    if (!stored) return

    setTgLink({ status: 'ready', code: stored, deepLink: null })

    const linked = await checkLinkStatus(stored)
    if (linked) {
      setTgLink({ status: 'linked', code: stored })
    }
  }

  useEffect(() => {
    // Open end modal whenever the game ends.
    if (result !== 'playing') setEndModalOpen(true)
  }, [result])

  useEffect(() => {
    loadExistingLink().then(() => {
      const dismissed = window.localStorage.getItem(TG_PROMPT_DISMISSED_KEY) === '1'
      const stored = window.localStorage.getItem(TG_CODE_STORAGE_KEY)
      if (!dismissed && !stored) setTgModalOpen(true)
    })

    const storedRetries = window.localStorage.getItem(FAIL_RETRIES_LEFT_STORAGE_KEY)
    const parsed = storedRetries ? Number.parseInt(storedRetries, 10) : NaN
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= FAIL_RETRIES_MAX) {
      setFailRetriesLeft(parsed)
    } else {
      window.localStorage.setItem(FAIL_RETRIES_LEFT_STORAGE_KEY, String(FAIL_RETRIES_MAX))
      setFailRetriesLeft(FAIL_RETRIES_MAX)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function startTelegramLink() {
    setTgLink({ status: 'loading' })
    try {
      const res = await fetch('/api/telegram/link', { method: 'POST' })
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw new Error(t || 'Failed to create link')
      }
      const data = (await res.json()) as { code: string; deepLink: string | null }
      if (!data?.code) throw new Error('Bad response')
      setTgLink({ status: 'ready', code: data.code, deepLink: data.deepLink ?? null })
    } catch (e) {
      setTgLink({
        status: 'error',
        message: 'Не удалось создать ссылку. Проверьте TELEGRAM_BOT_TOKEN на сервере.',
      })
    }
  }

  function dismissTelegramPrompt() {
    window.localStorage.setItem(TG_PROMPT_DISMISSED_KEY, '1')
    setTgModalOpen(false)
  }

  function finalizeIfEnded(nextBoard: Cell[]): boolean {
    const { winner, line } = getWinner(nextBoard)

    if (winner === HUMAN) {
      const code = generatePromoCode()
      setWinningLine(line)
      setPromoCode(code)
      setResult('win')
      return true
    }

    if (winner === AI) {
      setWinningLine(line)
      setResult('loss')
      return true
    }

    if (isDraw(nextBoard)) {
      setResult('draw')
      return true
    }

    return false
  }

  function onHumanMove(index: number) {
    if (lockBoard) return
    if (board[index] !== null) return

    const next = board.slice()
    next[index] = HUMAN
    setBoard(next)

    const ended = finalizeIfEnded(next)
    if (!ended) setTurn('ai')
  }

  function chooseAiMove(nextBoard: Cell[]): number | null {
    const empties: number[] = []
    for (let i = 0; i < nextBoard.length; i++) {
      if (nextBoard[i] === null) empties.push(i)
    }
    if (empties.length === 0) return null

    const mistakeChance =
      difficulty === 'soft' ? 0.55 : difficulty === 'balanced' ? 0.18 : 0

    if (mistakeChance > 0 && Math.random() < mistakeChance) {
      return empties[Math.floor(Math.random() * empties.length)]
    }

    return getBestMove(nextBoard, AI, HUMAN)
  }

  useEffect(() => {
    if (result !== 'playing') return
    if (turn !== 'ai') return

    const id = window.setTimeout(() => {
      setBoard((prev) => {
        if (result !== 'playing') return prev

        const move = chooseAiMove(prev)
        if (move === null) return prev

        const next = prev.slice()
        next[move] = AI

        const ended = finalizeIfEnded(next)
        if (!ended) setTurn('human')

        return next
      })
    }, 350)

    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn, result, difficulty])

  useEffect(() => {
    if (telegramSentRef.current) return

    if (result === 'win' && promoCode) {
      telegramSentRef.current = true
      setTelegramStatus('sending')
      const linkCode = tgLink.status === 'linked' ? tgLink.code : undefined
      sendTelegram({ event: 'win', promo: promoCode, linkCode })
        .then(() => setTelegramStatus('sent'))
        .catch(() => setTelegramStatus('error'))
      return
    }

    if (result === 'loss') {
      telegramSentRef.current = true
      setTelegramStatus('sending')
      const linkCode = tgLink.status === 'linked' ? tgLink.code : undefined
      sendTelegram({ event: 'loss', linkCode })
        .then(() => setTelegramStatus('sent'))
        .catch(() => setTelegramStatus('error'))
    }
  }, [result, promoCode])

  async function copyPromo() {
    if (!promoCode) return
    try {
      await navigator.clipboard.writeText(promoCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="page">
      <main className="shell">
        <header className="header">
          <div className="brand">
            <div className="brandMark" aria-hidden="true">
              xo
            </div>
            <div className="titleWrap">
              <h1>Крестики‑нолики</h1>
              <p className="subtitle">
                Сыграй против компьютера — победа принесёт промокод.
              </p>
            </div>
          </div>

          <div className="statusPill" aria-live="polite">
            <span className={`dot ${statusDotClass}`} />
            <span className="statusText">{statusText}</span>
          </div>

          <label className="difficultyPill">
            <span className="difficultyLabel">Сложность</span>
            <select
              className="difficultySelect"
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value as Difficulty)}
              aria-label="Сложность компьютера"
              disabled={result !== 'playing'}
            >
              <option value="soft">Легкий</option>
              <option value="balanced">Средний</option>
              <option value="smart">Тяжелый</option>
            </select>
          </label>

          <div className="tgPill">
            <span className="tgLabel">Telegram</span>
            {tgLink.status === 'linked' ? (
              <span className="tgOk">Подключён</span>
            ) : (
              <button
                type="button"
                className="tgBtn"
                onClick={() => setTgModalOpen(true)}
                disabled={result !== 'playing'}
              >
                Подключить
              </button>
            )}
          </div>
        </header>

        <section className="boardWrap">
          <div className="board" role="grid" aria-label="Игровое поле 3 на 3">
            {board.map((cell, idx) => {
              const isWinCell = winningLine?.includes(idx) ?? false
              const markClass =
                cell === HUMAN ? 'mark--x' : cell === AI ? 'mark--o' : ''

              return (
                <button
                  key={idx}
                  type="button"
                  className={`cell ${isWinCell ? 'cell--win' : ''}`}
                  onClick={() => onHumanMove(idx)}
                  disabled={lockBoard || cell !== null}
                  aria-label={`Клетка ${idx + 1}${cell ? `: ${cell}` : ''}`}
                >
                  <span className={`mark ${markClass}`}>{cell ?? ''}</span>
                </button>
              )
            })}
          </div>

          <div className="controls">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={onResetClick}
              disabled={isFailResult && failRetriesLeft <= 0}
            >
              Начать заново
            </button>
          </div>

          <p className="hint">
            Подсказка: в режиме «Легкий» проще победить и получить промокод.
          </p>
        </section>

        <footer className="footer">
          Если Telegram не настроен, игра всё равно работает — просто сообщение
          не уйдёт.
        </footer>

        {result !== 'playing' && endModalOpen && (
          <div className="overlay" role="dialog" aria-modal="true">
            <div className="modal">
              <div
                className={`badge ${
                  result === 'win'
                    ? 'badge--win'
                    : result === 'loss'
                      ? 'badge--loss'
                      : 'badge--draw'
                }`}
              >
                {result === 'win' ? 'Победа' : result === 'loss' ? 'Проигрыш' : 'Ничья'}
              </div>

              {result === 'win' && promoCode && (
                <>
                  <h2 className="modalTitle">Вы выиграли — держите скидку</h2>
                  <p className="modalText">Ваш промокод на скидку:</p>

                  <div className="promoRow">
                    <div className="promoCode" aria-label="Промокод">
                      {promoCode}
                    </div>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={copyPromo}
                    >
                      {copied ? 'Скопировано' : 'Скопировать'}
                    </button>
                  </div>
                </>
              )}

              {result === 'loss' && (
                <>
                  <h2 className="modalTitle">Проигрыш</h2>
                  <p className="modalText">
                    Ничего страшного — хотите сыграть ещё раз?
                  </p>
                </>
              )}

              {result === 'draw' && (
                <>
                  <h2 className="modalTitle">Ничья</h2>
                  <p className="modalText">Вы были очень близко. Ещё один раунд?</p>
                </>
              )}

              <div className="modalActions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={onTryAgain}
                  disabled={isFailResult && failRetriesLeft <= 0}
                >
                  {isFailResult
                    ? failRetriesLeft > 0
                      ? `Сыграть ещё раз (осталось ${failRetriesLeft})`
                      : 'Попытки закончились'
                    : 'Сыграть ещё раз'}
                </button>
                {isFailResult && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setEndModalOpen(false)}
                  >
                    Закрыть
                  </button>
                )}
              </div>

              {(result === 'win' || result === 'loss') && (
                <p
                  className={`telegramNote ${
                    telegramStatus === 'error' ? 'telegramNote--error' : ''
                  }`}
                >
                  {telegramStatus === 'sending' && 'Отправляем результат в Telegram…'}
                  {telegramStatus === 'sent' && 'Сообщение отправлено в Telegram.'}
                  {telegramStatus === 'error' &&
                    'Не удалось отправить в Telegram (проверьте токен/чат).'}
                </p>
              )}
            </div>
          </div>
        )}

        {result === 'playing' && tgModalOpen && (
          <div className="overlay" role="dialog" aria-modal="true">
            <div className="modal">
              <div className="badge badge--draw">Telegram (опционально)</div>
              <h2 className="modalTitle">Подключить бота?</h2>
              <p className="modalText">
                Если подключите Telegram, результат игры и промокод придут вам в чат.
              </p>

              {tgLink.status === 'idle' && (
                <div className="modalActions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={startTelegramLink}
                  >
                    Подключить Telegram
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={dismissTelegramPrompt}
                  >
                    Играть без Telegram
                  </button>
                </div>
              )}

              {tgLink.status === 'loading' && (
                <p className="telegramNote">Готовим ссылку…</p>
              )}

              {tgLink.status === 'error' && (
                <>
                  <p className="telegramNote telegramNote--error">{tgLink.message}</p>
                  <div className="modalActions">
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={startTelegramLink}
                    >
                      Попробовать ещё раз
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={dismissTelegramPrompt}
                    >
                      Закрыть
                    </button>
                  </div>
                </>
              )}

              {tgLink.status === 'ready' && (
                <>
                  <p className="modalText">
                    1) Откройте Telegram и нажмите <b>Start</b> у бота.
                    <br />
                    2) Вернитесь сюда — подключение подтвердится автоматически.
                  </p>

                  <div className="promoRow">
                    <div className="promoCode" aria-label="Код подключения">
                      {tgLink.code}
                    </div>
                    {tgLink.deepLink ? (
                      <a className="btn btn--primary" href={tgLink.deepLink} target="_blank">
                        Открыть Telegram
                      </a>
                    ) : (
                      <button type="button" className="btn btn--primary" disabled>
                        Открыть Telegram
                      </button>
                    )}
                  </div>

                  <TelegramLinkPoller
                    code={tgLink.code}
                    onLinked={() => {
                      window.localStorage.setItem(TG_CODE_STORAGE_KEY, tgLink.code)
                      setTgLink({ status: 'linked', code: tgLink.code })
                      setTgModalOpen(false)
                    }}
                  />

                  <div className="modalActions">
                    <button type="button" className="btn btn--ghost" onClick={dismissTelegramPrompt}>
                      Закрыть
                    </button>
                  </div>
                </>
              )}

              {tgLink.status === 'linked' && (
                <>
                  <p className="modalText">Готово! Telegram подключён.</p>
                  <div className="modalActions">
                    <button type="button" className="btn btn--primary" onClick={() => setTgModalOpen(false)}>
                      Отлично
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function TelegramLinkPoller({ code, onLinked }: { code: string; onLinked: () => void }) {
  const [status, setStatus] = useState<'waiting' | 'linked' | 'error'>('waiting')

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const res = await fetch(`/api/telegram/link/${encodeURIComponent(code)}`)
        if (!res.ok) return
        const data = (await res.json().catch(() => null)) as { linked?: boolean } | null
        if (data?.linked) {
          if (!alive) return
          setStatus('linked')
          onLinked()
        }
      } catch {
        if (!alive) return
        setStatus('error')
      }
    }

    const id = window.setInterval(tick, 1500)
    tick()

    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [code, onLinked])

  if (status === 'waiting') return <p className="telegramNote">Ожидаем подтверждение…</p>
  if (status === 'error') return <p className="telegramNote telegramNote--error">Проблема с проверкой статуса.</p>
  return null
}

export default App
