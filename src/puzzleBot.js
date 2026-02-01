import dotenv from "dotenv";
import fs from "fs";
import https from "https";
import path from "path";
import sharp from "sharp";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FONT_PATH = path.resolve(__dirname, "..", "assets", "NotoSans-Regular.ttf");
let FONT_DATA = "";

try {
  FONT_DATA = fs.readFileSync(FONT_PATH).toString("base64");
} catch (err) {
  console.warn("Font file not found, fallback fonts will be used.", err?.message || err);
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
    facts: []
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

function verticalEdgePath(x, y0, y1, dir, tabSpan, neckSpan) {
  const ym = (y0 + y1) / 2;
  const yStart = ym - tabSpan / 2;
  const yNeckStart = yStart + neckSpan;
  const arcSpan = tabSpan - neckSpan * 2;
  const radius = arcSpan / 2;
  const yNeckEnd = yNeckStart + arcSpan;
  const yEnd = yStart + tabSpan;
  const sweep = dir === 1 ? 1 : 0;

  return [
    `M ${fmt(x)} ${fmt(y0)}`,
    `L ${fmt(x)} ${fmt(yStart)}`,
    `L ${fmt(x)} ${fmt(yNeckStart)}`,
    `A ${fmt(radius)} ${fmt(radius)} 0 0 ${sweep} ${fmt(x)} ${fmt(yNeckEnd)}`,
    `L ${fmt(x)} ${fmt(yEnd)}`,
    `L ${fmt(x)} ${fmt(y1)}`
  ].join(" ");
}

function horizontalEdgePath(y, x0, x1, dir, tabSpan, neckSpan) {
  const xm = (x0 + x1) / 2;
  const xStart = xm - tabSpan / 2;
  const xNeckStart = xStart + neckSpan;
  const arcSpan = tabSpan - neckSpan * 2;
  const radius = arcSpan / 2;
  const xNeckEnd = xNeckStart + arcSpan;
  const xEnd = xStart + tabSpan;
  const sweep = dir === 1 ? 1 : 0;

  return [
    `M ${fmt(x0)} ${fmt(y)}`,
    `L ${fmt(xStart)} ${fmt(y)}`,
    `L ${fmt(xNeckStart)} ${fmt(y)}`,
    `A ${fmt(radius)} ${fmt(radius)} 0 0 ${sweep} ${fmt(xNeckEnd)} ${fmt(y)}`,
    `L ${fmt(xEnd)} ${fmt(y)}`,
    `L ${fmt(x1)} ${fmt(y)}`
  ].join(" ");
}

function buildPuzzlePaths(width, height, rows, cols) {
  const paths = [];
  const cellWidth = width / cols;
  const cellHeight = height / rows;
  const baseSize = Math.min(cellWidth, cellHeight);
  const tabSpan = baseSize * 0.34;
  const neckSpan = tabSpan * 0.22;

  paths.push(`M 0 0 H ${fmt(width)} V ${fmt(height)} H 0 Z`);

  for (let c = 1; c < cols; c += 1) {
    const x = cellWidth * c;
    for (let r = 0; r < rows; r += 1) {
      const y0 = cellHeight * r;
      const y1 = cellHeight * (r + 1);
      const dir = (r + c) % 2 === 0 ? 1 : -1;
      paths.push(verticalEdgePath(x, y0, y1, dir, tabSpan, neckSpan));
    }
  }

  for (let r = 1; r < rows; r += 1) {
    const y = cellHeight * r;
    for (let c = 0; c < cols; c += 1) {
      const x0 = cellWidth * c;
      const x1 = cellWidth * (c + 1);
      const dir = (r + c) % 2 === 0 ? -1 : 1;
      paths.push(horizontalEdgePath(y, x0, x1, dir, tabSpan, neckSpan));
    }
  }

  return paths;
}

function buildPuzzleSvg(width, height, rows, cols) {
  const paths = buildPuzzlePaths(width, height, rows, cols)
    .map((pathDef) => `<path d="${pathDef}" />`)
    .join("");

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

function fitTextToCell(text, cellWidth, cellHeight) {
  const minSide = Math.min(cellWidth, cellHeight);
  const padding = Math.max(8, Math.floor(minSide * 0.08));
  const minFont = Number.isFinite(MIN_FONT_SIZE) ? MIN_FONT_SIZE : 12;
  const maxFont = Number.isFinite(MAX_FONT_SIZE) ? MAX_FONT_SIZE : 28;
  let fontSize = Math.min(maxFont, Math.max(minFont, Math.floor(minSide * 0.2)));
  let attempt = 0;
  let last = null;

  while (fontSize >= minFont && attempt < 40) {
    const lineHeight = fontSize * 1.2;
    const maxLines = Math.max(1, Math.floor((cellHeight - padding * 2) / lineHeight));
    const maxChars = Math.max(4, Math.floor((cellWidth - padding * 2) / (fontSize * 0.6)));
    const wrapped = wrapText(text, maxChars, maxLines);
    last = {
      lines: wrapped.lines,
      truncated: wrapped.truncated,
      fontSize,
      lineHeight,
      maxLines,
      maxChars
    };
    if (!wrapped.truncated) {
      return last;
    }
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

function buildBackSvg(width, height, rows, cols, facts) {
  const lines = buildPuzzlePaths(width, height, rows, cols)
    .map((pathDef) => `<path d="${pathDef}" />`)
    .join("");
  const cellWidth = width / cols;
  const cellHeight = height / rows;
  const mirrored = mirrorFacts(facts, rows, cols);

  const textBlocks = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const index = r * cols + c;
      const text = mirrored[index] || "";
      if (!text) continue;

      const centerX = cellWidth * c + cellWidth / 2;
      const centerY = cellHeight * r + cellHeight / 2;
      const { lines: wrappedLines, fontSize, lineHeight } = fitTextToCell(text, cellWidth, cellHeight);

      const totalHeight = (wrappedLines.length - 1) * lineHeight;
      const startY = centerY - totalHeight / 2;

      const tspans = wrappedLines
        .map((line, idx) => {
          const y = startY + idx * lineHeight;
          return `<tspan x="${centerX.toFixed(2)}" y="${y.toFixed(2)}">${escapeXml(line)}</tspan>`;
        })
        .join("");

      textBlocks.push(
        `<text font-size="${fontSize}" text-anchor="middle" fill="#111" font-family="${FONT_FAMILY}">${tspans}</text>`
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <style>${FONT_STYLE}</style>
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
  const gridSvg = buildPuzzleSvg(width, height, session.rows, session.cols);

  const frontBuffer = await sharp(buffer)
    .composite([{ input: Buffer.from(gridSvg), blend: "over" }])
    .png()
    .toBuffer();

  return { buffer: frontBuffer, width, height };
}

async function generateBackImage(session) {
  const svg = buildBackSvg(session.width, session.height, session.rows, session.cols, session.facts);
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
  return `Пришли факты для пазла: ${session.facts.length}/${session.count}.\nМожно писать по одному факту или сразу несколько строками. Если текст не влезет, я попрошу сократить.`;
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

  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    ctx.reply("Факт пустой. Пришли текст.");
    return;
  }

  const cellWidth = session.width / session.cols;
  const cellHeight = session.height / session.rows;

  for (const line of lines) {
    if (session.facts.length >= session.count) break;
    const targetIndex = session.facts.length + 1;
    const fit = fitTextToCell(line, cellWidth, cellHeight);
    if (fit.truncated) {
      ctx.reply(
        `Факт для детали ${targetIndex} слишком длинный и станет нечитаемым.\nСократи текст и пришли заново.`
      );
      return;
    }
    session.facts.push(line);
  }

  if (session.facts.length < session.count) {
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
