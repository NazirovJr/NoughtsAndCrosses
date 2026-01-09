export type Mark = 'X' | 'O'
export type Cell = Mark | null

const LINES: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
]

export function getWinner(board: Cell[]): { winner: Mark | null; line: number[] | null } {
  for (const line of LINES) {
    const [a, b, c] = line
    const v = board[a]
    if (v && v === board[b] && v === board[c]) {
      return { winner: v, line: [a, b, c] }
    }
  }
  return { winner: null, line: null }
}

export function isDraw(board: Cell[]): boolean {
  return board.every((c) => c !== null) && getWinner(board).winner === null
}

function emptyCells(board: Cell[]): number[] {
  const res: number[] = []
  for (let i = 0; i < board.length; i++) {
    if (board[i] === null) res.push(i)
  }
  return res
}

function minimax(board: Cell[], isAiTurn: boolean, ai: Mark, human: Mark, depth: number): number {
  const { winner } = getWinner(board)
  if (winner === ai) return 10 - depth
  if (winner === human) return depth - 10
  if (board.every((c) => c !== null)) return 0

  const empties = emptyCells(board)

  if (isAiTurn) {
    let best = -Infinity
    for (const idx of empties) {
      const next = board.slice()
      next[idx] = ai
      best = Math.max(best, minimax(next, false, ai, human, depth + 1))
    }
    return best
  }

  let best = Infinity
  for (const idx of empties) {
    const next = board.slice()
    next[idx] = human
    best = Math.min(best, minimax(next, true, ai, human, depth + 1))
  }
  return best
}

export function getBestMove(board: Cell[], ai: Mark, human: Mark): number | null {
  const empties = emptyCells(board)
  if (empties.length === 0) return null

  let bestScore = -Infinity
  let bestMoves: number[] = []

  for (const idx of empties) {
    const next = board.slice()
    next[idx] = ai
    const score = minimax(next, false, ai, human, 0)

    if (score > bestScore) {
      bestScore = score
      bestMoves = [idx]
    } else if (score === bestScore) {
      bestMoves.push(idx)
    }
  }

  return bestMoves[Math.floor(Math.random() * bestMoves.length)]
}

