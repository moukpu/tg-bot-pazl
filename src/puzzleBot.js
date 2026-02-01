import dotenv from "dotenv";
import https from "https";
import sharp from "sharp";
import { Telegraf, Markup } from "telegraf";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const PUZZLE_MAX_SIDE = Number(process.env.PUZZLE_MAX_SIDE || 2000);
const LINE_WIDTH = Number(process.env.PUZZLE_LINE_WIDTH || 2);
const LINE_OPACITY = Number(process.env.PUZZLE_LINE_OPACITY || 0.6);
const LINE_COLOR = process.env.PUZZLE_LINE_COLOR || "#000000";

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

function buildGridLines(width, height, rows, cols) {
  const lines = [];
  for (let c = 1; c < cols; c += 1) {
    const x = Math.round((width / cols) * c);
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" />`);
  }
  for (let r = 1; r < rows; r += 1) {
    const y = Math.round((height / rows) * r);
    lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" />`);
  }
  return lines.join("");
}

function buildGridSvg(width, height, rows, cols) {
  const lines = buildGridLines(width, height, rows, cols);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <g fill="none" stroke="${LINE_COLOR}" stroke-opacity="${LINE_OPACITY}" stroke-width="${LINE_WIDTH}" shape-rendering="crispEdges">
    ${lines}
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
  const minFont = 8;
  let fontSize = Math.max(10, Math.floor(minSide * 0.2));
  let attempt = 0;
  let wrapped = null;

  while (fontSize >= minFont && attempt < 20) {
    const lineHeight = fontSize * 1.2;
    const maxLines = Math.max(1, Math.floor((cellHeight - padding * 2) / lineHeight));
    const maxChars = Math.max(4, Math.floor((cellWidth - padding * 2) / (fontSize * 0.6)));
    wrapped = wrapText(text, maxChars, maxLines);
    if (!wrapped.truncated) {
      return { lines: wrapped.lines, fontSize, lineHeight };
    }
    fontSize -= 1;
    attempt += 1;
  }

  const lineHeight = fontSize * 1.2;
  return { lines: wrapped ? wrapped.lines : [text], fontSize, lineHeight };
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
  const lines = buildGridLines(width, height, rows, cols);
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
        `<text font-size="${fontSize}" text-anchor="middle" fill="#111" font-family="Arial, sans-serif">${tspans}</text>`
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#ffffff" />
  <g fill="none" stroke="${LINE_COLOR}" stroke-opacity="${LINE_OPACITY}" stroke-width="${LINE_WIDTH}" shape-rendering="crispEdges">
    ${lines}
  </g>
  ${textBlocks.join("\n  ")}
</svg>`;
}

async function generateFrontImage(ctx, session) {
  const fileLink = await ctx.telegram.getFileLink(session.photoFileId);
  const photoBuffer = await downloadFile(fileLink.href || String(fileLink));
  const { buffer, width, height } = await normalizePhoto(photoBuffer);
  const gridSvg = buildGridSvg(width, height, session.rows, session.cols);

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
  return `Пришли факты для пазла: ${session.facts.length}/${session.count}.\nМожно писать по одному факту или сразу несколько строками.`;
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  resetSession(ctx.from.id);
  ctx.reply(
    "Привет! Пришли фото, и я сделаю пазл: передняя сторона с сеткой и задняя с фактами.\n\nКоманды: /start, /cancel",
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
    ctx.reply("Готовлю сетку на фото...");
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

  for (const line of lines) {
    if (session.facts.length >= session.count) break;
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
