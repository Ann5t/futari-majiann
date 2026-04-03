/**
 * Mahjong tile rendering utilities.
 * Maps tile IDs (136-format) to display characters and CSS classes.
 */

// Tile type (0-33) to display info
const TILE_DISPLAY = {};
const USE_SVG_TILE_ASSETS = true;
const TILE_ASSET_BASE = '/static/assets/tiles';
const TILE_ASSET_VERSION = '20260403v';
const RED_DORA_TILE_IDS = new Set([16, 52, 88]);
const RED_DORA_ASSETS = {
  4: '0m.svg',
  13: '0p.svg',
  22: '0s.svg',
};
const TILE_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const PIN_LAYOUTS = {
  1: [5],
  2: [2, 8],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
  7: [1, 3, 4, 5, 6, 7, 9],
  8: [1, 2, 3, 4, 6, 7, 8, 9],
  9: [1, 2, 3, 4, 5, 6, 7, 8, 9],
};
const SOU_LAYOUTS = {
  1: [5],
  2: [2, 8],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
  7: [1, 3, 4, 5, 6, 7, 9],
  8: [1, 2, 3, 4, 6, 7, 8, 9],
  9: [1, 2, 3, 4, 5, 6, 7, 8, 9],
};
const HONOR_ACCENTS = {
  '东': 'ink-dark',
  '南': 'ink-dark',
  '西': 'ink-dark',
  '北': 'ink-dark',
  '白': 'ink-light',
  '发': 'ink-green',
  '中': 'ink-red',
};

// Man (万子) 1-9
for (let i = 0; i < 9; i++) {
  TILE_DISPLAY[i] = {
    kind: 'man',
    char: TILE_NUMERALS[i],
    sub: '萬',
    cssClass: 'tile-man',
    label: `${i+1}m`,
    value: i + 1,
    asset: `${i+1}m.svg`,
  };
}
// Pin (筒子) 1-9
for (let i = 0; i < 9; i++) {
  TILE_DISPLAY[9 + i] = {
    kind: 'pin',
    char: TILE_NUMERALS[i],
    sub: '筒',
    cssClass: 'tile-pin',
    label: `${i+1}p`,
    value: i + 1,
    asset: `${i+1}p.svg`,
  };
}
// Sou (索子) 1-9
for (let i = 0; i < 9; i++) {
  TILE_DISPLAY[18 + i] = {
    kind: 'sou',
    char: TILE_NUMERALS[i],
    sub: '索',
    cssClass: 'tile-sou',
    label: `${i+1}s`,
    value: i + 1,
    asset: `${i+1}s.svg`,
  };
}
// Honors
const HONOR_MAP = {
  27: { kind: 'honor', char: '東', sub: '', cssClass: 'tile-honor', label: '东', asset: 'east.svg' },
  28: { kind: 'honor', char: '南', sub: '', cssClass: 'tile-honor', label: '南', asset: 'south.svg' },
  29: { kind: 'honor', char: '西', sub: '', cssClass: 'tile-honor', label: '西', asset: 'west.svg' },
  30: { kind: 'honor', char: '北', sub: '', cssClass: 'tile-honor', label: '北', asset: 'north.svg' },
  31: { kind: 'honor', char: '', sub: '', cssClass: 'tile-honor tile-haku', label: '白', asset: 'haku.svg' },
  32: { kind: 'honor', char: '發', sub: '', cssClass: 'tile-honor tile-hatsu', label: '发', asset: 'hatsu.svg' },
  33: { kind: 'honor', char: '中', sub: '', cssClass: 'tile-honor tile-chun', label: '中', asset: 'chun.svg' },
};
Object.assign(TILE_DISPLAY, HONOR_MAP);

function tileType(tileId) {
  return Math.floor(tileId / 4);
}

function isRedDoraTile(tileId) {
  return RED_DORA_TILE_IDS.has(tileId);
}

function getTileDisplay(tileId) {
  const baseDisplay = TILE_DISPLAY[tileType(tileId)];
  if (!baseDisplay) return baseDisplay;
  if (!isRedDoraTile(tileId)) return baseDisplay;
  return {
    ...baseDisplay,
    isRedDora: true,
    label: `赤${baseDisplay.label}`,
    asset: RED_DORA_ASSETS[tileType(tileId)] || baseDisplay.asset,
  };
}

function getTileTypeDisplay(tt) {
  return TILE_DISPLAY[tt];
}

function getTileTypeFromLabel(label) {
  if (label === null || label === undefined) return null;
  const normalized = String(label).trim();
  if (!normalized) return null;

  for (const [tt, display] of Object.entries(TILE_DISPLAY)) {
    if (display && display.label === normalized) {
      return Number(tt);
    }
  }

  const suitMatch = normalized.match(/^([1-9])([mps])$/i);
  if (suitMatch) {
    const value = Number(suitMatch[1]);
    const suit = suitMatch[2].toLowerCase();
    const suitOffset = suit === 'm' ? 0 : suit === 'p' ? 9 : 18;
    return suitOffset + value - 1;
  }

  return null;
}

function addCssClasses(el, cssClass) {
  if (!cssClass) return;
  const tokens = String(cssClass).trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    el.classList.add(...tokens);
  }
}

function renderGridMarks(baseClass, positions, accentResolver) {
  return positions.map((pos, index) => {
    const accent = accentResolver ? ` ${accentResolver(pos, index)}` : '';
    return `<span class="${baseClass} pos-${pos}${accent}"></span>`;
  }).join('');
}

function shouldUseSvgTileAssets(options = {}) {
  return USE_SVG_TILE_ASSETS && options.preferSvg !== false;
}

function createTileFaceMarkup(display, options = {}) {
  if (!display) return '';

  const akaBadge = display.isRedDora ? '<span class="tile-aka-badge" aria-hidden="true"></span>' : '';

  if (shouldUseSvgTileAssets(options) && display.asset) {
    return `
      <div class="tile-face-art tile-face-svg-wrap">
        <img class="tile-face-svg" src="${TILE_ASSET_BASE}/${display.asset}?v=${TILE_ASSET_VERSION}" alt="${display.label}">
        ${akaBadge}
      </div>
    `;
  }

  if (display.kind === 'pin') {
    const positions = PIN_LAYOUTS[display.value] || [];
    return `
      <div class="tile-face-art tile-face-pin">
        <span class="tile-face-corner tile-corner-top">${display.value}</span>
        <div class="tile-print-field pip-board">
          ${renderGridMarks('pip', positions, (_, index) => {
            if (display.value === 5 && index === 2) return 'accent-red';
            if (index % 3 === 1) return 'accent-green';
            return 'accent-blue';
          })}
        </div>
        <span class="tile-face-corner tile-corner-bottom">筒</span>
        ${akaBadge}
      </div>
    `;
  }

  if (display.kind === 'sou') {
    const positions = SOU_LAYOUTS[display.value] || [];
    return `
      <div class="tile-face-art tile-face-sou">
        <span class="tile-face-corner tile-corner-top">${display.value}</span>
        <div class="tile-print-field bamboo-board">
          ${renderGridMarks('bamboo-stem', positions, (_, index) => {
            if (display.value === 1) return 'accent-red';
            return index % 2 === 0 ? 'accent-green' : 'accent-emerald';
          })}
        </div>
        <span class="tile-face-corner tile-corner-bottom">索</span>
        ${akaBadge}
      </div>
    `;
  }

  if (display.kind === 'honor') {
    const accent = HONOR_ACCENTS[display.label] || 'ink-dark';
    const honorGlyph = display.label === '白'
      ? '<span class="tile-honor-glyph tile-honor-haku-mark"></span>'
      : `<span class="tile-honor-glyph ${accent}">${display.char}</span>`;
    return `
      <div class="tile-face-art tile-face-honor">
        <div class="tile-print-field tile-script-stack">
          ${honorGlyph}
        </div>
        ${akaBadge}
      </div>
    `;
  }

  return `
    <div class="tile-face-art tile-face-man">
      <span class="tile-face-corner tile-corner-top">萬</span>
      <div class="tile-print-field tile-script-stack">
        <span class="tile-script-main ink-red">${display.char}</span>
        <span class="tile-script-sub ink-red-soft">${display.sub}</span>
      </div>
      <span class="tile-face-corner tile-corner-bottom">${display.value}</span>
      ${akaBadge}
    </div>
  `;
}

function renderTileFace(el, display, options = {}) {
  if (!display) return;

  const usingSvg = shouldUseSvgTileAssets(options) && !!display.asset;
  el.classList.toggle('tile-has-svg', usingSvg);
  el.innerHTML = createTileFaceMarkup(display, options);

  if (!usingSvg) {
    return;
  }

  const tileImg = el.querySelector('.tile-face-svg');
  if (!tileImg) {
    return;
  }

  tileImg.addEventListener('error', () => {
    if (el.dataset.tileFaceFallback === '1') {
      return;
    }
    el.dataset.tileFaceFallback = '1';
    el.classList.remove('tile-has-svg');
    el.innerHTML = createTileFaceMarkup(display, { preferSvg: false });
  }, { once: true });
}

/**
 * Create a tile DOM element.
 * @param {number|null} tileId - 136-format ID, or null for back
 * @param {object} options - { size: 'normal'|'small'|'mini', clickable, selected, rotated }
 */
function createTileElement(tileId, options = {}) {
  const el = document.createElement('div');
  el.className = 'tile';

  if (options.size === 'small') el.classList.add('small');
  if (options.size === 'mini') el.classList.add('mini');
  if (options.rotated) el.classList.add('rotated');

  if (tileId === null || tileId === undefined) {
    el.classList.add('tile-back');
    return el;
  }

  el.classList.add('tile-front');
  const display = getTileDisplay(tileId);
  if (display) {
    addCssClasses(el, display.cssClass);
    if (display.isRedDora) {
      el.classList.add('tile-aka-dora');
      el.dataset.redDora = '1';
    }
    renderTileFace(el, display);
    el.title = display.label;
  }

  if (options.clickable) {
    el.classList.add('clickable');
  }
  if (options.selected) {
    el.classList.add('selected');
  }

  el.dataset.tileId = tileId;
  el.dataset.tileType = tileType(tileId);

  return el;
}

/**
 * Create a tile element from tile type (0-33) instead of 136-format ID.
 */
function createTileTypeElement(tt, options = {}) {
  const el = document.createElement('div');
  el.className = 'tile';

  if (options.size === 'small') el.classList.add('small');
  if (options.size === 'mini') el.classList.add('mini');

  el.classList.add('tile-front');
  const display = TILE_DISPLAY[tt];
  if (display) {
    addCssClasses(el, display.cssClass);
    renderTileFace(el, display);
    el.title = display.label;
  }

  if (options.clickable) el.classList.add('clickable');
  if (options.selected) el.classList.add('selected');

  el.dataset.tileType = tt;
  return el;
}
