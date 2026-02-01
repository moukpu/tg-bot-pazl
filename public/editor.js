(() => {
  const params = new URLSearchParams(window.location.search);
  const pid = params.get("pid") || "";
  const rows = Number(params.get("rows") || 0);
  const cols = Number(params.get("cols") || 0);
  const width = Number(params.get("width") || 0);
  const height = Number(params.get("height") || 0);
  const seed = Number(params.get("seed") || 0);

  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  const stageWrap = document.getElementById("stageWrap");
  const textInput = document.getElementById("textInput");
  const fontSizeInput = document.getElementById("fontSize");
  const fontSizeValue = document.getElementById("fontSizeValue");
  const fontFamilyInput = document.getElementById("fontFamily");
  const newBtn = document.getElementById("newBtn");
  const autoBtn = document.getElementById("autoBtn");
  const removeBtn = document.getElementById("removeBtn");
  const sendBtn = document.getElementById("sendBtn");

  const defaultFontSize = Number(fontSizeInput.value || 18);

  function updateFontSizeValue() {
    fontSizeValue.textContent = fontSizeInput.value;
  }
  updateFontSizeValue();
  fontSizeInput.addEventListener("input", updateFontSizeValue);

  const displayWidth = Math.max(320, stageWrap.clientWidth - 2);
  const displayHeight = width && height ? (height / width) * displayWidth : Math.max(240, displayWidth * 0.7);

  const scale = width > 0 ? width / displayWidth : 1;

  const stage = new Konva.Stage({
    container: stageWrap,
    width: displayWidth,
    height: displayHeight
  });
  const gridLayer = new Konva.Layer();
  const textLayer = new Konva.Layer();
  stage.add(gridLayer);
  stage.add(textLayer);

  const transformer = new Konva.Transformer({
    rotateEnabled: false,
    enabledAnchors: [],
    ignoreStroke: true,
    borderStroke: "#2a74ff",
    borderDash: [6, 4],
    borderStrokeWidth: 1
  });
  textLayer.add(transformer);

  function sanitizeText(raw) {
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

  function createRng(seedValue) {
    let state = seedValue >>> 0;
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
    const baselineOffsets = { xMin: 51, xMax: 62, yMin: -15, yMax: 5 };
    const upperOffsets = { xMin: 20, xMax: 30, yMin: 20, yMax: 44 };

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
    const points = normalized.map((point) => [point[0], point[1] * sign]);
    return { points };
  }

  function buildDistributions(rowCount, columnCount, rng) {
    const lineGroups = [];
    lineGroups.push(new Array(columnCount).fill({ points: [[0, 0], [1, 0]] }));
    for (let i = 1; i < rowCount; i += 1) {
      const lines = [];
      for (let j = 0; j < columnCount; j += 1) {
        lines.push(edgeDistributions(rng));
      }
      lineGroups.push(lines);
    }
    lineGroups.push(new Array(columnCount).fill({ points: [[0, 0], [1, 0]] }));
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
      return `M ${a[0].toFixed(2)} ${a[1].toFixed(2)} L ${b[0].toFixed(2)} ${b[1].toFixed(2)}`;
    }
    const path = d3.line().curve(d3.curveBasis)(points);
    return path || "";
  }

  function buildPuzzlePaths(w, h, r, c, seedValue) {
    const rng = createRng(Number.isFinite(seedValue) ? seedValue : Math.floor(Math.random() * 1e9));
    const rowHeight = h / r;
    const columnWidth = w / c;

    const rowsLines = buildDistributions(r, c, rng);
    const columnsLines = buildDistributions(c, r, rng);

    const rowsOffset = offsetPoints(rowsLines, (point, i, j) => offsetPoint(point, j, i, columnWidth, rowHeight));
    const columnsOffset = offsetPoints(columnsLines, (point, i, j) =>
      offsetPoint(transposePoint(point), i, j, columnWidth, rowHeight)
    );

    const allLines = [...rowsOffset.flat(), ...columnsOffset.flat()];
    return allLines.map(lineToPath).filter(Boolean);
  }

  function drawPuzzle() {
    if (!rows || !cols) return;
    const paths = buildPuzzlePaths(displayWidth, displayHeight, rows, cols, seed || 1);
    paths.forEach((path) => {
      const shape = new Konva.Path({
        data: path,
        stroke: "#888",
        strokeWidth: 1,
        lineJoin: "round",
        lineCap: "round",
        listening: false
      });
      gridLayer.add(shape);
    });
    gridLayer.draw();
  }

  const textItems = new Map();
  let activeId = null;
  let itemCounter = 0;

  function stageCenter() {
    return { x: displayWidth / 2, y: displayHeight / 2 };
  }

  function setActive(item) {
    if (!item) {
      activeId = null;
      transformer.nodes([]);
      updateControlsFromItem(null);
      textLayer.draw();
      return;
    }
    activeId = item.id;
    transformer.nodes([item.node]);
    updateControlsFromItem(item);
    textLayer.draw();
  }

  function updateControlsFromItem(item) {
    if (!item) {
      textInput.value = "";
      fontSizeInput.value = defaultFontSize;
      fontFamilyInput.value = fontFamilyInput.value || "'Noto Sans', Arial, sans-serif";
      updateFontSizeValue();
      return;
    }
    textInput.value = item.text;
    fontSizeInput.value = item.fontSize;
    fontFamilyInput.value = item.fontFamily;
    updateFontSizeValue();
  }

  function createTextItem(initialText = "") {
    const center = stageCenter();
    const fontSize = Number(fontSizeInput.value || defaultFontSize);
    const fontFamily = fontFamilyInput.value;
    const node = new Konva.Text({
      x: center.x,
      y: center.y,
      text: initialText,
      fontSize,
      fontFamily,
      fill: "#111",
      align: "center",
      verticalAlign: "middle",
      draggable: true
    });
    node.offsetX(node.width() / 2);
    node.offsetY(node.height() / 2);
    node.on("dragmove", () => {
      node.offsetX(node.width() / 2);
      node.offsetY(node.height() / 2);
      textLayer.draw();
    });
    node.on("click", () => {
      const item = textItems.get(node.getAttr("data-id"));
      if (item) setActive(item);
    });
    textLayer.add(node);

    itemCounter += 1;
    const id = String(itemCounter);
    node.setAttr("data-id", id);
    const item = { id, node, text: initialText, fontSize, fontFamily };
    textItems.set(id, item);
    setActive(item);
    return item;
  }

  function ensureActiveItem() {
    if (activeId && textItems.has(activeId)) {
      return textItems.get(activeId);
    }
    return createTextItem("");
  }

  function updateActiveText() {
    const value = textInput.value;
    const cleaned = sanitizeText(value);
    if (cleaned !== value) {
      textInput.value = cleaned;
    }
    const item = ensureActiveItem();
    item.text = cleaned;
    item.node.text(cleaned);
    item.node.fontSize(Number(fontSizeInput.value || defaultFontSize));
    item.node.fontFamily(fontFamilyInput.value);
    item.node.offsetX(item.node.width() / 2);
    item.node.offsetY(item.node.height() / 2);
    textLayer.draw();
  }

  function updateActiveStyle() {
    if (!activeId || !textItems.has(activeId)) return;
    const item = textItems.get(activeId);
    item.fontSize = Number(fontSizeInput.value || defaultFontSize);
    item.fontFamily = fontFamilyInput.value;
    item.node.fontSize(item.fontSize);
    item.node.fontFamily(item.fontFamily);
    item.node.offsetX(item.node.width() / 2);
    item.node.offsetY(item.node.height() / 2);
    textLayer.draw();
  }

  function autoPlace() {
    if (!activeId || !textItems.has(activeId)) return;
    const item = textItems.get(activeId);
    const center = stageCenter();
    item.node.position(center);
    item.node.offsetX(item.node.width() / 2);
    item.node.offsetY(item.node.height() / 2);
    textLayer.draw();
  }

  function removeActiveText() {
    if (!activeId || !textItems.has(activeId)) return;
    const item = textItems.get(activeId);
    item.node.destroy();
    textItems.delete(activeId);
    activeId = null;
    transformer.nodes([]);
    updateControlsFromItem(null);
    textLayer.draw();
  }

  function sendData() {
    const items = [];
    textItems.forEach((item) => {
      const cleanText = sanitizeText(item.text || "");
      if (!cleanText) return;
      const node = item.node;
      const lineHeight = (node.lineHeight() || 1.2) * node.fontSize();
      items.push({
        text: cleanText,
        fontSize: item.fontSize,
        lineHeight,
        x: node.x(),
        y: node.y(),
        fontFamily: item.fontFamily
      });
    });

    const payload = {
      pid,
      rows,
      cols,
      width,
      height,
      seed,
      scale,
      items
    };

    if (tg) {
      tg.sendData(JSON.stringify(payload));
      tg.close();
    } else {
      alert("Готово. Данные в консоли.");
      console.log(payload);
    }
  }

  textInput.addEventListener("input", updateActiveText);
  fontSizeInput.addEventListener("input", () => {
    updateFontSizeValue();
    updateActiveStyle();
  });
  fontFamilyInput.addEventListener("change", updateActiveStyle);
  newBtn.addEventListener("click", () => {
    createTextItem("");
    textInput.value = "";
    updateFontSizeValue();
    textInput.focus();
  });
  autoBtn.addEventListener("click", autoPlace);
  removeBtn.addEventListener("click", removeActiveText);
  sendBtn.addEventListener("click", sendData);

  drawPuzzle();
  updateControlsFromItem(null);
})();
