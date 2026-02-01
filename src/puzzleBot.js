import dotenv from "dotenv";
import fs from "fs";
import https from "https";
import path from "path";
import sharp from "sharp";
import { line, curveBasis } from "d3-shape";
import TextToSVG from "text-to-svg";
import { fileURLToPath } from "url";
import { Telegraf, Markup } from "telegraf";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const PUZZLE_MAX_SIDE = Number(process.env.PUZZLE_MAX_SIDE || 2000);
const LINE_WIDTH = Number.parseFloat(process.env.PUZZLE_LINE_WIDTH || "1");
const LINE_OPACITY = Number.parseFloat(process.env.PUZZLE_LINE_OPACITY || "0.45");
const LINE_COLOR = process.env.PUZZLE_LINE_COLOR || "#000000";
const MIN_FONT_SIZE = Number.parseInt(process.env.PUZZLE_MIN_FONT_SIZE || "12", 10);
const MAX_FONT_SIZE = Number.parseInt(process.env.PUZZLE_MAX_FONT_SIZE || "28", 10);
const MAX_TEXT_LINES = Number.parseInt(process.env.PUZZLE_MAX_LINES || "3", 10);
const FONT_SCALE_BY_COUNT = {
  12: 0.9,
  15: 0.75,
  16: 0.7,
  21: 0.6
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FONT_PATH = path.resolve(__dirname, "..", "assets", "NotoSans-Regular.ttf");
let FONT_DATA = "";
let textToSvg = null;

try {
  FONT_DATA = fs.readFileSync(FONT_PATH).toString("base64");
} catch (err) {
  console.warn("Font file not found, fallback fonts will be used.", err?.message || err);
}

try {
  textToSvg = TextToSVG.loadSync(FONT_PATH);
} catch (err) {
  console.warn("TextToSVG font load failed, falling back to SVG text.", err?.message || err);
  try {
    textToSvg = TextToSVG.loadSync();
  } catch (fallbackErr) {
    console.warn("TextToSVG default font load failed.", fallbackErr?.message || fallbackErr);
    textToSvg = null;
  }
}

const FONT_FAMILY = FONT_DATA ? "PuzzleFont, Arial, sans-serif" : "Arial, sans-serif";
const FONT_STYLE = FONT_DATA
  ? `@font-face { font-family: 'PuzzleFont'; src: url(data:font/ttf;base64,${FONT_DATA}) format('truetype'); }`
  : "";

const SIZE_OPTIONS = [
  { count: 12, rows: 3, cols: 4 },
  { count: 15, rows: 3, cols: 5 },
  { count: 16, rows: 4, cols: 4 },
  { count: 21, rows: 3, cols: 7 }
];

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN. Set it in .env (see .env.example).");
  process.exit(1);
}

const sessions = new Map();

function createSession() {
  return {
    step: "await_photo",
    photoFileId: null,
    rows: null,
    cols: null,
    count: null,
    width: null,
    height: null,
    facts: [],
    seed: null,
    puzzlePaths: null,
    edgeMeta: null,
    fontScale: 1
  };
}

function getSession(userId) {
  const key = String(userId);
  if (!sessions.has(key)) sessions.set(key, createSession());
  return sessions.get(key);
}

function resetSession(userId) {
  sessions.set(String(userId), createSession());
}

function downloadFile(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 5) {
            reject(new Error("Too many redirects while downloading file"));
            return;
          }
          resolve(downloadFile(res.headers.location, redirects + 1));
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download file (status ${res.statusCode})`));
          return;
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

async function normalizePhoto(buffer) {
  let image = sharp(buffer).rotate();
  const metadata = await image.metadata();
  const maxSide = Number.isFinite(PUZZLE_MAX_SIDE) ? PUZZLE_MAX_SIDE : 2000;

  if (metadata.width && metadata.height) {
    if (metadata.width > maxSide || metadata.height > maxSide) {
      image = image.resize({
        width: maxSide,
        height: maxSide,
        fit: "inside",
        withoutEnlargement: true
      });
    }
  }

  const { data, info } = await image.png().toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

function fmt(value) {
  return Number(value.toFixed(2));
}

const curvedLine = line().curve(curveBasis);

function createRng(seed) {
  let state = seed >>> 0;
  return function rand() {
    state += 0x6d2b79f5;
    let result = Math.imul(state ^ (state >>> 15), state | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBetween(rng, min, max) {
  return rng() * (max - min) + min;
}

function edgeDistributions(rng) {
  const baselineOffsets = {
    xMin: 51,
    xMax: 62,
    yMin: -15,
    yMax: 5
  };
  const upperOffsets = {
    xMin: 20,
    xMax: 30,
    yMin: 20,
    yMax: 44
  };

  const p1 = [0, 0];
  const p2 = [randomBetween(rng, baselineOffsets.xMin, baselineOffsets.xMax), randomBetween(rng, baselineOffsets.yMin, baselineOffsets.yMax)];
  const p3 = [randomBetween(rng, upperOffsets.xMin, upperOffsets.xMax), randomBetween(rng, upperOffsets.yMin, upperOffsets.yMax)];
  const p4 = [
    randomBetween(rng, 100 - upperOffsets.xMax, 100 - upperOffsets.xMin),
    randomBetween(rng, upperOffsets.yMin, upperOffsets.yMax)
  ];
  const p5 = [
    randomBetween(rng, 100 - baselineOffsets.xMax, 100 - baselineOffsets.xMin),
    randomBetween(rng, baselineOffsets.yMin, baselineOffsets.yMax)
  ];
  const p6 = [100, 0];

  const sign = rng() < 0.5 ? -1 : 1;
  const normalized = [p1, p2, p3, p4, p5, p6].map((point) => [point[0] / 100, point[1] / 100]);
  const amp = normalized.reduce((max, point) => Math.max(max, Math.abs(point[1])), 0);
  const points = normalized.map((point) => [point[0], point[1] * sign]);
  return { points, amp, sign };
}

function buildDistributions(rowCount, columnCount, rng) {
  const lineGroups = [];
  lineGroups.push(
    Array.from({ length: columnCount }, () => ({
      points: [
        [0, 0],
        [1, 0]
      ],
      amp: 0,
      sign: 0
    }))
  );

  for (let i = 1; i < rowCount; i += 1) {
    const lines = [];
    for (let j = 0; j < columnCount; j += 1) {
      lines.push(edgeDistributions(rng));
    }
    lineGroups.push(lines);
  }

  lineGroups.push(
    Array.from({ length: columnCount }, () => ({
      points: [
        [0, 0],
        [1, 0]
      ],
      amp: 0,
      sign: 0
    }))
  );
  return lineGroups;
}

function transposePoint(point) {
  return [point[1], point[0]];
}

function offsetPoint(point, offsetX, offsetY, columnWidth, rowHeight) {
  return [(point[0] + offsetX) * columnWidth, (point[1] + offsetY) * rowHeight];
}

function offsetPoints(lineGroups, offsetFn) {
  return lineGroups.map((lines, i) => lines.map((line, j) => line.points.map((point) => offsetFn(point, i, j))));
}

function lineToPath(points) {
  if (points.length <= 2) {
    const [a, b] = points;
    return `M ${fmt(a[0])} ${fmt(a[1])} L ${fmt(b[0])} ${fmt(b[1])}`;
  }
  const path = curvedLine(points);
  return path || "";
}

function buildPuzzleData(width, height, rows, cols, seed) {
  const rng = createRng(Number.isFinite(seed) ? seed : Math.floor(Math.random() * 1e9));
  const rowHeight = height / rows;
  const columnWidth = width / cols;

  const rowsLines = buildDistributions(rows, cols, rng);
  const columnsLines = buildDistributions(cols, rows, rng);

  const safetyFactor = 1.05;
  const horizontalEdges = rowsLines.map((lines) =>
    lines.map((line) => ({
      ampPx: line.amp * rowHeight * safetyFactor,
      sign: line.sign
    }))
  );
  const verticalEdges = columnsLines.map((lines) =>
    lines.map((line) => ({
      ampPx: line.amp * columnWidth * safetyFactor,
      sign: line.sign
    }))
  );

  const rowsOffset = offsetPoints(rowsLines, (point, i, j) => offsetPoint(point, j, i, columnWidth, rowHeight));
  const columnsOffset = offsetPoints(columnsLines, (point, i, j) =>
    offsetPoint(transposePoint(point), i, j, columnWidth, rowHeight)
  );

  const allLines = [...rowsOffset.flat(), ...columnsOffset.flat()];
  return {
    paths: allLines.map(lineToPath).filter(Boolean),
    edgeMeta: {
      horizontal: horizontalEdges,
      vertical: verticalEdges
    }
  };
}

function buildPuzzleSvg(width, height, puzzlePaths) {
  const paths = puzzlePaths.map((pathDef) => `<path d="${pathDef}" />`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <g fill="none" stroke="${LINE_COLOR}" stroke-opacity="${LINE_OPACITY}" stroke-width="${LINE_WIDTH}" stroke-linecap="round" stroke-linejoin="round">
    ${paths}
  </g>
</svg>`;
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapText(text, maxChars, maxLines) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return { lines: [""], truncated: false };

  const words = cleaned.split(" ");
  const lines = [];
  let current = "";

  for (const word of words) {
    if (word.length > maxChars) {
      if (current) {
        lines.push(current);
        current = "";
      }
      let chunk = word;
      while (chunk.length > maxChars) {
        lines.push(chunk.slice(0, maxChars));
        chunk = chunk.slice(maxChars);
      }
      current = chunk;
      continue;
    }

    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);

  if (lines.length > maxLines) {
    const truncatedLines = lines.slice(0, maxLines);
    const lastIndex = truncatedLines.length - 1;
    const last = truncatedLines[lastIndex];
    truncatedLines[lastIndex] = last.length > 1 ? `${last.slice(0, last.length - 1)}…` : "…";
    return { lines: truncatedLines, truncated: true };
  }

  return { lines, truncated: false };
}

function measureTextWidth(text, fontSize) {
  if (!textToSvg) return text.length * fontSize * 0.6;
  const metrics = textToSvg.getMetrics(text, { fontSize, anchor: "left baseline" });
  return metrics.width || 0;
}

function wrapTextByWidth(text, maxWidth, fontSize) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return { lines: [""], truncated: false };

  const words = cleaned.split(" ");
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (measureTextWidth(next, fontSize) <= maxWidth) {
      current = next;
      continue;
    }

    if (current) {
      lines.push(current);
      current = "";
    }

    if (measureTextWidth(word, fontSize) <= maxWidth) {
      current = word;
      continue;
    }

    return { lines: lines.concat(word), truncated: true, reason: "word_too_long" };
  }

  if (current) lines.push(current);
  return { lines, truncated: false };
}

function fitTextToCell(text, cellWidth, cellHeight, paddingOverride, fontScale = 1) {
  const minSide = Math.min(cellWidth, cellHeight);
  const padding = Number.isFinite(paddingOverride) ? paddingOverride : Math.max(8, Math.floor(minSide * 0.08));
  const minFont = Number.isFinite(MIN_FONT_SIZE) ? MIN_FONT_SIZE : 12;
  const maxFont = Number.isFinite(MAX_FONT_SIZE) ? MAX_FONT_SIZE : 28;
  const scale = Number.isFinite(fontScale) ? fontScale : 1;
  const scaledMin = Math.max(10, minFont);
  const scaledMax = Math.max(scaledMin, Math.floor(maxFont * scale));
  let fontSize = Math.min(scaledMax, Math.max(scaledMin, Math.floor(minSide * 0.2 * scale)));
  let attempt = 0;
  let last = null;

  while (fontSize >= scaledMin && attempt < 40) {
    const lineHeight = fontSize * 1.2;
    const heightLines = Math.max(1, Math.floor((cellHeight - padding * 2) / lineHeight));
    const maxLines = Math.max(1, Math.min(heightLines, MAX_TEXT_LINES));
    const maxWidth = Math.max(10, cellWidth - padding * 2);
    const wrapped = wrapTextByWidth(text, maxWidth, fontSize);
    let lines = wrapped.lines;
    const truncated = lines.length > maxLines;
    if (truncated) {
      lines = lines.slice(0, maxLines);
    }
    last = {
      lines,
      truncated,
      fontSize,
      lineHeight,
      maxLines,
      maxChars: 0
    };
    if (!truncated) return last;
    fontSize -= 1;
    attempt += 1;
  }

  if (last) return { ...last, truncated: true };
  return {
    lines: [text],
    truncated: true,
    fontSize: minFont,
    lineHeight: minFont * 1.2,
    maxLines: 1,
    maxChars: 4
  };
}

function sanitizeFact(raw) {
  let text = String(raw || "");
  try {
    text = text.replace(/\p{Extended_Pictographic}/gu, "");
  } catch (err) {
    text = text.replace(/[\u{1F300}-\u{1FAFF}]/gu, "");
  }
  try {
    text = text.replace(/[^\p{L}\p{N}\s.,;:!?'"()\-]/gu, "");
  } catch (err) {
    text = text.replace(/[^\w\s.,;:!?'"()\-]/g, "");
  }
  return text.replace(/\s+/g, " ").trim();
}

const STOPWORDS = new Set([
  "и",
  "а",
  "но",
  "или",
  "что",
  "как",
  "когда",
  "где",
  "это",
  "этот",
  "эта",
  "эти",
  "тот",
  "та",
  "те",
  "не",
  "на",
  "в",
  "во",
  "по",
  "за",
  "из",
  "у",
  "о",
  "об",
  "про",
  "для",
  "то",
  "же",
  "бы",
  "ли",
  "ну",
  "да",
  "нет",
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "as",
  "at"
]);

function splitSentences(text) {
  return text
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function autoRewriteFact(text, safeBox, fontScale) {
  const padding = getTextPadding(safeBox);
  const tryFit = (candidate) => {
    const fit = fitTextToCell(candidate, safeBox.width, safeBox.height, padding, fontScale);
    return { ok: !fit.truncated, fit };
  };

  if (tryFit(text).ok) return { text, changed: false, fit: tryFit(text).fit };

  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    if (tryFit(sentence).ok) return { text: sentence, changed: true, fit: tryFit(sentence).fit };
  }

  const clauses = text.split(/[,:;]+/).map((part) => part.trim()).filter(Boolean);
  for (const clause of clauses) {
    if (tryFit(clause).ok) return { text: clause, changed: true, fit: tryFit(clause).fit };
  }

  const words = text.split(/\s+/).filter(Boolean);
  const filtered = words.filter((word) => {
    const lower = word.toLowerCase();
    return lower.length > 2 && !STOPWORDS.has(lower);
  });
  if (filtered.length > 0) {
    const candidate = filtered.join(" ");
    const ratio = candidate.length / Math.max(1, text.length);
    if (ratio >= 0.6 && tryFit(candidate).ok) {
      return { text: candidate, changed: true, fit: tryFit(candidate).fit };
    }
  }

  return { text, changed: false, fit: tryFit(text).fit, failed: true };
}

function getSafeBox(row, col, cellWidth, cellHeight, rows, cols, edgeMeta, basePadding) {
  const leftBase = col * cellWidth;
  const topBase = row * cellHeight;
  const safePadding = Number.isFinite(basePadding)
    ? basePadding
    : Math.max(10, Math.floor(Math.min(cellWidth, cellHeight) * 0.14));
  const maxInsetX = cellWidth * 0.18;
  const maxInsetY = cellHeight * 0.18;

  let topInset = safePadding;
  let bottomInset = safePadding;
  let leftInset = safePadding;
  let rightInset = safePadding;

  if (edgeMeta?.horizontal) {
    if (row > 0) {
      const edge = edgeMeta.horizontal[row]?.[col];
      if (edge && edge.sign > 0) topInset += Math.min(edge.ampPx, maxInsetY);
    }
    if (row < rows - 1) {
      const edge = edgeMeta.horizontal[row + 1]?.[col];
      if (edge && edge.sign < 0) bottomInset += Math.min(edge.ampPx, maxInsetY);
    }
  }

  if (edgeMeta?.vertical) {
    if (col > 0) {
      const edge = edgeMeta.vertical[col]?.[row];
      if (edge && edge.sign > 0) leftInset += Math.min(edge.ampPx, maxInsetX);
    }
    if (col < cols - 1) {
      const edge = edgeMeta.vertical[col + 1]?.[row];
      if (edge && edge.sign < 0) rightInset += Math.min(edge.ampPx, maxInsetX);
    }
  }

  let left = leftBase + leftInset;
  let right = leftBase + cellWidth - rightInset;
  let top = topBase + topInset;
  let bottom = topBase + cellHeight - bottomInset;

  if (right - left < 10) {
    left = leftBase + cellWidth * 0.1;
    right = leftBase + cellWidth * 0.9;
  }
  if (bottom - top < 10) {
    top = topBase + cellHeight * 0.1;
    bottom = topBase + cellHeight * 0.9;
  }

  const width = right - left;
  const height = bottom - top;
  return {
    left,
    right,
    top,
    bottom,
    width,
    height,
    centerX: left + width / 2,
    centerY: top + height / 2
  };
}

function getTextPadding(box) {
  return Math.max(4, Math.floor(Math.min(box.width, box.height) * 0.08));
}

function mirrorFacts(facts, rows, cols) {
  const mirrored = new Array(facts.length);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const index = r * cols + c;
      const mirrorIndex = r * cols + (cols - 1 - c);
      mirrored[mirrorIndex] = facts[index] || "";
    }
  }
  return mirrored;
}

function buildBackSvg(width, height, rows, cols, facts, puzzlePaths, edgeMeta, fontScale = 1) {
  const lines = (puzzlePaths || buildPuzzleData(width, height, rows, cols).paths)
    .map((pathDef) => `<path d="${pathDef}" />`)
    .join("");
  const cellWidth = width / cols;
  const cellHeight = height / rows;
  const basePadding = Math.max(10, Math.floor(Math.min(cellWidth, cellHeight) * 0.14));
  const mirrored = mirrorFacts(facts, rows, cols);

  const textBlocks = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const index = r * cols + c;
      const text = mirrored[index] || "";
      if (!text) continue;

      const safeBox = getSafeBox(r, c, cellWidth, cellHeight, rows, cols, edgeMeta, basePadding);
      const textPadding = getTextPadding(safeBox);
      const { lines: wrappedLines, fontSize, lineHeight } = fitTextToCell(
        text,
        safeBox.width,
        safeBox.height,
        textPadding,
        fontScale
      );

      const centerX = safeBox.centerX;
      const centerY = safeBox.centerY;

      const totalHeight = (wrappedLines.length - 1) * lineHeight;
      const startY = centerY - totalHeight / 2;

      const paths = wrappedLines.map((line, idx) => {
        const y = startY + idx * lineHeight;
        if (textToSvg) {
          return textToSvg.getPath(line, {
            x: centerX,
            y,
            fontSize,
            anchor: "center middle",
            attributes: { fill: "#111" }
          });
        }
        return `<text font-size="${fontSize}" text-anchor="middle" fill="#111" font-family="${FONT_FAMILY}" x="${centerX.toFixed(
          2
        )}" y="${y.toFixed(2)}">${escapeXml(line)}</text>`;
      });

      textBlocks.push(paths.join("\n"));
    }
  }

  const fontStyle = textToSvg ? "" : `<style>${FONT_STYLE}</style>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  ${fontStyle}
  <rect width="100%" height="100%" fill="#ffffff" />
  <g fill="none" stroke="${LINE_COLOR}" stroke-opacity="${LINE_OPACITY}" stroke-width="${LINE_WIDTH}" stroke-linecap="round" stroke-linejoin="round">
    ${lines}
  </g>
  ${textBlocks.join("\n  ")}
</svg>`;
}

async function generateFrontImage(ctx, session) {
  const fileLink = await ctx.telegram.getFileLink(session.photoFileId);
  const photoBuffer = await downloadFile(fileLink.href || String(fileLink));
  const { buffer, width, height } = await normalizePhoto(photoBuffer);
  const puzzleData = buildPuzzleData(width, height, session.rows, session.cols, session.seed);
  session.puzzlePaths = puzzleData.paths;
  session.edgeMeta = puzzleData.edgeMeta;
  const gridSvg = buildPuzzleSvg(width, height, puzzleData.paths);

  const frontBuffer = await sharp(buffer)
    .composite([{ input: Buffer.from(gridSvg), blend: "over" }])
    .png()
    .toBuffer();

  return { buffer: frontBuffer, width, height };
}

async function generateBackImage(session) {
  const svg = buildBackSvg(
    session.width,
    session.height,
    session.rows,
    session.cols,
    session.facts,
    session.puzzlePaths,
    session.edgeMeta,
    session.fontScale
  );
  const backBuffer = await sharp({
    create: {
      width: session.width,
      height: session.height,
      channels: 3,
      background: "#ffffff"
    }
  })
    .composite([{ input: Buffer.from(svg), blend: "over" }])
    .png()
    .toBuffer();

  return backBuffer;
}

function formatOptions() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("12", "size:12"), Markup.button.callback("15", "size:15")],
    [Markup.button.callback("16", "size:16"), Markup.button.callback("21", "size:21")]
  ]);
}

function formatFactsPrompt(session) {
  return `Пришли факты для пазла: ${session.facts.length}/${session.count}.\nМожно писать по одному факту или сразу несколько строками. Эмодзи удаляются. Если текст не влезет, попрошу сократить.`;
}

async function sendProgressPreview(ctx, session, caption) {
  try {
    const backBuffer = await generateBackImage(session);
    await ctx.replyWithDocument(
      { source: backBuffer, filename: "puzzle-back-preview.png" },
      { caption: caption || "Промежуточный результат" }
    );
  } catch (err) {
    console.error("Preview generation error", err);
  }
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  resetSession(ctx.from.id);
  ctx.reply(
    "Привет! Пришли фото, и я сделаю пазл: передняя сторона с пазами и задняя с фактами.\n\nКоманды: /start, /cancel",
    Markup.removeKeyboard()
  );
});

bot.command("cancel", (ctx) => {
  resetSession(ctx.from.id);
  ctx.reply("Сбросил текущий пазл. Пришли новое фото, чтобы начать заново.");
});

bot.on("photo", async (ctx) => {
  const session = getSession(ctx.from.id);
  const photos = ctx.message.photo || [];
  const largest = photos[photos.length - 1];

  if (!largest) {
    ctx.reply("Не вижу фото. Пришли картинку ещё раз.");
    return;
  }

  session.step = "await_size";
  session.photoFileId = largest.file_id;
  session.facts = [];
  session.rows = null;
  session.cols = null;
  session.count = null;
  session.width = null;
  session.height = null;
  session.seed = Math.floor(Math.random() * 1e9);
  session.puzzlePaths = null;
  session.edgeMeta = null;
  session.fontScale = 1;

  ctx.reply("Сколько деталей в пазле?", formatOptions());
});

bot.action(/size:(\d+)/, async (ctx) => {
  const session = getSession(ctx.from.id);
  const count = Number(ctx.match[1]);
  const option = SIZE_OPTIONS.find((item) => item.count === count);

  await ctx.answerCbQuery();

  if (!session.photoFileId) {
    ctx.reply("Сначала пришли фото.");
    return;
  }

  if (!option) {
    ctx.reply("Не понял размер. Выбери кнопку из списка.");
    return;
  }

  session.rows = option.rows;
  session.cols = option.cols;
  session.count = option.count;
  session.fontScale = FONT_SCALE_BY_COUNT[option.count] || 1;
  session.step = "processing";

  try {
    ctx.reply("Готовлю пазл на фото...");
    const { buffer, width, height } = await generateFrontImage(ctx, session);
    session.width = width;
    session.height = height;
    session.step = "await_facts";

    await ctx.replyWithDocument({ source: buffer, filename: "puzzle-front.png" }, { caption: "Передняя сторона" });
    ctx.reply(formatFactsPrompt(session));
  } catch (err) {
    console.error("Front image error", err);
    session.step = "await_photo";
    ctx.reply("Не получилось обработать фото. Попробуй другое изображение.");
  }
});

bot.on("text", async (ctx) => {
  const session = getSession(ctx.from.id);
  const text = ctx.message.text || "";

  if (text.startsWith("/")) return;

  if (session.step === "await_photo") {
    ctx.reply("Сначала пришли фото.");
    return;
  }

  if (session.step === "await_size") {
    ctx.reply("Выбери размер пазла кнопкой ниже.");
    return;
  }

  if (session.step !== "await_facts") {
    ctx.reply("Подожди, я ещё обрабатываю фото.");
    return;
  }

  const rawLines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (rawLines.length === 0) {
    ctx.reply("Факт пустой. Пришли текст.");
    return;
  }

  const cellWidth = session.width / session.cols;
  const cellHeight = session.height / session.rows;
  const basePadding = Math.max(10, Math.floor(Math.min(cellWidth, cellHeight) * 0.14));
  let hadSanitized = false;

  let tooLong = null;
  const autoRewrites = [];
  for (const rawLine of rawLines) {
    if (session.facts.length >= session.count) break;
    const cleaned = sanitizeFact(rawLine);
    if (!cleaned) {
      ctx.reply("Эмодзи и спецсимволы удаляются. Пришли текст только буквами/цифрами и пунктуацией.");
      return;
    }
    if (cleaned !== rawLine) hadSanitized = true;

    const targetIndex = session.facts.length + 1;
    const row = Math.floor((targetIndex - 1) / session.cols);
    const col = (targetIndex - 1) % session.cols;
    const safeBox = getSafeBox(row, col, cellWidth, cellHeight, session.rows, session.cols, session.edgeMeta, basePadding);
    const textPadding = getTextPadding(safeBox);
    const fit = fitTextToCell(cleaned, safeBox.width, safeBox.height, textPadding, session.fontScale);
    if (fit.truncated) {
      const rewrite = autoRewriteFact(cleaned, safeBox, session.fontScale);
      if (!rewrite.failed && rewrite.fit && !rewrite.fit.truncated) {
        session.facts.push(rewrite.text);
        if (rewrite.text !== cleaned) {
          autoRewrites.push({ index: targetIndex, from: cleaned, to: rewrite.text });
        }
        continue;
      }
      tooLong = { index: targetIndex, text: cleaned };
      break;
    }
    session.facts.push(cleaned);
  }

  if (hadSanitized) {
    ctx.reply("Эмодзи и лишние спецсимволы удалены. Оставлены буквы, цифры и пунктуация.");
  }

  if (autoRewrites.length > 0) {
    const lines = autoRewrites
      .map((item) => `#${item.index}: “${item.from}” → “${item.to}”`)
      .slice(0, 5)
      .join("\n");
    ctx.reply(`Слишком длинные факты я сократил автоматически:\n${lines}`);
  }

  if (tooLong) {
    await ctx.reply(
      `Факт для детали ${tooLong.index} слишком длинный и не влез.\nВот текст: “${tooLong.text}”\nПришли новый короткий факт для этой детали.`
    );
    await sendProgressPreview(ctx, session, "То, что уже влезло");
    ctx.reply(formatFactsPrompt(session));
    return;
  }

  if (session.facts.length < session.count) {
    await sendProgressPreview(ctx, session, "То, что уже влезло");
    ctx.reply(formatFactsPrompt(session));
    return;
  }

  session.step = "processing";

  try {
    ctx.reply("Готовлю обратную сторону...");
    const backBuffer = await generateBackImage(session);
    await ctx.replyWithDocument({ source: backBuffer, filename: "puzzle-back.png" }, { caption: "Задняя сторона" });
    ctx.reply("Готово! Если хочешь новый пазл, пришли другое фото.");
    resetSession(ctx.from.id);
  } catch (err) {
    console.error("Back image error", err);
    session.step = "await_facts";
    ctx.reply("Не получилось собрать обратную сторону. Попробуй ещё раз.");
  }
});

bot.launch();
console.log("Puzzle bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
