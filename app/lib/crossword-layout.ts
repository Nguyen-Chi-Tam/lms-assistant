// app/lib/crossword-layout.ts

export interface PlacedWord {
  id: number;
  word: string;
  clue: string;
  row: number;
  col: number;
  direction: 'across' | 'down';
  unlockedBy?: number; // ID của từ cần giải trước để mở gợi ý (dùng cho mode Normal/Hard)
}

export interface CrosswordLayoutOptions {
  /** Số từ nằm ngang cần nhắm tới (tối thiểu 1). */
  acrossCount?: number;
  /** Số từ nằm dọc cần nhắm tới. */
  downCount?: number;
}

interface CrosswordLayoutResult {
  grid: (string | null)[][];
  placedWords: PlacedWord[];
}

const GRID_SIZE = 15;
const MAX_LAYOUT_ATTEMPTS = 40;

function createEmptyGrid(): (string | null)[][] {
  return Array.from({ length: GRID_SIZE }, () => Array<string | null>(GRID_SIZE).fill(null));
}

function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function normalizeWord(word: string): string {
  return word.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function canPlaceWord(
  grid: (string | null)[][],
  word: string,
  row: number,
  col: number,
  dir: 'across' | 'down'
): boolean {
  const SIZE = grid.length;
  if (row < 0 || col < 0) return false;
  if (dir === 'across' && col + word.length > SIZE) return false;
  if (dir === 'down' && row + word.length > SIZE) return false;

  // Kiểm tra ô liền trước và liền sau từ không bị dính chữ khác
  const beforeR = dir === 'down' ? row - 1 : row;
  const beforeC = dir === 'across' ? col - 1 : col;
  const afterR = dir === 'down' ? row + word.length : row;
  const afterC = dir === 'across' ? col + word.length : col;
  if (beforeR >= 0 && beforeC >= 0 && grid[beforeR][beforeC] !== null) return false;
  if (afterR < SIZE && afterC < SIZE && grid[afterR][afterC] !== null) return false;

  let intersections = 0;
  for (let k = 0; k < word.length; k++) {
    const r = dir === 'down' ? row + k : row;
    const c = dir === 'across' ? col + k : col;
    const cell = grid[r][c];

    if (cell !== null) {
      if (cell !== word[k]) return false;
      intersections++;
    } else {
      // Không để hai từ song song dính sát nhau
      const adj1 = dir === 'across' ? grid[r - 1]?.[c] : grid[r]?.[c - 1];
      const adj2 = dir === 'across' ? grid[r + 1]?.[c] : grid[r]?.[c + 1];
      if (adj1 !== null && adj1 !== undefined) return false;
      if (adj2 !== null && adj2 !== undefined) return false;
    }
  }
  return intersections === 1;
}

function writeWord(
  grid: (string | null)[][],
  word: string,
  row: number,
  col: number,
  dir: 'across' | 'down'
): void {
  for (let k = 0; k < word.length; k++) {
    const r = dir === 'down' ? row + k : row;
    const c = dir === 'across' ? col + k : col;
    grid[r][c] = word[k];
  }
}

/**
 * Xếp các từ thành một lưới ô chữ, cố gắng đạt đúng số từ ngang/dọc mong muốn.
 * Mỗi lần gọi sẽ thử nhiều cách xếp ngẫu nhiên và giữ kết quả sát mục tiêu nhất.
 */
function buildLayout(
  candidates: Array<{ word: string; clue: string }>,
  targetAcross: number,
  targetDown: number
): CrosswordLayoutResult {
  const grid = createEmptyGrid();
  const placedWords: PlacedWord[] = [];
  if (candidates.length === 0) return { grid, placedWords };

  const pool = shuffle(candidates);
  // Từ dài nhất làm trục ngang ở giữa để lưới cân đối.
  const first = [...pool].sort((a, b) => b.word.length - a.word.length)[0];
  const startRow = Math.floor(GRID_SIZE / 2);
  const startCol = Math.max(0, Math.floor((GRID_SIZE - first.word.length) / 2));
  writeWord(grid, first.word, startRow, startCol, 'across');
  placedWords.push({
    id: 1,
    ...first,
    row: startRow,
    col: startCol,
    direction: 'across',
  });

  let across = 1;
  let down = 0;
  const pending = pool.filter((w) => w !== first);

  let placedInRound = true;
  while (
    placedInRound &&
    (across < targetAcross || down < targetDown) &&
    pending.length > 0
  ) {
    placedInRound = false;

    for (let i = 0; i < pending.length; i += 1) {
      if (across >= targetAcross && down >= targetDown) break;

      const candidate = pending[i];
      const dirs: Array<'across' | 'down'> = [];
      if (across < targetAcross) dirs.push('across');
      if (down < targetDown) dirs.push('down');
      shuffle(dirs);

      let placed = false;
      for (const dir of dirs) {
        // Từ mới phải vuông góc với từ đang có để tạo điểm giao.
        const anchors = shuffle(placedWords.filter((w) => w.direction !== dir));
        for (const existing of anchors) {
          for (let eIdx = 0; eIdx < existing.word.length && !placed; eIdx += 1) {
            for (let cIdx = 0; cIdx < candidate.word.length && !placed; cIdx += 1) {
              if (existing.word[eIdx] !== candidate.word[cIdx]) continue;

              const intersectRow =
                existing.direction === 'across' ? existing.row : existing.row + eIdx;
              const intersectCol =
                existing.direction === 'across' ? existing.col + eIdx : existing.col;
              const row = dir === 'down' ? intersectRow - cIdx : intersectRow;
              const col = dir === 'across' ? intersectCol - cIdx : intersectCol;

              if (!canPlaceWord(grid, candidate.word, row, col, dir)) continue;

              writeWord(grid, candidate.word, row, col, dir);
              placedWords.push({
                id: placedWords.length + 1,
                ...candidate,
                row,
                col,
                direction: dir,
                unlockedBy: existing.id,
              });
              if (dir === 'across') across += 1;
              else down += 1;
              placed = true;
            }
          }
          if (placed) break;
        }
        if (placed) break;
      }

      if (placed) {
        pending.splice(i, 1);
        i -= 1;
        placedInRound = true;
      }
    }
  }

  return { grid, placedWords };
}

function scoreLayout(
  layout: CrosswordLayoutResult,
  targetAcross: number,
  targetDown: number
): number {
  const across = layout.placedWords.filter((w) => w.direction === 'across').length;
  const down = layout.placedWords.filter((w) => w.direction === 'down').length;
  const total = across + down;
  const targetTotal = targetAcross + targetDown;

  let score = total * 10;
  score += across === targetAcross ? 600 : -Math.abs(across - targetAcross) * 60;
  score += down === targetDown ? 600 : -Math.abs(down - targetDown) * 60;
  score += total === targetTotal ? 1200 : -Math.abs(targetTotal - total) * 200;
  if (total < 3) score -= 5000;
  return score;
}

export function generateCrosswordGrid(
  rawWords: { word: string; clue: string }[],
  options: CrosswordLayoutOptions = {}
): CrosswordLayoutResult {
  const seen = new Set<string>();
  const candidates = rawWords
    .map((w) => ({ ...w, word: normalizeWord(w.word) }))
    .filter((w) => {
      if (w.word.length < 3 || w.word.length > 12) return false;
      if (seen.has(w.word)) return false;
      seen.add(w.word);
      return true;
    });

  if (candidates.length === 0) {
    return { grid: createEmptyGrid(), placedWords: [] };
  }

  const defaultAcross = Math.max(3, Math.ceil(candidates.length / 2));
  const targetAcross = Math.max(1, options.acrossCount ?? defaultAcross);
  const targetDown = Math.max(0, options.downCount ?? Math.max(3, candidates.length - targetAcross));
  const perfectScore = 600 + 600 + 1200 + (targetAcross + targetDown) * 10;

  let best = buildLayout(candidates, targetAcross, targetDown);
  let bestScore = scoreLayout(best, targetAcross, targetDown);

  for (let attempt = 1; attempt < MAX_LAYOUT_ATTEMPTS; attempt += 1) {
    if (bestScore >= perfectScore) break;
    const layout = buildLayout(candidates, targetAcross, targetDown);
    const score = scoreLayout(layout, targetAcross, targetDown);
    if (score > bestScore) {
      best = layout;
      bestScore = score;
    }
  }

  return best;
}
