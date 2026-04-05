import { expect, test, Page, Browser, BrowserContext, APIRequestContext } from '@playwright/test';

declare const process: { env: Record<string, string | undefined> };

const P1 = { username: process.env.E2E_USER1 || 'player1', password: process.env.E2E_PASS1 || 'pass1' };
const P2 = { username: process.env.E2E_USER2 || 'player2', password: process.env.E2E_PASS2 || 'pass2' };
const AUDIO_PLAY_LOG_KEY = '__futari_audio_play_log__';

async function resetRooms(request: APIRequestContext) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await request.post('/api/test/reset-rooms', {
      failOnStatusCode: false,
    });
    if (response.ok()) {
      return;
    }

    const body = await response.json().catch(() => null);
    const detail = body && typeof body === 'object' ? (body as { detail?: string }).detail : null;
    const routeNotReady = response.status() === 404 && detail === 'Not Found';
    const transientFailure = response.status() >= 500 || routeNotReady;
    if (!transientFailure) {
      throw new Error(`reset-rooms failed: ${response.status()} ${JSON.stringify(body)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('reset-rooms hook 未在预期时间内就绪');
}

async function postBackendHookWithRetry(page: Page, path: string, payload: Record<string, unknown>) {
  let lastResponse: { ok: boolean; status: number; body: unknown } | null = null;

  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await page.evaluate(async ({ requestPath, requestPayload }) => {
      const token = sessionStorage.getItem('token');
      const res = await fetch(requestPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestPayload),
      });
      return {
        ok: res.ok,
        status: res.status,
        body: await res.json().catch(() => null),
      };
    }, { requestPath: path, requestPayload: payload });

    if (response.ok) {
      return response.body;
    }

    lastResponse = response;
    const detail = response.body && typeof response.body === 'object'
      ? (response.body as { detail?: string }).detail
      : null;
    const routeNotReady = response.status === 404 && detail === 'Not Found';
    const transientFailure = response.status >= 500 || routeNotReady;

    if (!transientFailure) {
      expect(response.ok, `backend hook failed: ${JSON.stringify(response.body)}`).toBeTruthy();
    }

    await page.waitForTimeout(500);
  }

  expect(lastResponse?.ok, `backend hook failed after retries: ${JSON.stringify(lastResponse?.body)}`).toBeTruthy();
  return lastResponse?.body;
}

async function login(page: Page, username: string, password: string) {
  await page.goto('/');
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#loginBtn').click();
  await expect(page).toHaveURL(/\/(lobby|game)/);
}

async function createRoom(page: Page) {
  await page.locator('#createBtn').click();
  await expect(page).toHaveURL(/\/game/, { timeout: 10_000 });
}

async function joinFirstAvailableRoom(page: Page) {
  for (let i = 0; i < 6; i++) {
    const joinBtn = page.locator('.room-card button:has-text("加入")').first();
    if (await joinBtn.count()) {
      await joinBtn.click();
      return;
    }
    await page.waitForTimeout(500);
    await page.reload();
  }
  throw new Error('未找到可加入房间');
}

async function assertGameShell(page: Page) {
  await expect(page).toHaveURL(/\/game/);
  await expect(page.locator('#roundInfo')).toBeVisible();
  await expect(page.locator('#wallCount')).toBeVisible();
  await expect(page.locator('#myTiles')).toBeVisible();
  await expect(page.locator('#oppTiles')).toBeVisible();
  await expect.poll(async () => {
    return page.locator('#doraIndicators .tile').count();
  }).toBeGreaterThan(0);
}

async function assertTurnUi(page: Page, isMyTurn: boolean) {
  await expect.poll(async () => {
    return page.evaluate(() => {
      const myBadge = document.querySelector('.player-info .turn-badge')?.textContent?.trim() || '';
      const oppBadge = document.querySelector('.opponent-info .turn-badge')?.textContent?.trim() || '';
      const playerActive = document.querySelector('.player-area')?.classList.contains('active-turn') || false;
      const opponentActive = document.querySelector('.opponent-area')?.classList.contains('active-turn') || false;
      return { myBadge, oppBadge, playerActive, opponentActive };
    });
  }, { timeout: 5_000 }).toEqual(isMyTurn
    ? {
        myBadge: '你的回合',
        oppBadge: '',
        playerActive: true,
        opponentActive: false,
      }
    : {
        myBadge: '',
        oppBadge: '对手回合',
        playerActive: false,
        opponentActive: true,
      });
}

async function getClientSnapshot(page: Page) {
  return page.evaluate(() => {
    try {
      const gameState = globalThis.eval('state') as {
        mySeat: number;
        currentTurn: number;
        phase: string;
        roundNumber: number;
        wallRemaining: number;
        doraIndicators: number[];
        myDiscards: number[];
        oppDiscards: number[];
        myPoints: number;
        oppPoints: number;
        roundReadySeats: number[];
        tenpaiDeclarer: number | null;
        phase2DrawCount: number;
        myMelds: Array<unknown>;
        oppMelds: Array<unknown>;
        myDrawTile: number | null;
      };
      const passBtn = document.getElementById('btnPass');
      return {
        mySeat: gameState.mySeat,
        currentTurn: gameState.currentTurn,
        phase: gameState.phase,
        roundNumber: gameState.roundNumber,
        wallRemaining: gameState.wallRemaining,
        doraCount: gameState.doraIndicators.length,
        totalDiscards: gameState.myDiscards.length + gameState.oppDiscards.length,
        myDiscardsCount: gameState.myDiscards.length,
        oppDiscardsCount: gameState.oppDiscards.length,
        clickableCount: document.querySelectorAll('#myTiles .tile.clickable').length,
        passVisible: !!passBtn && getComputedStyle(passBtn).display !== 'none',
        myPoints: gameState.myPoints,
        oppPoints: gameState.oppPoints,
        roundReadySeats: gameState.roundReadySeats || [],
        tenpaiDeclarer: gameState.tenpaiDeclarer,
        phase2DrawCount: gameState.phase2DrawCount || 0,
        myMeldsCount: (gameState.myMelds || []).length,
        oppMeldsCount: (gameState.oppMelds || []).length,
        myMeldTypes: (gameState.myMelds || []).map((meld: { type?: string }) => meld.type || null),
        oppMeldTypes: (gameState.oppMelds || []).map((meld: { type?: string }) => meld.type || null),
        myFirstMeldType: (gameState.myMelds || [])[0] ? (gameState.myMelds as Array<{ type?: string }>)[0].type || null : null,
        oppFirstMeldType: (gameState.oppMelds || [])[0] ? (gameState.oppMelds as Array<{ type?: string }>)[0].type || null : null,
        myDrawTileType: gameState.myDrawTile === null ? null : Math.floor(gameState.myDrawTile / 4),
      };
    } catch {
      return {
        mySeat: -1,
        currentTurn: -1,
        phase: 'boot',
        roundNumber: 0,
        wallRemaining: 0,
        doraCount: 0,
        totalDiscards: 0,
        myDiscardsCount: 0,
        oppDiscardsCount: 0,
        clickableCount: 0,
        passVisible: false,
        myPoints: 0,
        oppPoints: 0,
        roundReadySeats: [],
        tenpaiDeclarer: null,
        phase2DrawCount: 0,
        myMeldsCount: 0,
        oppMeldsCount: 0,
        myMeldTypes: [],
        oppMeldTypes: [],
        myFirstMeldType: null,
        oppFirstMeldType: null,
        myDrawTileType: null,
      };
    }
  });
}

async function passIfCallAvailable(page: Page) {
  const snapshot = await getClientSnapshot(page);
  if (snapshot.passVisible) {
    await page.locator('#btnPass').click();
  }
}

async function waitForResultRevealComplete(page: Page) {
  await expect(page.locator('#resultOverlay')).toBeVisible();
  await expect.poll(async () => {
    return page.evaluate(() => {
      const points = document.getElementById('resultPoints');
      return !!points && points.classList.contains('reveal-in');
    });
  }, { timeout: 5_000 }).toBe(true);
}

async function expectResultRevealStatic(page: Page) {
  await expect(page.locator('#resultOverlay')).toBeVisible();
  await expect.poll(async () => {
    return page.evaluate(() => {
      const overlay = document.getElementById('resultOverlay');
      const box = overlay?.querySelector('.result-box');
      const title = document.getElementById('resultTitle');
      const yakuList = document.getElementById('resultYaku');
      const score = document.getElementById('resultScore');
      const points = document.getElementById('resultPoints');
      const stages = [title, yakuList, score, points].filter(Boolean) as HTMLElement[];
      return {
        staticMode: !!overlay?.classList.contains('result-restore-static'),
        hiddenStageCount: stages.filter((el) => el.classList.contains('result-stage') && !el.classList.contains('reveal-in')).length,
        overlayAnimationName: overlay ? getComputedStyle(overlay).animationName : null,
        boxAnimationName: box ? getComputedStyle(box).animationName : null,
        titleAnimationName: title ? getComputedStyle(title).animationName : null,
      };
    });
  }, { timeout: 5_000 }).toEqual({
    staticMode: true,
    hiddenStageCount: 0,
    overlayAnimationName: 'none',
    boxAnimationName: 'none',
    titleAnimationName: 'none',
  });
}

async function waitUntilCanDiscard(page: Page) {
  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(page);
    return snapshot.clickableCount;
  }, { timeout: 15_000 }).toBeGreaterThan(0);
}

async function waitForActionTurn(p1: Page, p2: Page, minTotalDiscards: number) {
  for (let i = 0; i < 80; i++) {
    await Promise.all([
      passIfCallAvailable(p1),
      passIfCallAvailable(p2),
    ]);

    const [p1State, p2State] = await Promise.all([
      getClientSnapshot(p1),
      getClientSnapshot(p2),
    ]);

    const p1Active = p1State.phase === 'phase1_action'
      && p1State.currentTurn === p1State.mySeat
      && p1State.clickableCount > 0;
    const p2Active = p2State.phase === 'phase1_action'
      && p2State.currentTurn === p2State.mySeat
      && p2State.clickableCount > 0;
    const turnSynced = p1State.currentTurn === p2State.currentTurn;
    const totalDiscards = Math.max(p1State.totalDiscards, p2State.totalDiscards);

    if (turnSynced && totalDiscards >= minTotalDiscards && (p1Active || p2Active)) {
      return {
        activePage: p1Active ? p1 : p2,
        waitingPage: p1Active ? p2 : p1,
        activeState: p1Active ? p1State : p2State,
        waitingState: p1Active ? p2State : p1State,
        totalDiscards,
      };
    }

    await p1.waitForTimeout(250);
  }

  throw new Error('等待下一位可操作玩家超时');
}

async function discardFirstClickableTile(page: Page) {
  await waitUntilCanDiscard(page);
  const firstTile = page.locator('#myTiles .tile.clickable').first();
  const tileId = await firstTile.getAttribute('data-tile-id');
  if (!tileId) {
    throw new Error('未找到可打出的手牌');
  }

  const target = page.locator(`#myTiles .tile.clickable[data-tile-id="${tileId}"]`).first();
  await target.click();
  await page.locator(`#myTiles .tile.selected[data-tile-id="${tileId}"]`).click();
}

async function discardCurrentDrawTile(page: Page) {
  await waitUntilCanDiscard(page);
  const drawTileId = await page.evaluate(() => globalThis.eval('state.myDrawTile') as number | null);
  if (drawTileId === null) {
    throw new Error('当前没有摸牌可打');
  }

  const selector = `#myTiles .tile.clickable[data-tile-id="${drawTileId}"]`;
  const selectedSelector = `#myTiles .tile.selected[data-tile-id="${drawTileId}"]`;
  if (await page.locator(selectedSelector).count() === 0) {
    await page.locator(selector).first().click({ force: true });
  }
  await expect(page.locator(selectedSelector).first()).toBeVisible();
  await page.locator(selectedSelector).first().click({ force: true });
}

async function discardClickableTileOfType(page: Page, tileType: number) {
  await waitUntilCanDiscard(page);

  const selector = `#myTiles .tile.clickable[data-tile-type="${tileType}"]`;
  const selectedSelector = `#myTiles .tile.selected[data-tile-type="${tileType}"]`;
  const target = page.locator(selector).first();

  await expect(target).toBeVisible();
  if (await page.locator(selectedSelector).count() === 0) {
    await target.click({ force: true });
  }
  await expect(page.locator(selectedSelector).first()).toBeVisible();
  await page.locator(selectedSelector).first().click({ force: true });
}

async function finishPhase2DrawSequenceByDiscardingDrawTile(page: Page, drawsToResolve: number) {
  for (let i = 0; i < drawsToResolve; i++) {
    await expect.poll(async () => {
      const snapshot = await getClientSnapshot(page);
      return snapshot.phase === 'phase2_action' ? snapshot.phase2DrawCount : -1;
    }, { timeout: 15_000 }).toBe(i + 1);

    await discardCurrentDrawTile(page);
  }
}

async function readyIfWaiting(page: Page) {
  const readyBtn = page.locator('#btnRoomReady');
  if (await readyBtn.isVisible().catch(() => false)) {
    await readyBtn.click();
  }
}

async function readyBothUntilStarted(p1: Page, p2: Page) {
  for (let i = 0; i < 80; i++) {
    const [p1State, p2State] = await Promise.all([
      getClientSnapshot(p1),
      getClientSnapshot(p2),
    ]);
    const bothStarted = [p1State, p2State].every((snapshot) => (
      snapshot.phase !== 'waiting'
      && snapshot.roundNumber > 0
      && snapshot.wallRemaining > 0
      && snapshot.doraCount > 0
    ));
    if (bothStarted) return;

    await Promise.all([
      readyIfWaiting(p1),
      readyIfWaiting(p2),
    ]);
    await p1.waitForTimeout(400);
  }
  throw new Error('双方准备后未能进入对局');
}

async function installAudioPlaySpy(context: BrowserContext) {
  await context.addInitScript((storageKey) => {
    const readLog = () => {
      try {
        const raw = sessionStorage.getItem(storageKey);
        return raw ? JSON.parse(raw) : [];
      } catch {
        return [];
      }
    };

    const writeLog = (entries: Array<{ src: string; currentSrc: string; ts: number }>) => {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(entries));
      } catch {
        // Ignore storage errors in tests.
      }
    };

    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function patchedPlay(...args) {
      const entries = readLog();
      entries.push({
        src: this.src || '',
        currentSrc: this.currentSrc || '',
        ts: Date.now(),
      });
      writeLog(entries);
      return originalPlay.apply(this, args);
    };
  }, AUDIO_PLAY_LOG_KEY);
}

async function openTwoPlayers(browser: Browser) {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();
  return { ctx1, ctx2, p1, p2 };
}

async function clearAudioPlayLog(page: Page) {
  await page.evaluate((storageKey) => {
    sessionStorage.removeItem(storageKey);
  }, AUDIO_PLAY_LOG_KEY);
}

async function countAudioPlayByFragment(page: Page, fragment: string) {
  return page.evaluate(({ storageKey, matchFragment }) => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      const entries = raw ? JSON.parse(raw) : [];
      return entries.filter((entry: { src?: string; currentSrc?: string }) => {
        return (entry.currentSrc || entry.src || '').includes(matchFragment);
      }).length;
    } catch {
      return 0;
    }
  }, { storageKey: AUDIO_PLAY_LOG_KEY, matchFragment: fragment });
}

async function mountPhase2GuessPanel(page: Page, alreadyGuessed: number[], mySeat = 1, declarerSeat = 0, declarerDiscardTypes: number[] = []) {
  await page.goto('/game');
  await expect(page.locator('#guessPanel')).toHaveCount(1);

  await page.evaluate(({ guessed, seat, tenpaiDeclarer, discardTypes }) => {
    const state = globalThis.eval('state') as {
      mySeat: number;
      tenpaiDeclarer: number | null;
      myHand: number[];
      myDrawTile: number | null;
      myDiscards: number[];
      oppDiscards: number[];
    };
    state.mySeat = seat;
    state.tenpaiDeclarer = tenpaiDeclarer;
    state.myHand = [0, 4, 8, 36, 40, 44, 72, 76, 80, 108, 109, 124, 128];
    state.myDrawTile = null;
    state.myDiscards = [];
    state.oppDiscards = [];

    const declarerDiscardIds = discardTypes.map((tileType) => tileType * 4);
    if (seat === tenpaiDeclarer) {
      state.myDiscards = declarerDiscardIds;
    } else {
      state.oppDiscards = declarerDiscardIds;
    }

    globalThis.eval('renderAll()');
    globalThis.eval(`onPhase2GuessRequest(${JSON.stringify({
      message: '5次摸牌结束，未和牌。请再次选择2张牌进行猜测。',
      already_guessed: guessed,
    })});`);
  }, {
    guessed: alreadyGuessed,
    seat: mySeat,
    tenpaiDeclarer: declarerSeat,
    discardTypes: declarerDiscardTypes,
  });

  await expect(page.locator('#guessPanel')).toBeVisible();
}

async function triggerBackendPhase2GuessRequest(page: Page, alreadyGuessed: number[], tenpaiDeclarer?: number) {
  return triggerBackendPhase2Scenario(page, {
    already_guessed: alreadyGuessed,
    tenpai_declarer: tenpaiDeclarer,
    message: '5次摸牌结束，未和牌。请再次选择2张牌进行猜测。',
  });
}

async function triggerBackendPhase2Scenario(page: Page, payload: Record<string, unknown>) {
  return postBackendHookWithRetry(page, '/api/test/phase2-guess-request', payload);
}

async function triggerBackendPhase1ActionScenario(page: Page, payload: Record<string, unknown>) {
  return postBackendHookWithRetry(page, '/api/test/phase1-action-state', payload);
}

async function triggerBackendGameOverState(page: Page, payload: Record<string, unknown>) {
  return postBackendHookWithRetry(page, '/api/test/game-over-state', payload);
}

async function mountTurnIndicatorFixture(page: Page) {
  await page.goto('/game');
  await page.waitForFunction(() => {
    try {
      return typeof globalThis.eval('state') !== 'undefined';
    } catch {
      return false;
    }
  });
  await page.evaluate(() => {
    globalThis.eval(`
      if (typeof ws !== 'undefined' && ws && ws.readyState < 2) {
        ws.close();
      }
      state.mySeat = 0;
      state.phase = 'waiting';
      state.myHand = [];
      state.myDrawTile = null;
      state.myMelds = [];
      state.myDiscards = [];
      state.myPoints = 0;
      state.oppClosedCount = 13;
      state.oppMelds = [];
      state.oppDiscards = [];
      state.oppPoints = 0;
      state.oppName = 'player2';
      state.dealerSeat = 1;
      state.roundNumber = 0;
      state.wallRemaining = 70;
      state.doraIndicators = [];
      state.timerRemaining = 1800;
      state.isLastRound = false;
      state.currentTurn = 1;
      state.tenpaiDeclarer = null;
      state.myDeclaredTenpai = false;
      state.oppDeclaredTenpai = false;
      state.myWaitingTiles = [];
      state.roomPlayers = [];
      state.roomReadyBySeat = {};
      actions = {};
      selectedTile = null;
      onRoundStart({
        dealer_seat: 0,
        current_turn: 0,
        round_number: 1,
        wall_remaining: 69,
        dora_indicators: [],
        is_last_round: false,
      });
      state.myHand = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48];
      onDrawTile({
        tile: 52,
        actions: { must_discard: true },
        waiting_tiles: [],
      });
    `);
  });
}

async function mountDiscardLayoutFixture(page: Page) {
  await page.goto('/game');
  await page.waitForFunction(() => {
    try {
      return typeof globalThis.eval('state') !== 'undefined';
    } catch {
      return false;
    }
  });

  await page.evaluate(() => {
    globalThis.eval(`
      if (typeof ws !== 'undefined' && ws && ws.readyState < 2) {
        ws.close();
      }
    `);
  });
}

async function seedDiscardLayoutFixture(page: Page, discardCount: number) {
  await page.evaluate(({ count }) => {
    const gameState = globalThis.eval('state') as {
      mySeat: number;
      phase: string;
      myHand: number[];
      myDrawTile: number | null;
      myMelds: Array<Record<string, unknown>>;
      myDiscards: number[];
      myPoints: number;
      oppClosedCount: number;
      oppMelds: Array<Record<string, unknown>>;
      oppDiscards: number[];
      oppPoints: number;
      oppName: string;
      dealerSeat: number;
      roundNumber: number;
      wallRemaining: number;
      doraIndicators: number[];
      timerRemaining: number;
      isLastRound: boolean;
      currentTurn: number;
      tenpaiDeclarer: number | null;
      myDeclaredTenpai: boolean;
      myDeclaredRiichi: boolean;
      oppDeclaredTenpai: boolean;
      oppDeclaredRiichi: boolean;
      honbaCount: number;
      riichiSticks: number;
      myWaitingTiles: number[];
      roomPlayers: Array<unknown>;
      roomReadyBySeat: Record<number, boolean>;
      roundReadySeats: number[];
      roomOwnerSeat: number | null;
      roomTimerMinutes: number;
      gameOverData: unknown;
    };
    const makeDiscards = (offset: number) => Array.from({ length: count }, (_, index) => (index * 4 + offset) % 136);

    gameState.mySeat = 0;
    gameState.phase = 'phase1_action';
    gameState.myHand = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52];
    gameState.myDrawTile = 52;
    gameState.myMelds = [{ type: 'pon', tiles: [72, 73, 74], called_tile: 73 }];
    gameState.myDiscards = makeDiscards(0);
    gameState.myPoints = 6400;
    gameState.oppClosedCount = 10;
    gameState.oppMelds = [{ type: 'minkan', tiles: [80, 81, 82, 83], called_tile: 83 }];
    gameState.oppDiscards = makeDiscards(1);
    gameState.oppPoints = 7600;
    gameState.oppName = 'player2';
    gameState.dealerSeat = 1;
    gameState.roundNumber = 1;
    gameState.wallRemaining = Math.max(8, 70 - count * 2);
    gameState.doraIndicators = [60, 64];
    gameState.timerRemaining = 321;
    gameState.isLastRound = false;
    gameState.currentTurn = 0;
    gameState.tenpaiDeclarer = null;
    gameState.myDeclaredTenpai = false;
    gameState.myDeclaredRiichi = false;
    gameState.oppDeclaredTenpai = false;
    gameState.oppDeclaredRiichi = false;
    gameState.honbaCount = 1;
    gameState.riichiSticks = 0;
    gameState.myWaitingTiles = [];
    gameState.roomPlayers = [];
    gameState.roomReadyBySeat = {};
    gameState.roundReadySeats = [];
    gameState.roomOwnerSeat = 0;
    gameState.roomTimerMinutes = 30;
    gameState.gameOverData = null;

    globalThis.eval(`
      actions = { must_discard: true };
      selectedTile = null;
      guessSelected = new Set();
      guessMarked = new Set();
      document.getElementById('resultOverlay').style.display = 'none';
      document.getElementById('gameOverOverlay').style.display = 'none';
    `);
    globalThis.eval('renderAll()');
  }, { count: discardCount });

  await expect(page.locator('#myDiscard .tile')).toHaveCount(discardCount);
  await expect(page.locator('#oppDiscard .tile')).toHaveCount(discardCount);
}

async function collectDiscardLayoutMetrics(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return {
        top: Math.round(box.top),
        right: Math.round(box.right),
        bottom: Math.round(box.bottom),
        left: Math.round(box.left),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    };

    const pond = (selector: string) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        tileCount: el.querySelectorAll('.tile').length,
        gridColumns: style.gridTemplateColumns.split(' ').filter(Boolean).length,
      };
    };

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      opponentTiles: rect('#oppTiles'),
      discardArea: rect('.discard-area'),
      playerArea: rect('.player-area'),
      playerInfo: rect('.player-info'),
      myTiles: rect('#myTiles'),
      leftPanel: rect('.table-side-panel-left'),
      rightPanel: rect('.table-side-panel-right'),
      myPond: pond('#myDiscard'),
      oppPond: pond('#oppDiscard'),
    };
  });
}

test.beforeEach(async ({ request }) => {
  await resetRooms(request);
});

test('双端对战冒烟：进入对局并完成至少两次打牌', async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  const p1InGame = /\/game$/.test(p1.url());
  const p2InGame = /\/game$/.test(p2.url());

  if (!p1InGame || !p2InGame) {
    if (!p1InGame) {
      await createRoom(p1);
    }
    if (!p2InGame) {
      await joinFirstAvailableRoom(p2);
    }
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  await assertGameShell(p1);
  await assertGameShell(p2);

  const p1Name = await p1.locator('#myName').innerText();
  const p2Name = await p2.locator('#myName').innerText();
  expect(p1Name.trim()).toBe(P1.username);
  expect(p2Name.trim()).toBe(P2.username);

  const p1DealerVisible = await p1.locator('#myDealer').isVisible();
  const p2DealerVisible = await p2.locator('#myDealer').isVisible();
  expect(Number(p1DealerVisible) + Number(p2DealerVisible)).toBe(1);

  const p1WallText = await p1.locator('#wallCount').innerText();
  const p2WallText = await p2.locator('#wallCount').innerText();
  expect(p1WallText).toMatch(/余牌:\s*\d+/);
  expect(p2WallText).toMatch(/余牌:\s*\d+/);

  // UI hooks introduced in recent rounds should always exist.
  await expect(p1.locator('#myWaits')).toHaveCount(1);
  await expect(p2.locator('#myWaits')).toHaveCount(1);
  await expect(p1.locator('#resultDora')).toHaveCount(1);
  await expect(p2.locator('#resultDora')).toHaveCount(1);

  // Ensure opposite player labels are visible.
  await expect(p1.locator('#oppName')).toContainText(P2.username);
  await expect(p2.locator('#oppName')).toContainText(P1.username);

  const initialState = await getClientSnapshot(p1);
  const initialTotalDiscards = initialState.totalDiscards;
  const firstTurn = await waitForActionTurn(p1, p2, initialTotalDiscards);
  expect(firstTurn.activeState.currentTurn).toBe(firstTurn.activeState.mySeat);
  expect(firstTurn.waitingState.currentTurn).toBe(firstTurn.activeState.mySeat);
  expect(firstTurn.activeState.wallRemaining).toBe(firstTurn.waitingState.wallRemaining);

  if (initialTotalDiscards === 0) {
    const dealerPage = p1DealerVisible ? p1 : p2;
    expect(firstTurn.activePage).toBe(dealerPage);
  }

  await discardFirstClickableTile(firstTurn.activePage);

  const secondTurn = await waitForActionTurn(p1, p2, initialTotalDiscards + 1);
  expect(secondTurn.activeState.currentTurn).toBe(secondTurn.activeState.mySeat);
  expect(secondTurn.waitingState.currentTurn).toBe(secondTurn.activeState.mySeat);
  expect(secondTurn.activeState.wallRemaining).toBe(secondTurn.waitingState.wallRemaining);

  await discardFirstClickableTile(secondTurn.activePage);

  const thirdTurn = await waitForActionTurn(p1, p2, initialTotalDiscards + 2);
  expect(thirdTurn.totalDiscards).toBeGreaterThanOrEqual(initialTotalDiscards + 2);

  await ctx1.close();
  await ctx2.close();
});

test('等待房间：未开局时隐藏局内信息，双方准备后再切回对局桌面', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  await createRoom(p1);
  await expect(p1.locator('#app')).toHaveClass(/waiting-room-scene/);
  await expect(p1.locator('#roomReadyBar')).toBeVisible();
  await expect(p1.locator('#myRoomStatus')).toHaveText('未准备');
  await expect(p1.locator('#oppRoomStatus')).toHaveText('等待加入');
  await expect(p1.locator('#roundInfo')).toBeHidden();
  await expect(p1.locator('#wallCount')).toBeHidden();
  await expect(p1.locator('#oppTiles')).toBeHidden();
  await expect(p1.locator('#myTiles')).toBeHidden();
  await expect(p1.locator('#oppDiscard')).toBeHidden();
  await expect(p1.locator('#myDiscard')).toBeHidden();

  await joinFirstAvailableRoom(p2);
  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await expect(p1.locator('#app')).toHaveClass(/waiting-room-scene/);
  await expect(p2.locator('#app')).toHaveClass(/waiting-room-scene/);
  await expect(p1.locator('#oppRoomStatus')).toHaveText('未准备');
  await expect(p2.locator('#oppRoomStatus')).toHaveText('未准备');
  await expect(p1.locator('#roomReadyText')).toHaveText('双方准备后将自动开始对局');

  await p1.locator('#btnRoomReady').click();
  await expect(p1.locator('#myRoomStatus')).toHaveText('已准备');
  await expect(p2.locator('#oppRoomStatus')).toHaveText('已准备');

  await readyBothUntilStarted(p1, p2);

  await expect(p1.locator('#app')).not.toHaveClass(/waiting-room-scene/);
  await expect(p2.locator('#app')).not.toHaveClass(/waiting-room-scene/);
  await expect(p1.locator('#roundInfo')).toBeVisible();
  await expect(p2.locator('#roundInfo')).toBeVisible();
  await expect(p1.locator('#myTiles')).toBeVisible();
  await expect(p2.locator('#myTiles')).toBeVisible();

  await ctx1.close();
  await ctx2.close();
});

test('双端余牌显示：自己摸牌进入操作态时双方余牌一致', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const initialState = await getClientSnapshot(p1);
  const firstTurn = await waitForActionTurn(p1, p2, initialState.totalDiscards);
  expect(firstTurn.activeState.wallRemaining).toBe(firstTurn.waitingState.wallRemaining);

  await discardFirstClickableTile(firstTurn.activePage);

  const secondTurn = await waitForActionTurn(p1, p2, initialState.totalDiscards + 1);
  expect(secondTurn.activeState.wallRemaining).toBe(secondTurn.waitingState.wallRemaining);

  await ctx1.close();
  await ctx2.close();
});

test('余牌同步：同局内旧 game_state 不应把余牌回写到更大值', async ({ browser }) => {
  test.setTimeout(45_000);

  const context = await browser.newContext();
  const page = await context.newPage();

  await login(page, P1.username, P1.password);
  await mountTurnIndicatorFixture(page);

  const wallRemaining = await page.evaluate(() => {
    globalThis.eval(`
      state.phase = 'phase1_action';
      state.roundNumber = 3;
      state.wallRemaining = 57;
      applyFullState({
        type: 'game_state',
        my_seat: state.mySeat,
        phase: 'phase1_action',
        my_hand: { closed: state.myHand, draw_tile: state.myDrawTile, melds: state.myMelds, discards: state.myDiscards },
        my_points: state.myPoints,
        my_declared_tenpai: false,
        my_declared_riichi: false,
        opponent_hand: { closed_count: state.oppClosedCount, melds: state.oppMelds, discards: state.oppDiscards },
        opponent_points: state.oppPoints,
        opponent_name: state.oppName,
        opponent_declared_tenpai: false,
        opponent_declared_riichi: false,
        my_waiting_tiles: [],
        dealer_seat: state.dealerSeat,
        round_number: 3,
        wall: { remaining: 58, dora_indicators: state.doraIndicators },
        timer_remaining: state.timerRemaining,
        is_last_round: state.isLastRound,
        current_turn: state.currentTurn,
        tenpai_declarer: state.tenpaiDeclarer,
        honba_count: state.honbaCount,
        riichi_sticks: state.riichiSticks,
        phase2_draw_count: state.phase2DrawCount,
        round_ready_seats: state.roundReadySeats,
        phase2_guessed_types: state.phase2GuessedTypes,
        actions: {},
      });
    `);
    return globalThis.eval('state.wallRemaining');
  });

  expect(wallRemaining).toBe(57);

  await context.close();
});

test('余牌同步：碰后弃牌并进入下一摸时双方余牌一致', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const actorPage = p1State.mySeat === 0 ? p1 : p2;
  const callerPage = actorPage === p1 ? p2 : p1;
  const actorSeat = p1State.mySeat === 0 ? p1State.mySeat : p2State.mySeat;

  await triggerBackendPhase1ActionScenario(actorPage, {
    actor_closed: ['1m', '2m', '3m', '7m', '8m', '9m', '1p', '2p', '3p', '7p', '8p', '9p', '北'],
    actor_draw: '5m',
    opponent_closed: ['5m', '5m', '1s', '2s', '3s', '7s', '8s', '9s', '东', '南', '西', '白', '发'],
    dora_indicator: '6p',
    actor_points: 25000,
    opponent_points: 25000,
  });

  const [beforeCallActor, beforeCallCaller] = await Promise.all([
    getClientSnapshot(actorPage),
    getClientSnapshot(callerPage),
  ]);
  expect(beforeCallActor.wallRemaining).toBe(beforeCallCaller.wallRemaining);
  const wallBeforeCall = beforeCallActor.wallRemaining;

  await discardCurrentDrawTile(actorPage);

  await expect(callerPage.locator('#btnPon')).toBeVisible();
  await callerPage.locator('#btnPon').click();

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(callerPage);
    return {
      phase: snapshot.phase,
      myMeldsCount: snapshot.myMeldsCount,
      wallRemaining: snapshot.wallRemaining,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase1_action',
    myMeldsCount: 1,
    wallRemaining: wallBeforeCall,
  });

  await discardClickableTileOfType(callerPage, 26);

  const nextTurn = await waitForActionTurn(actorPage, callerPage, 2);
  expect(nextTurn.activeState.mySeat).toBe(actorSeat);
  expect(nextTurn.activeState.wallRemaining).toBe(wallBeforeCall - 1);
  expect(nextTurn.waitingState.wallRemaining).toBe(wallBeforeCall - 1);

  await ctx1.close();
  await ctx2.close();
});

test('余牌同步：加杠岭上补牌后双方余牌保持一致', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State2, p2State2] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const declarerPage = p1State2.mySeat === 0 ? p1 : p2;
  const guesserPage = declarerPage === p1 ? p2 : p1;
  const declarerSeat = p1State2.mySeat === 0 ? p1State2.mySeat : p2State2.mySeat;

  await triggerBackendPhase2Scenario(guesserPage, {
    already_guessed: [],
    tenpai_declarer: declarerSeat,
    message: '请先猜错以进入 Phase2 摸牌。',
    declarer_closed: ['1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '4m'],
    declarer_melds: [{ type: 'pon', tiles: ['5m', '5m', '5m'], called_index: 2 }],
    guesser_closed: ['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
    wall_draw_sequence: ['5m', '9p', '9s', '北', '中', '7p'],
    dora_indicator: '6p',
    rinshan_sequence: ['西'],
  });

  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="4"]').click();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="10"]').click();
  await expect(guesserPage.locator('#guessCount')).toContainText('已选: 2 / 2');
  await expect(guesserPage.locator('#guessConfirm')).toBeEnabled();
  await guesserPage.evaluate(() => {
    const confirm = document.getElementById('guessConfirm');
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('猜牌确认按钮未就绪');
    }
    confirm.click();
  });

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      doraCount: snapshot.doraCount,
      myFirstMeldType: snapshot.myFirstMeldType,
      myDrawTileType: snapshot.myDrawTileType,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 1,
    doraCount: 1,
    myFirstMeldType: 'pon',
    myDrawTileType: 4,
  });

  const [beforeKanDeclarer, beforeKanGuesser] = await Promise.all([
    getClientSnapshot(declarerPage),
    getClientSnapshot(guesserPage),
  ]);
  expect(beforeKanDeclarer.wallRemaining).toBe(beforeKanGuesser.wallRemaining);
  const wallBeforeKan = beforeKanDeclarer.wallRemaining;

  await expect(declarerPage.locator('#btnKan')).toBeVisible();
  await declarerPage.locator('#btnKan').click();

  await expect.poll(async () => {
    const [declarerSnapshot, guesserSnapshot] = await Promise.all([
      getClientSnapshot(declarerPage),
      getClientSnapshot(guesserPage),
    ]);
    return {
      declarerPhase: declarerSnapshot.phase,
      declarerDrawCount: declarerSnapshot.phase2DrawCount,
      declarerDoraCount: declarerSnapshot.doraCount,
      declarerMeldType: declarerSnapshot.myFirstMeldType,
      declarerWallRemaining: declarerSnapshot.wallRemaining,
      guesserDoraCount: guesserSnapshot.doraCount,
      guesserWallRemaining: guesserSnapshot.wallRemaining,
    };
  }, { timeout: 15_000 }).toEqual({
    declarerPhase: 'phase2_action',
    declarerDrawCount: 1,
    declarerDoraCount: 2,
    declarerMeldType: 'kakan',
    declarerWallRemaining: wallBeforeKan,
    guesserDoraCount: 2,
    guesserWallRemaining: wallBeforeKan,
  });

  await declarerPage.waitForTimeout(800);

  const [afterKanDeclarer, afterKanGuesser] = await Promise.all([
    getClientSnapshot(declarerPage),
    getClientSnapshot(guesserPage),
  ]);
  expect(afterKanDeclarer.wallRemaining).toBe(wallBeforeKan);
  expect(afterKanGuesser.wallRemaining).toBe(wallBeforeKan);

  await ctx1.close();
  await ctx2.close();
});

test('余牌同步：Phase2 暗杠岭上补牌后双方余牌保持一致', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State2, p2State2] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const declarerPage = p1State2.mySeat === 0 ? p1 : p2;
  const guesserPage = declarerPage === p1 ? p2 : p1;
  const declarerSeat = p1State2.mySeat === 0 ? p1State2.mySeat : p2State2.mySeat;

  await triggerBackendPhase2Scenario(guesserPage, {
    already_guessed: [],
    tenpai_declarer: declarerSeat,
    message: '请先猜错以进入 Phase2 摸牌。',
    declarer_closed: ['1m', '1m', '1m', '4m', '5m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东'],
    guesser_closed: ['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
    wall_draw_sequence: ['1m', '9p', '9s', '北', '中', '7p'],
    dora_indicator: '6p',
    rinshan_sequence: ['西'],
  });

  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="4"]').click();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="10"]').click();
  await expect(guesserPage.locator('#guessCount')).toContainText('已选: 2 / 2');
  await expect(guesserPage.locator('#guessConfirm')).toBeEnabled();
  await guesserPage.evaluate(() => {
    const confirm = document.getElementById('guessConfirm');
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('猜牌确认按钮未就绪');
    }
    confirm.click();
  });

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      doraCount: snapshot.doraCount,
      myMeldsCount: snapshot.myMeldsCount,
      myDrawTileType: snapshot.myDrawTileType,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 1,
    doraCount: 1,
    myMeldsCount: 0,
    myDrawTileType: 0,
  });

  const [beforeKanDeclarer, beforeKanGuesser] = await Promise.all([
    getClientSnapshot(declarerPage),
    getClientSnapshot(guesserPage),
  ]);
  expect(beforeKanDeclarer.wallRemaining).toBe(beforeKanGuesser.wallRemaining);
  const wallBeforeAnkan = beforeKanDeclarer.wallRemaining;

  await expect(declarerPage.locator('#btnKan')).toBeVisible();
  await declarerPage.locator('#btnKan').click();

  await expect.poll(async () => {
    const [declarerSnapshot, guesserSnapshot] = await Promise.all([
      getClientSnapshot(declarerPage),
      getClientSnapshot(guesserPage),
    ]);
    return {
      declarerPhase: declarerSnapshot.phase,
      declarerDrawCount: declarerSnapshot.phase2DrawCount,
      declarerDoraCount: declarerSnapshot.doraCount,
      declarerMeldsCount: declarerSnapshot.myMeldsCount,
      declarerWallRemaining: declarerSnapshot.wallRemaining,
      guesserDoraCount: guesserSnapshot.doraCount,
      guesserOppMeldsCount: guesserSnapshot.oppMeldsCount,
      guesserWallRemaining: guesserSnapshot.wallRemaining,
    };
  }, { timeout: 15_000 }).toEqual({
    declarerPhase: 'phase2_action',
    declarerDrawCount: 1,
    declarerDoraCount: 2,
    declarerMeldsCount: 1,
    declarerWallRemaining: wallBeforeAnkan,
    guesserDoraCount: 2,
    guesserOppMeldsCount: 1,
    guesserWallRemaining: wallBeforeAnkan,
  });

  await ctx1.close();
  await ctx2.close();
});

test('展示同步：抢杠响应期不污染牌河，荣和后结果一致', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const actorPage = p1;
  const responderPage = p2;

  await triggerBackendPhase1ActionScenario(actorPage, {
    actor_closed: ['1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '4m'],
    actor_melds: [{ type: 'pon', tiles: ['5m', '5m', '5m'], called_index: 2 }],
    actor_draw: '5m',
    opponent_closed: ['3m', '4m', '1p', '2p', '3p', '1s', '2s', '3s', '南', '南', '南', '白', '白'],
    dora_indicator: '6p',
    actor_points: 25000,
    opponent_points: 25000,
  });

  const [beforeActor, beforeResponder] = await Promise.all([
    getClientSnapshot(actorPage),
    getClientSnapshot(responderPage),
  ]);
  expect(beforeActor.totalDiscards).toBe(beforeResponder.totalDiscards);
  const discardsBeforeChankan = beforeActor.totalDiscards;

  await expect(actorPage.locator('#btnKan')).toBeVisible();
  await actorPage.locator('#btnKan').click();

  await expect(responderPage.locator('#btnRon')).toBeVisible();
  await expect(responderPage.locator('#btnPass')).toBeVisible();

  const [pendingActor, pendingResponder] = await Promise.all([
    getClientSnapshot(actorPage),
    getClientSnapshot(responderPage),
  ]);
  expect(pendingActor.totalDiscards).toBe(discardsBeforeChankan);
  expect(pendingResponder.totalDiscards).toBe(discardsBeforeChankan);
  expect(pendingActor.myMeldTypes).toEqual(['pon']);
  expect(pendingResponder.oppMeldTypes).toEqual(['pon']);

  await responderPage.locator('#btnRon').click();

  await Promise.all([
    expect(actorPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(responderPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
  ]);

  await expect(responderPage.locator('#resultYaku')).toContainText('抢杠');

  await expect.poll(async () => {
    const [actorSnapshot, responderSnapshot] = await Promise.all([
      getClientSnapshot(actorPage),
      getClientSnapshot(responderPage),
    ]);
    return {
      actorPhase: actorSnapshot.phase,
      responderPhase: responderSnapshot.phase,
      actorDiscards: actorSnapshot.totalDiscards,
      responderDiscards: responderSnapshot.totalDiscards,
    };
  }, { timeout: 15_000 }).toEqual({
    actorPhase: 'round_end',
    responderPhase: 'round_end',
    actorDiscards: discardsBeforeChankan,
    responderDiscards: discardsBeforeChankan,
  });

  await ctx1.close();
  await ctx2.close();
});

test('抢杠重连恢复：提示期刷新后 Ron 和 Pass 仍可恢复，跳过后继续到加杠补摸', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const actorPage = p1;
  const responderPage = p2;

  await triggerBackendPhase1ActionScenario(actorPage, {
    actor_closed: ['1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '4m'],
    actor_melds: [{ type: 'pon', tiles: ['5m', '5m', '5m'], called_index: 2 }],
    actor_draw: '5m',
    opponent_closed: ['3m', '4m', '1p', '2p', '3p', '1s', '2s', '3s', '南', '南', '南', '白', '白'],
    dora_indicator: '6p',
    actor_points: 25000,
    opponent_points: 25000,
  });

  await actorPage.locator('#btnKan').click();

  await expect(responderPage.locator('#btnRon')).toBeVisible();
  await expect(responderPage.locator('#btnPass')).toBeVisible();

  const beforeReload = await getClientSnapshot(responderPage);
  expect(beforeReload.phase).toBe('phase1_response');
  expect(beforeReload.passVisible).toBe(true);
  const discardsBeforeReload = beforeReload.totalDiscards;
  const wallBeforeReload = beforeReload.wallRemaining;

  await responderPage.reload({ waitUntil: 'domcontentloaded' });
  await expect(responderPage).toHaveURL(/\/game/);

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(responderPage);
    return {
      phase: snapshot.phase,
      passVisible: snapshot.passVisible,
      totalDiscards: snapshot.totalDiscards,
      oppMeldTypes: snapshot.oppMeldTypes,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase1_response',
    passVisible: true,
    totalDiscards: discardsBeforeReload,
    oppMeldTypes: ['pon'],
  });

  await expect(responderPage.locator('#btnRon')).toBeVisible();
  await expect(responderPage.locator('#btnPass')).toBeVisible();

  await responderPage.locator('#btnPass').click();

  await expect.poll(async () => {
    const [actorSnapshot, responderSnapshot] = await Promise.all([
      getClientSnapshot(actorPage),
      getClientSnapshot(responderPage),
    ]);
    return {
      actorPhase: actorSnapshot.phase,
      actorDoraCount: actorSnapshot.doraCount,
      actorMeldTypes: actorSnapshot.myMeldTypes,
      actorClickableCount: actorSnapshot.clickableCount,
      actorWallRemaining: actorSnapshot.wallRemaining,
      responderPhase: responderSnapshot.phase,
      responderOppMeldTypes: responderSnapshot.oppMeldTypes,
      responderWallRemaining: responderSnapshot.wallRemaining,
      totalDiscards: responderSnapshot.totalDiscards,
    };
  }, { timeout: 15_000 }).toEqual({
    actorPhase: 'phase1_action',
    actorDoraCount: 2,
    actorMeldTypes: ['kakan'],
    actorClickableCount: 11,
    actorWallRemaining: wallBeforeReload,
    responderPhase: 'phase1_response',
    responderOppMeldTypes: ['kakan'],
    responderWallRemaining: wallBeforeReload,
    totalDiscards: discardsBeforeReload,
  });

  await expect(responderPage.locator('#btnRon')).toBeHidden();
  await expect(responderPage.locator('#btnPass')).toBeHidden();

  await ctx1.close();
  await ctx2.close();
});

test('展示同步：四杠流局后结果、点数与副露状态一致', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const actorPage = p1;
  const watcherPage = p2;

  await triggerBackendPhase1ActionScenario(actorPage, {
    actor_closed: ['1p', '2p', '3p', '1s', '2s', '3s'],
    actor_melds: [
      { type: 'ankan', tiles: ['东', '东', '东', '东'] },
      { type: 'pon', tiles: ['5m', '5m', '5m'], called_index: 2 },
    ],
    actor_draw: '5m',
    opponent_closed: ['7m', '8m', '9m', '白', '发'],
    opponent_melds: [
      { type: 'ankan', tiles: ['南', '南', '南', '南'] },
      { type: 'ankan', tiles: ['西', '西', '西', '西'] },
    ],
    dora_indicator: '6p',
    actor_points: 25000,
    opponent_points: 25000,
  });

  const [beforeAbortActor, beforeAbortWatcher] = await Promise.all([
    getClientSnapshot(actorPage),
    getClientSnapshot(watcherPage),
  ]);
  expect(beforeAbortActor.wallRemaining).toBe(beforeAbortWatcher.wallRemaining);
  const wallBeforeAbort = beforeAbortActor.wallRemaining;

  await expect(actorPage.locator('#btnKan')).toBeVisible();
  await actorPage.locator('#btnKan').click();

  await Promise.all([
    expect(actorPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(watcherPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
  ]);

  await expect(actorPage.locator('#resultTitle')).toHaveText('流局');
  await expect(actorPage.locator('#resultScore')).toContainText('四杠散了');

  await expect.poll(async () => {
    const [actorSnapshot, watcherSnapshot] = await Promise.all([
      getClientSnapshot(actorPage),
      getClientSnapshot(watcherPage),
    ]);
    return {
      actorPhase: actorSnapshot.phase,
      watcherPhase: watcherSnapshot.phase,
      actorPoints: actorSnapshot.myPoints,
      watcherPoints: watcherSnapshot.myPoints,
      actorWall: actorSnapshot.wallRemaining,
      watcherWall: watcherSnapshot.wallRemaining,
      actorDora: actorSnapshot.doraCount,
      watcherDora: watcherSnapshot.doraCount,
      actorMeldTypes: actorSnapshot.myMeldTypes,
      watcherOppMeldTypes: watcherSnapshot.oppMeldTypes,
    };
  }, { timeout: 15_000 }).toEqual({
    actorPhase: 'round_end',
    watcherPhase: 'round_end',
    actorPoints: 25000,
    watcherPoints: 25000,
    actorWall: wallBeforeAbort,
    watcherWall: wallBeforeAbort,
    actorDora: 1,
    watcherDora: 1,
    actorMeldTypes: ['ankan', 'kakan'],
    watcherOppMeldTypes: ['ankan', 'kakan'],
  });

  await expect(actorPage.locator('#phase2Status')).toBeHidden();
  await expect(watcherPage.locator('#waitingIndicator')).toBeHidden();

  await ctx1.close();
  await ctx2.close();
});

test('余牌同步：Phase1 大明杠岭上补牌后双方余牌保持一致', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const discarderPage = p1State.mySeat === 0 ? p1 : p2;
  const callerPage = discarderPage === p1 ? p2 : p1;

  await triggerBackendPhase1ActionScenario(discarderPage, {
    actor_closed: ['1m', '2m', '3m', '7m', '8m', '9m', '1p', '2p', '3p', '7p', '8p', '9p', '北'],
    actor_draw: '5m',
    opponent_closed: ['5m', '5m', '5m', '1s', '2s', '3s', '7s', '8s', '9s', '东', '南', '西', '白'],
    dora_indicator: '6p',
    actor_points: 25000,
    opponent_points: 25000,
  });

  const [beforeKanDiscarder, beforeKanCaller] = await Promise.all([
    getClientSnapshot(discarderPage),
    getClientSnapshot(callerPage),
  ]);
  expect(beforeKanDiscarder.wallRemaining).toBe(beforeKanCaller.wallRemaining);
  const wallBeforeMinkan = beforeKanDiscarder.wallRemaining;

  await discardCurrentDrawTile(discarderPage);

  await expect(callerPage.locator('#btnKan')).toBeVisible();
  await callerPage.locator('#btnKan').click();

  await expect.poll(async () => {
    const [callerSnapshot, discarderSnapshot] = await Promise.all([
      getClientSnapshot(callerPage),
      getClientSnapshot(discarderPage),
    ]);
    return {
      callerPhase: callerSnapshot.phase,
      callerMeldsCount: callerSnapshot.myMeldsCount,
      callerDoraCount: callerSnapshot.doraCount,
      callerWallRemaining: callerSnapshot.wallRemaining,
      callerClickableCount: callerSnapshot.clickableCount,
      discarderOppMeldsCount: discarderSnapshot.oppMeldsCount,
      discarderDoraCount: discarderSnapshot.doraCount,
      discarderWallRemaining: discarderSnapshot.wallRemaining,
    };
  }, { timeout: 15_000 }).toEqual({
    callerPhase: 'phase1_action',
    callerMeldsCount: 1,
    callerDoraCount: 2,
    callerWallRemaining: wallBeforeMinkan,
    callerClickableCount: 11,
    discarderOppMeldsCount: 1,
    discarderDoraCount: 2,
    discarderWallRemaining: wallBeforeMinkan,
  });

  await ctx1.close();
  await ctx2.close();
});

test('余牌同步：Phase1 暗杠岭上补牌后双方余牌保持一致', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State3, p2State3] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const declarerPage = p1State3.mySeat === 0 ? p1 : p2;
  const watcherPage = declarerPage === p1 ? p2 : p1;

  await triggerBackendPhase1ActionScenario(declarerPage, {
    actor_closed: ['1m', '1m', '1m', '1m', '2p', '3p', '4p', '2s', '3s', '4s', '东', '东', '白'],
    actor_draw: '北',
    opponent_closed: ['2m', '3m', '4m', '5p', '6p', '7p', '5s', '6s', '7s', '南', '西', '发', '中'],
    dora_indicator: '6p',
    actor_points: 25000,
    opponent_points: 25000,
  });

  const [beforeAnkanDeclarer, beforeAnkanWatcher] = await Promise.all([
    getClientSnapshot(declarerPage),
    getClientSnapshot(watcherPage),
  ]);
  expect(beforeAnkanDeclarer.wallRemaining).toBe(beforeAnkanWatcher.wallRemaining);
  const wallBeforeAnkan = beforeAnkanDeclarer.wallRemaining;

  await expect(declarerPage.locator('#btnKan')).toBeVisible();
  await declarerPage.locator('#btnKan').click();

  await expect.poll(async () => {
    const [declarerSnapshot, watcherSnapshot] = await Promise.all([
      getClientSnapshot(declarerPage),
      getClientSnapshot(watcherPage),
    ]);
    return {
      declarerPhase: declarerSnapshot.phase,
      declarerMeldsCount: declarerSnapshot.myMeldsCount,
      declarerDoraCount: declarerSnapshot.doraCount,
      declarerWallRemaining: declarerSnapshot.wallRemaining,
      declarerClickableCount: declarerSnapshot.clickableCount,
      watcherOppMeldsCount: watcherSnapshot.oppMeldsCount,
      watcherDoraCount: watcherSnapshot.doraCount,
      watcherWallRemaining: watcherSnapshot.wallRemaining,
    };
  }, { timeout: 15_000 }).toEqual({
    declarerPhase: 'phase1_action',
    declarerMeldsCount: 1,
    declarerDoraCount: 2,
    declarerWallRemaining: wallBeforeAnkan,
    declarerClickableCount: 11,
    watcherOppMeldsCount: 1,
    watcherDoraCount: 2,
    watcherWallRemaining: wallBeforeAnkan,
  });

  await ctx1.close();
  await ctx2.close();
});

test('回合指示：首巡换手后必须与 currentTurn 一致', async ({ browser }) => {
  test.setTimeout(45_000);

  const context = await browser.newContext();
  const page = await context.newPage();

  await login(page, P1.username, P1.password);
  await mountTurnIndicatorFixture(page);

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(page);
    return snapshot.currentTurn;
  }).toBe(0);
  await assertTurnUi(page, true);

  await page.evaluate(() => {
    globalThis.eval(`
      onDiscard({ seat: state.mySeat, tile: 52, wall_remaining: 68 });
      onOpponentDraw({ seat: 1, wall_remaining: 67 });
    `);
  });

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(page);
    return snapshot.currentTurn;
  }).toBe(1);
  await assertTurnUi(page, false);

  await context.close();
});

test('牌河布局：牌局后期牌河很多时不应挤压其他组件', async ({ browser }) => {
  test.setTimeout(45_000);

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  await login(page, P1.username, P1.password);
  await mountDiscardLayoutFixture(page);

  await seedDiscardLayoutFixture(page, 6);
  const sparse = await collectDiscardLayoutMetrics(page);

  await seedDiscardLayoutFixture(page, 24);
  const dense = await collectDiscardLayoutMetrics(page);

  expect(dense.myPond?.tileCount).toBe(24);
  expect(dense.oppPond?.tileCount).toBe(24);
  expect(dense.myPond?.gridColumns).toBe(6);
  expect(dense.oppPond?.gridColumns).toBe(6);
  expect(dense.discardArea?.height).toBe(sparse.discardArea?.height);
  expect(dense.myPond?.clientHeight).toBe(sparse.myPond?.clientHeight);
  expect(dense.oppPond?.clientHeight).toBe(sparse.oppPond?.clientHeight);
  expect(dense.myPond?.scrollHeight ?? 0).toBeGreaterThan(dense.myPond?.clientHeight ?? 0);
  expect(dense.oppPond?.scrollHeight ?? 0).toBeGreaterThan(dense.oppPond?.clientHeight ?? 0);

  expect(Math.abs((dense.discardArea?.top ?? 0) - (sparse.discardArea?.top ?? 0))).toBeLessThanOrEqual(2);
  expect(Math.abs((dense.playerInfo?.top ?? 0) - (sparse.playerInfo?.top ?? 0))).toBeLessThanOrEqual(2);
  expect(dense.discardArea?.bottom ?? 0).toBeLessThanOrEqual((dense.myTiles?.top ?? 0) + 2);
  expect(dense.leftPanel?.right ?? 0).toBeLessThanOrEqual((dense.discardArea?.left ?? 0) + 6);
  expect(dense.discardArea?.right ?? 0).toBeLessThanOrEqual((dense.rightPanel?.left ?? 0) + 6);
  expect(dense.leftPanel?.top ?? 0).toBeGreaterThanOrEqual(0);
  expect(dense.rightPanel?.top ?? 0).toBeGreaterThanOrEqual(0);
  expect(dense.discardArea?.bottom ?? 0).toBeLessThanOrEqual(dense.viewport.height);
  expect(dense.playerArea?.bottom ?? 0).toBeLessThanOrEqual(dense.viewport.height);

  await context.close();
});

test('牌河布局：窄屏下后期牌河很多时仍不应挤压底部手牌', async ({ browser }) => {
  test.setTimeout(45_000);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  await login(page, P1.username, P1.password);
  await mountDiscardLayoutFixture(page);

  await seedDiscardLayoutFixture(page, 6);
  const sparse = await collectDiscardLayoutMetrics(page);

  await seedDiscardLayoutFixture(page, 24);
  const dense = await collectDiscardLayoutMetrics(page);

  expect(dense.myPond?.tileCount).toBe(24);
  expect(dense.oppPond?.tileCount).toBe(24);
  expect(dense.myPond?.gridColumns).toBe(6);
  expect(dense.oppPond?.gridColumns).toBe(6);
  expect(dense.discardArea?.height).toBe(sparse.discardArea?.height);
  expect(dense.myPond?.clientHeight).toBe(sparse.myPond?.clientHeight);
  expect(dense.oppPond?.clientHeight).toBe(sparse.oppPond?.clientHeight);
  expect(dense.myPond?.scrollHeight ?? 0).toBeGreaterThan(dense.myPond?.clientHeight ?? 0);
  expect(dense.oppPond?.scrollHeight ?? 0).toBeGreaterThan(dense.oppPond?.clientHeight ?? 0);

  expect(Math.abs((dense.discardArea?.top ?? 0) - (sparse.discardArea?.top ?? 0))).toBeLessThanOrEqual(2);
  expect(Math.abs((dense.playerInfo?.top ?? 0) - (sparse.playerInfo?.top ?? 0))).toBeLessThanOrEqual(2);
  expect(dense.discardArea?.bottom ?? 0).toBeLessThanOrEqual((dense.myTiles?.top ?? 0) + 2);
  expect(dense.discardArea?.left ?? 0).toBeGreaterThanOrEqual(0);
  expect(dense.discardArea?.right ?? 0).toBeLessThanOrEqual(dense.viewport.width);
  expect(dense.playerArea?.bottom ?? 0).toBeLessThanOrEqual(dense.viewport.height);
  expect(dense.myTiles?.bottom ?? 0).toBeLessThanOrEqual(dense.viewport.height);

  await context.close();
});

test('Phase1 重连恢复：自己摸牌后刷新，操作按钮恢复', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const actorPage = p1State.mySeat === 0 ? p1 : p2;
  const watcherPage = p1State.mySeat === 0 ? p2 : p1;

  const hookResult = await triggerBackendPhase1ActionScenario(actorPage, {
    actor_closed: ['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '5m'],
    actor_draw: '5m',
    opponent_closed: ['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
    dora_indicator: '6p',
  });

  expect(hookResult.actions.can_tsumo).toBeTruthy();

  await expect(actorPage.locator('#btnTsumo')).toBeVisible();
  await actorPage.reload({ waitUntil: 'domcontentloaded' });
  await expect(actorPage).toHaveURL(/\/game/);

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(actorPage);
    return {
      phase: snapshot.phase,
      currentTurn: snapshot.currentTurn,
      mySeat: snapshot.mySeat,
      clickableCount: snapshot.clickableCount,
    };
  }, { timeout: 15_000 }).toMatchObject({
    phase: 'phase1_action',
  });

  await expect(actorPage.locator('#btnTsumo')).toBeVisible();
  await expect(actorPage.locator('#actionBar')).toBeVisible();
  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(actorPage);
    return snapshot.clickableCount;
  }, { timeout: 10_000 }).toBeGreaterThan(0);

  await actorPage.locator('#btnTsumo').click();

  await expect.poll(async () => {
    const actorState = await getClientSnapshot(actorPage);
    return actorState.phase;
  }, { timeout: 15_000 }).toMatch(/round_end|game_over/);

  if (await actorPage.locator('#gameOverOverlay').isVisible()) {
    await expect(actorPage.locator('#gameOverTitle')).toContainText('你赢了');
  } else {
    await expect(actorPage.locator('#resultOverlay')).toBeVisible();
    await expect(actorPage.locator('#resultTitle')).toContainText('自摸');
  }

  await expect.poll(async () => {
    const watcherState = await getClientSnapshot(watcherPage);
    return watcherState.phase;
  }, { timeout: 15_000 }).toMatch(/round_end|game_over/);

  await ctx1.close();
  await ctx2.close();
});

test('Phase2 猜牌面板：已猜过牌置灰且不可再次选择', async ({ browser }) => {
  test.setTimeout(45_000);

  const context = await browser.newContext();
  const page = await context.newPage();

  await login(page, P1.username, P1.password);
  await mountPhase2GuessPanel(page, [0, 9]);

  const guessedMan = page.locator('#guessTiles .tile[data-tile-type="0"]');
  const guessedPin = page.locator('#guessTiles .tile[data-tile-type="9"]');
  const selectableA = page.locator('#guessTiles .tile[data-tile-type="1"]');
  const selectableB = page.locator('#guessTiles .tile[data-tile-type="10"]');
  const selectableC = page.locator('#guessTiles .tile[data-tile-type="18"]');
  const confirmBtn = page.locator('#guessConfirm');
  const count = page.locator('#guessCount');

  await expect(guessedMan).toHaveClass(/guessed/);
  await expect(guessedPin).toHaveClass(/guessed/);
  await expect(guessedMan).not.toHaveClass(/clickable/);
  await expect(guessedPin).not.toHaveClass(/clickable/);
  await expect(confirmBtn).toBeVisible();
  await expect(count).toHaveText('已选: 0 / 2');
  await expect(confirmBtn).toBeDisabled();

  const guessedOpacity = await guessedMan.evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(guessedOpacity)).toBeLessThan(0.5);

  await guessedMan.click();
  await guessedPin.click();
  await expect(count).toHaveText('已选: 0 / 2');
  await expect(confirmBtn).toBeDisabled();

  await selectableA.click();
  await expect(count).toHaveText('已选: 1 / 2');
  await expect(confirmBtn).toBeDisabled();

  await selectableB.click();
  await expect(count).toHaveText('已选: 2 / 2');
  await expect(confirmBtn).toBeEnabled();

  await selectableC.click();
  await expect(count).toHaveText('已选: 2 / 2');

  const selectedTypes = await page.evaluate(() => {
    const selected = globalThis.eval('Array.from(guessSelected.values())') as number[];
    return selected.sort((a: number, b: number) => a - b);
  });
  expect(selectedTypes).toEqual([1, 10]);
  await expect(page.locator('#guessTitle')).toHaveText('5次摸牌结束，未和牌。请再次选择2张牌进行猜测。');

  await context.close();
});

test('Phase2 猜牌面板：宣听者已出牌禁选，手动排除可撤回，且不遮挡手牌', async ({ browser }) => {
  test.setTimeout(45_000);

  const context = await browser.newContext();
  const page = await context.newPage();

  await login(page, P1.username, P1.password);
  await mountPhase2GuessPanel(page, [0, 9], 1, 0, [4, 27]);

  await expect(page.locator('#myTiles')).toBeVisible();
  await expect(page.locator('#myTiles .tile')).toHaveCount(13);

  const discardedTile = page.locator('#guessTiles .tile[data-tile-type="4"]');
  const markedTile = page.locator('#guessTiles .tile[data-tile-type="10"]');
  const count = page.locator('#guessCount');

  await expect(discardedTile).toHaveClass(/discard-blocked/);
  await expect(discardedTile).not.toHaveClass(/clickable/);

  await page.locator('#guessModeMark').click();
  await markedTile.click();
  await expect(markedTile).toHaveClass(/marked/);
  await expect(count).toHaveText('已选: 0 / 2 · 已排除: 1');

  await page.locator('#guessModeSelect').click();
  await markedTile.click();
  await expect(count).toHaveText('已选: 0 / 2 · 已排除: 1');

  await page.locator('#guessModeMark').click();
  await markedTile.click();
  await expect(markedTile).not.toHaveClass(/marked/);
  await expect(count).toHaveText('已选: 0 / 2');

  await page.locator('#guessModeSelect').click();
  await markedTile.click();
  await expect(count).toHaveText('已选: 1 / 2');

  await context.close();
});

test('Phase2 猜牌面板：剩1张时按1张选择，没牌可选时显示跳过', async ({ browser }) => {
  test.setTimeout(45_000);

  const context = await browser.newContext();
  const page = await context.newPage();

  await login(page, P1.username, P1.password);

  const blockedTypes = [
    0, 1, 2, 3, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16, 17,
    18, 19, 20, 21, 22, 23, 24, 25, 26,
    27, 28, 29, 30, 31, 32, 33,
  ];

  await mountPhase2GuessPanel(page, [], 1, 0, blockedTypes);
  await expect(page.locator('#guessCount')).toHaveText('已选: 0 / 1');
  await expect(page.locator('#guessConfirm')).toBeVisible();
  await expect(page.locator('#guessConfirm')).toBeDisabled();
  await expect(page.locator('#guessSkip')).toBeHidden();

  await page.locator('#guessTiles .tile[data-tile-type="4"]').click();
  await expect(page.locator('#guessCount')).toHaveText('已选: 1 / 1');
  await expect(page.locator('#guessConfirm')).toBeEnabled();

  await mountPhase2GuessPanel(page, [4], 1, 0, blockedTypes);
  await expect(page.locator('#guessCount')).toHaveText('已选: 0 / 0');
  await expect(page.locator('#guessConfirm')).toBeHidden();
  await expect(page.locator('#guessSkip')).toBeVisible();
  await expect(page.locator('#guessSkip')).toBeEnabled();

  await context.close();
});

test('Phase2 双端集成：后端下发 already_guessed 后前端面板正确灰态', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  const p1InGame = /\/game$/.test(p1.url());
  const p2InGame = /\/game$/.test(p2.url());

  if (!p1InGame || !p2InGame) {
    if (!p1InGame) {
      await createRoom(p1);
    }
    if (!p2InGame) {
      await joinFirstAvailableRoom(p2);
    }
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);
  await assertGameShell(p1);
  await assertGameShell(p2);

  const p1Seat = await p1.evaluate(() => globalThis.eval('state.mySeat') as number);
  const p2Seat = await p2.evaluate(() => globalThis.eval('state.mySeat') as number);
  expect([p1Seat, p2Seat].sort()).toEqual([0, 1]);

  const hookResult = await triggerBackendPhase2GuessRequest(p2, [0, 9], p1Seat);
  expect(hookResult.guesser).toBe(p2Seat);
  expect(hookResult.tenpai_declarer).toBe(p1Seat);

  await expect(p2.locator('#guessPanel')).toBeVisible();
  await expect(p2.locator('#guessTitle')).toHaveText('5次摸牌结束，未和牌。请再次选择2张牌进行猜测。');
  await expect(p2.locator('#guessTiles .tile[data-tile-type="0"]')).toHaveClass(/guessed/);
  await expect(p2.locator('#guessTiles .tile[data-tile-type="9"]')).toHaveClass(/guessed/);
  await expect(p2.locator('#guessTiles .tile[data-tile-type="0"]')).not.toHaveClass(/clickable/);
  await expect(p2.locator('#guessCount')).toHaveText('已选: 0 / 2');

  await expect(p1.locator('#phase2Status')).toBeVisible();
  await expect(p1.locator('#phase2Info')).toHaveText('等待对手猜牌');
  await expect(p2.locator('#phase2Status')).toBeVisible();
  await expect(p2.locator('#phase2Info')).toHaveText('请猜测对手的听牌');
  await expect(p1.locator('#myTiles')).toBeVisible();
  await expect(p2.locator('#myTiles')).toBeVisible();

  await p2.locator('#guessTiles .tile[data-tile-type="1"]').click();
  await p2.locator('#guessTiles .tile[data-tile-type="10"]').click();
  await expect(p2.locator('#guessCount')).toHaveText('已选: 2 / 2');
  await expect(p2.locator('#guessConfirm')).toBeEnabled();

  await ctx1.close();
  await ctx2.close();
});

test('门清听牌：动作条可选择立直或宣告默听，立直后立直棒与点数立即更新', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const p1State = await getClientSnapshot(p1);
  const actorPage = p1State.mySeat === 0 ? p1 : p2;

  await triggerBackendPhase1ActionScenario(actorPage, {
    actor_closed: ['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '5m', '6m'],
    actor_draw: '8m',
    opponent_closed: ['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
    dora_indicator: '6p',
    actor_points: 25000,
    opponent_points: 25000,
  });

  await expect(actorPage.locator('#btnRiichi')).toBeVisible();
  await expect(actorPage.locator('#btnTenpai')).toBeVisible();
  await expect(actorPage.locator('#btnTenpai')).toHaveText('宣告默听');

  await actorPage.locator('#btnRiichi').click();

  await expect(actorPage.locator('#myPoints')).toHaveText('24000');
  await expect(actorPage.locator('#riichiStickInfo')).toHaveText('立直棒: 1');

  await ctx1.close();
  await ctx2.close();
});

test('宣告默听：点击后弃牌并进入 Phase2，且不扣立直棒', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);
  await assertGameShell(p1);
  await assertGameShell(p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const actorSeat = p1State.mySeat === 0 ? p1State.mySeat : p2State.mySeat;
  const actorPage = p1State.mySeat === 0 ? p1 : p2;
  const watcherPage = actorPage === p1 ? p2 : p1;

  await triggerBackendPhase1ActionScenario(actorPage, {
    actor_closed: ['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '5m', '6m'],
    actor_draw: '8m',
    opponent_closed: ['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
    dora_indicator: '6p',
    actor_points: 25000,
    opponent_points: 25000,
  });

  await expect(actorPage.locator('#btnTenpai')).toBeVisible();
  await expect(actorPage.locator('#btnTenpai')).toHaveText('宣告默听');

  await actorPage.locator('#btnTenpai').click();
  await discardFirstClickableTile(actorPage);

  await expect.poll(async () => {
    const [actorState, watcherState] = await Promise.all([
      getClientSnapshot(actorPage),
      getClientSnapshot(watcherPage),
    ]);
    return {
      actorPhase: actorState.phase,
      watcherPhase: watcherState.phase,
      actorTenpaiDeclarer: actorState.tenpaiDeclarer,
      watcherTenpaiDeclarer: watcherState.tenpaiDeclarer,
    };
  }, { timeout: 15_000 }).toEqual({
    actorPhase: 'phase2_guess',
    watcherPhase: 'phase2_guess',
    actorTenpaiDeclarer: actorSeat,
    watcherTenpaiDeclarer: actorSeat,
  });

  await expect(actorPage.locator('#riichiStickInfo')).toHaveText('立直棒: 0');
  await expect(actorPage.locator('#myPoints')).toHaveText('25000');
  await expect(actorPage.locator('#phase2Status')).toBeVisible();
  await expect(watcherPage.locator('#guessPanel')).toBeVisible();

  await ctx1.close();
  await ctx2.close();
});

test('结果面板：和牌点、本场加点、立直棒加点分开显示', async ({ browser }) => {
  test.setTimeout(45_000);

  const context = await browser.newContext();
  const page = await context.newPage();

  await login(page, P1.username, P1.password);
  await mountTurnIndicatorFixture(page);

  await page.evaluate(() => {
    globalThis.eval(`
      onRoundResult({
        type: 'tsumo',
        winner: state.mySeat,
        loser: 1,
        win_tile: 52,
        hand: { closed: state.myHand.slice(0, 14), melds: [] },
        score: {
          han: 3,
          fu: 40,
          total: 5200,
          yaku: ['Riichi 1', 'Ippatsu 1', 'Dora 1'],
          uradora_indicators: [],
        },
        points: { 0: 29300, 1: 20700 },
        points_transfer: 3300,
        honba_count: 1,
        riichi_sticks: 1,
        honba_bonus: 300,
        riichi_bonus: 1000,
        points_delta: { 0: 4300, 1: -3300 },
      });
    `);
  });

  await expect(page.locator('#resultOverlay')).toBeVisible();
  await expect(page.locator('#resultScore')).toContainText('3番 40符');
  await expect(page.locator('#resultScore')).toContainText('和牌点');
  await expect(page.locator('#resultScore')).toContainText('3000点');
  await expect(page.locator('#resultScore')).toContainText('本场加点');
  await expect(page.locator('#resultScore')).toContainText('+300点');
  await expect(page.locator('#resultScore')).toContainText('立直棒加点');
  await expect(page.locator('#resultScore')).toContainText('+1000点');
  await expect(page.locator('#resultScore')).toContainText('合计获得 4300点');

  await context.close();
});

test('结果面板：窄屏高番结果时手牌保持单行展示', async ({ browser }) => {
  test.setTimeout(45_000);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  await login(page, P1.username, P1.password);
  await mountTurnIndicatorFixture(page);

  await page.evaluate(() => {
    globalThis.eval(`
      onRoundResult({
        type: 'tsumo',
        winner: state.mySeat,
        loser: 1,
        win_tile: 52,
        hand: {
          closed: [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52],
          melds: [],
        },
        dora_indicators: [60, 64, 68],
        uradora_indicators: [72, 76, 80],
        score: {
          han: 11,
          fu: 30,
          total: 18000,
          yaku: ['Menzen Tsumo 1', 'Riichi 1', 'Iipeikou 1', 'Dora 8'],
          uradora_indicators: [72, 76, 80],
        },
        points: { 0: 18000, 1: 0 },
        points_transfer: 18000,
        honba_count: 0,
        riichi_sticks: 1,
        honba_bonus: 0,
        riichi_bonus: 1000,
        points_delta: { 0: 19000, 1: 0 },
      });
    `);
  });

  await expect(page.locator('#resultOverlay')).toBeVisible();

  const resultHandMetrics = await page.locator('#resultHand .result-hand-track').evaluate((node) => {
    const tops = Array.from(node.querySelectorAll('.tile')).map((tile) => Math.round(tile.getBoundingClientRect().top));
    return {
      rows: new Set(tops).size,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    };
  });

  expect(resultHandMetrics.rows).toBe(1);
  expect(resultHandMetrics.scrollWidth).toBeGreaterThanOrEqual(resultHandMetrics.clientWidth);

  await context.close();
});

test('结果面板：窄屏高番结果视觉快照稳定', async ({ browser }) => {
  test.setTimeout(45_000);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  await login(page, P1.username, P1.password);
  await mountTurnIndicatorFixture(page);

  await page.evaluate(() => {
    globalThis.eval(`
      onRoundResult({
        type: 'tsumo',
        winner: state.mySeat,
        loser: 1,
        win_tile: 52,
        hand: {
          closed: [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52],
          melds: [],
        },
        dora_indicators: [60, 64, 68],
        uradora_indicators: [72, 76, 80],
        score: {
          han: 11,
          fu: 30,
          total: 18000,
          yaku: ['Menzen Tsumo 1', 'Riichi 1', 'Iipeikou 1', 'Dora 8'],
          uradora_indicators: [72, 76, 80],
        },
        points: { 0: 18000, 1: 0 },
        points_transfer: 18000,
        honba_count: 0,
        riichi_sticks: 1,
        honba_bonus: 0,
        riichi_bonus: 1000,
        points_delta: { 0: 19000, 1: 0 },
      });
    `);
  });

  await expect(page.locator('#resultOverlay')).toBeVisible();
  await expect(page.locator('#resultOverlay .result-box')).toHaveScreenshot('result-panel-high-yaku-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
  });

  await context.close();
});

test('终局返回大厅：收到 room_left 前不应抢先跳转', async ({ browser }) => {
  test.setTimeout(45_000);

  const context = await browser.newContext();
  const page = await context.newPage();

  await login(page, P1.username, P1.password);
  await page.goto('/game');
  await page.waitForFunction(() => {
    try {
      return typeof globalThis.eval('state') !== 'undefined';
    } catch {
      return false;
    }
  });

  await page.evaluate(() => {
    globalThis.__sentMessages = [];
    globalThis.eval(`
      if (typeof ws !== 'undefined' && ws) {
        ws.onclose = null;
        try { ws.close(); } catch {}
        ws = null;
      }
      send = (data) => {
        globalThis.__sentMessages.push(data);
      };
      state.mySeat = 0;
      state.oppName = 'player2';
      state.myPoints = 25000;
      state.oppPoints = 23800;
      state.roomPlayers = [
        { seat: 0, username: 'player1', ready: false },
        { seat: 1, username: 'player2', ready: false },
      ];
      state.roomReadyBySeat = { 0: false, 1: false };
      state.roomOwnerSeat = 0;
      state.roomTimerMinutes = 30;
      onGameOver({
        winner: 0,
        final_points: { 0: 25000, 1: 23800 },
        honba_count: 0,
        riichi_sticks: 0,
      });
    `);
  });

  await expect(page.locator('#matchOverPanel')).toBeVisible();
  await page.locator('#btnReturnLobbyFromGameOver').click();

  await expect(page.locator('#btnReturnLobbyFromGameOver')).toHaveText('正在退出...');
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/game$/);

  const sentMessages = await page.evaluate(() => globalThis.__sentMessages as Array<{ type: string }>);
  expect(sentMessages.map((entry) => entry.type)).toContain('leave_room');

  await page.evaluate(() => {
    globalThis.eval(`handleMessage({ type: 'room_left' })`);
  });
  await expect(page).toHaveURL(/\/lobby$/);

  await context.close();
});

test('Round end：点击继续后显示等待对手继续，不再停留在第二阶段', async ({ browser }) => {
  test.setTimeout(45_000);

  const context = await browser.newContext();
  const page = await context.newPage();

  await login(page, P1.username, P1.password);
  await mountTurnIndicatorFixture(page);

  await page.evaluate(() => {
    globalThis.eval(`
      state.phase = 'phase2_draw';
      state.tenpaiDeclarer = 0;
      state.currentTurn = 0;
      document.getElementById('phase2Status').style.display = 'flex';
      document.getElementById('phase2Info').textContent = '摸牌中...';
      document.getElementById('phase2Draws').style.display = 'flex';
      document.getElementById('phase2Draws').innerHTML = '<div class="tile small"></div>';
      onRoundResult({
        type: 'tsumo',
        winner: state.mySeat,
        loser: 1,
        win_tile: 52,
        hand: { closed: state.myHand.slice(0, 14), melds: [] },
        score: { han: 1, fu: 30, total: 1000, yaku: ['menzen_tsumo'] },
        points: { 0: 26000, 1: 24000 },
        points_delta: { 0: 1000, 1: -1000 },
      });
    `);
  });

  await expect(page.locator('#resultOverlay')).toBeVisible();
  await expect(page.locator('#phase2Status')).toBeHidden();
  await expect(page.locator('#phase2Draws')).toBeHidden();

  await page.locator('#resultContinue').click();

  await expect(page.locator('#resultOverlay')).toBeHidden();
  await expect(page.locator('#roundReadyBar')).toBeVisible();
  await expect(page.locator('#roundReadyText')).toHaveText('已继续，等待对手继续...');
  await expect(page.locator('#btnRoundReady')).toBeHidden();

  await context.close();
});

test('Phase2 完整链路：猜错后自摸结算并进入下一局', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const initialRoundNumber = p1State.roundNumber;
  const declarerPage = p1State.mySeat === 0 ? p1 : p2;
  const guesserPage = p1State.mySeat === 1 ? p1 : p2;
  const declarerSeat = p1State.mySeat === 0 ? p1State.mySeat : p2State.mySeat;
  const guesserSeat = declarerSeat === 0 ? 1 : 0;

  const hookResult = await triggerBackendPhase2Scenario(guesserPage, {
    already_guessed: [],
    tenpai_declarer: declarerSeat,
    message: '请选择2张牌进行第一次猜测。',
    declarer_closed: ['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '5m'],
    guesser_closed: ['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
    wall_draw_sequence: ['9p', '9s', '北', '中', '7p', '5m'],
    dora_indicator: '6p',
  });

  expect(hookResult.tenpai_declarer).toBe(declarerSeat);
  expect(hookResult.guesser).toBe(guesserSeat);
  expect(hookResult.declarer_waits).toEqual([4]);

  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await expect(guesserPage.locator('#guessTitle')).toHaveText('请选择2张牌进行第一次猜测。');
  await expect(declarerPage.locator('#phase2Status')).toBeVisible();
  await expect(declarerPage.locator('#phase2Info')).toHaveText('等待对手猜牌');
  await expect(declarerPage.locator('#myTiles')).toBeVisible();
  await expect(guesserPage.locator('#myTiles')).toBeVisible();

  await guesserPage.locator('#guessTiles .tile[data-tile-type="1"]').click();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="10"]').click();
  await guesserPage.locator('#guessConfirm').click();

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return snapshot.phase;
  }, { timeout: 15_000 }).toBe('phase2_action');

  await expect(declarerPage.locator('#phase2Info')).toHaveText('请选择打出当前摸牌或开杠');
  await finishPhase2DrawSequenceByDiscardingDrawTile(declarerPage, 5);

  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await expect(guesserPage.locator('#guessTitle')).toHaveText('5次摸牌结束，未和牌。请再次选择2张牌进行猜测。', { timeout: 20_000 });
  await expect(guesserPage.locator('#guessTiles .tile[data-tile-type="1"]')).toHaveClass(/guessed/);
  await expect(guesserPage.locator('#guessTiles .tile[data-tile-type="10"]')).toHaveClass(/guessed/);

  await guesserPage.locator('#guessTiles .tile[data-tile-type="2"]').click();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="11"]').click();
  await guesserPage.locator('#guessConfirm').click();

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return snapshot.phase;
  }, { timeout: 15_000 }).toBe('phase2_action');
  await expect(declarerPage.locator('#btnTsumo')).toBeVisible({ timeout: 15_000 });
  await declarerPage.locator('#btnTsumo').click();

  await Promise.all([
    expect(declarerPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(guesserPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
  ]);

  await expect(declarerPage.locator('#resultTitle')).toContainText('自摸');
  await expect(guesserPage.locator('#resultTitle')).toContainText('自摸');
  await expect(declarerPage.locator('#phase2Status')).toBeHidden();
  await expect(guesserPage.locator('#phase2Status')).toBeHidden();

  const [resultDeclarerState, resultGuesserState] = await Promise.all([
    getClientSnapshot(declarerPage),
    getClientSnapshot(guesserPage),
  ]);
  expect(resultDeclarerState.myPoints).toBeGreaterThan(0);
  expect(resultGuesserState.myPoints).toBe(0);

  await declarerPage.locator('#resultContinue').click();
  await expect(declarerPage.locator('#roundReadyBar')).toBeVisible();
  await expect(declarerPage.locator('#roundReadyText')).toHaveText('已继续，等待对手继续...');

  await guesserPage.locator('#resultContinue').click();

  await expect.poll(async () => {
    const [nextDeclarerState, nextGuesserState] = await Promise.all([
      getClientSnapshot(declarerPage),
      getClientSnapshot(guesserPage),
    ]);
    return [nextDeclarerState.roundNumber, nextGuesserState.roundNumber];
  }, { timeout: 20_000 }).toEqual([initialRoundNumber + 1, initialRoundNumber + 1]);

  await Promise.all([
    expect(declarerPage.locator('#resultOverlay')).toBeHidden(),
    expect(guesserPage.locator('#resultOverlay')).toBeHidden(),
    expect(declarerPage.locator('#roundReadyBar')).toBeHidden(),
    expect(guesserPage.locator('#roundReadyBar')).toBeHidden(),
  ]);

  await expect.poll(async () => {
    const [nextDeclarerState, nextGuesserState] = await Promise.all([
      getClientSnapshot(declarerPage),
      getClientSnapshot(guesserPage),
    ]);
    return {
      declarerTenpai: nextDeclarerState.tenpaiDeclarer,
      guesserTenpai: nextGuesserState.tenpaiDeclarer,
      declarerDiscards: nextDeclarerState.totalDiscards,
      guesserDiscards: nextGuesserState.totalDiscards,
      declarerDora: nextDeclarerState.doraCount,
      guesserDora: nextGuesserState.doraCount,
    };
  }, { timeout: 20_000 }).toEqual({
    declarerTenpai: null,
    guesserTenpai: null,
    declarerDiscards: 0,
    guesserDiscards: 0,
    declarerDora: 1,
    guesserDora: 1,
  });

  await ctx1.close();
  await ctx2.close();
});

test('Phase2 完整链路：猜中听牌流局并进入下一局', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const initialRoundNumber = p1State.roundNumber;
  const declarerPage = p1State.mySeat === 0 ? p1 : p2;
  const guesserPage = p1State.mySeat === 1 ? p1 : p2;
  const declarerSeat = p1State.mySeat === 0 ? p1State.mySeat : p2State.mySeat;

  const hookResult = await triggerBackendPhase2Scenario(guesserPage, {
    already_guessed: [],
    tenpai_declarer: declarerSeat,
    message: '请选择2张牌进行猜测。',
    declarer_closed: ['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '5m'],
    guesser_closed: ['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
    wall_draw_sequence: ['9p', '9s', '北', '中', '7p', '5m'],
    dora_indicator: '6p',
  });

  expect(hookResult.declarer_waits).toEqual([4]);

  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="4"]').click();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="10"]').click();
  await guesserPage.locator('#guessConfirm').click();

  await Promise.all([
    expect(declarerPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(guesserPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
  ]);

  await expect(declarerPage.locator('#resultTitle')).toHaveText('流局');
  await expect(guesserPage.locator('#resultTitle')).toHaveText('流局');
  await expect(declarerPage.locator('#resultScore')).toContainText('猜中听牌');
  await expect(guesserPage.locator('#resultScore')).toContainText('猜中听牌');
  await expect(declarerPage.locator('#resultHand')).toContainText('听牌手牌已公开');
  await expect(guesserPage.locator('#resultHand')).toContainText('听牌手牌已公开');
  await expect(declarerPage.locator('#resultYaku')).toContainText('被猜中者');
  await expect(guesserPage.locator('#resultYaku')).toContainText('被猜中者');
  await expect(declarerPage.locator('#resultDora')).toBeVisible();
  await expect(guesserPage.locator('#resultDora')).toBeVisible();
  await expect(declarerPage.locator('#resultDora')).toContainText('宝牌指示牌');
  await expect(guesserPage.locator('#resultDora')).toContainText('宝牌指示牌');

  const [resultDeclarerState, resultGuesserState] = await Promise.all([
    getClientSnapshot(declarerPage),
    getClientSnapshot(guesserPage),
  ]);
  expect(resultDeclarerState.myPoints).toBe(0);
  expect(resultGuesserState.myPoints).toBe(0);

  await guesserPage.locator('#resultContinue').click();
  await expect(guesserPage.locator('#roundReadyBar')).toBeVisible();
  await expect(guesserPage.locator('#roundReadyText')).toHaveText('已继续，等待对手继续...');

  await declarerPage.locator('#resultContinue').click();

  await expect.poll(async () => {
    const [nextDeclarerState, nextGuesserState] = await Promise.all([
      getClientSnapshot(declarerPage),
      getClientSnapshot(guesserPage),
    ]);
    return [nextDeclarerState.roundNumber, nextGuesserState.roundNumber];
  }, { timeout: 20_000 }).toEqual([initialRoundNumber + 1, initialRoundNumber + 1]);

  await Promise.all([
    expect(declarerPage.locator('#resultOverlay')).toBeHidden(),
    expect(guesserPage.locator('#resultOverlay')).toBeHidden(),
    expect(declarerPage.locator('#roundReadyBar')).toBeHidden(),
    expect(guesserPage.locator('#roundReadyBar')).toBeHidden(),
  ]);

  await expect.poll(async () => {
    const [nextDeclarerState, nextGuesserState] = await Promise.all([
      getClientSnapshot(declarerPage),
      getClientSnapshot(guesserPage),
    ]);
    return {
      declarerTenpai: nextDeclarerState.tenpaiDeclarer,
      guesserTenpai: nextGuesserState.tenpaiDeclarer,
      declarerDiscards: nextDeclarerState.totalDiscards,
      guesserDiscards: nextGuesserState.totalDiscards,
      declarerDora: nextDeclarerState.doraCount,
      guesserDora: nextGuesserState.doraCount,
    };
  }, { timeout: 20_000 }).toEqual({
    declarerTenpai: null,
    guesserTenpai: null,
    declarerDiscards: 0,
    guesserDiscards: 0,
    declarerDora: 1,
    guesserDora: 1,
  });

  await ctx1.close();
  await ctx2.close();
});

test('Phase2 重连恢复：猜牌面板与 round_ready 状态可恢复', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const initialRoundNumber = p1State.roundNumber;
  const declarerPage = p1State.mySeat === 0 ? p1 : p2;
  const guesserPage = p1State.mySeat === 1 ? p1 : p2;
  const guesserSeat = p1State.mySeat === 1 ? p1State.mySeat : p2State.mySeat;
  const declarerSeat = guesserSeat === 0 ? 1 : 0;

  await triggerBackendPhase2Scenario(guesserPage, {
    already_guessed: [0, 9],
    tenpai_declarer: declarerSeat,
    message: '请在重连后继续猜牌。',
    declarer_closed: ['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '5m'],
    guesser_closed: ['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
    wall_draw_sequence: ['9p', '9s', '北', '中', '7p', '5m'],
    dora_indicator: '6p',
  });

  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await expect(guesserPage.locator('#guessTiles .tile[data-tile-type="0"]')).toHaveClass(/guessed/);
  await expect(guesserPage.locator('#guessTiles .tile[data-tile-type="9"]')).toHaveClass(/guessed/);

  await guesserPage.reload({ waitUntil: 'domcontentloaded' });
  await expect(guesserPage).toHaveURL(/\/game/);

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(guesserPage);
    return {
      phase: snapshot.phase,
      tenpaiDeclarer: snapshot.tenpaiDeclarer,
      roundNumber: snapshot.roundNumber,
      drawCount: snapshot.phase2DrawCount,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_guess',
    tenpaiDeclarer: declarerSeat,
    roundNumber: initialRoundNumber,
    drawCount: 0,
  });

  await expect(guesserPage.locator('#phase2Status')).toBeVisible();
  await expect(guesserPage.locator('#phase2Info')).toHaveText('请猜测对手的听牌');
  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await expect(guesserPage.locator('#guessTitle')).toHaveText('请选择2张牌进行猜测');
  await expect(guesserPage.locator('#guessTiles .tile[data-tile-type="0"]')).toHaveClass(/guessed/);
  await expect(guesserPage.locator('#guessTiles .tile[data-tile-type="9"]')).toHaveClass(/guessed/);
  await expect(guesserPage.locator('#guessTiles .tile[data-tile-type="0"]')).not.toHaveClass(/clickable/);

  await guesserPage.locator('#guessTiles .tile[data-tile-type="4"]').click();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="10"]').click();
  await expect(guesserPage.locator('#guessConfirm')).toBeEnabled();
  await guesserPage.evaluate(() => {
    const confirm = document.getElementById('guessConfirm');
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('猜牌确认按钮未就绪');
    }
    confirm.click();
  });

  await Promise.all([
    expect(declarerPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(guesserPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
  ]);

  await guesserPage.locator('#resultContinue').click();
  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(guesserPage);
    return snapshot.roundReadySeats.includes(guesserSeat);
  }, { timeout: 10_000 }).toBeTruthy();
  await expect(guesserPage.locator('#roundReadyBar')).toBeVisible();
  await expect(guesserPage.locator('#roundReadyText')).toHaveText('已继续，等待对手继续...');

  await guesserPage.reload({ waitUntil: 'domcontentloaded' });
  await expect(guesserPage).toHaveURL(/\/game/);
  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(guesserPage);
    return {
      phase: snapshot.phase,
      myReady: snapshot.roundReadySeats.includes(guesserSeat),
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'round_end',
    myReady: true,
  });

  await expect(guesserPage.locator('#roundReadyBar')).toBeVisible();
  await expect(guesserPage.locator('#roundReadyText')).toHaveText('已继续，等待对手继续...');
  await expect(guesserPage.locator('#btnRoundReady')).toBeHidden();

  await declarerPage.locator('#resultContinue').click();

  await expect.poll(async () => {
    const [nextDeclarerState, nextGuesserState] = await Promise.all([
      getClientSnapshot(declarerPage),
      getClientSnapshot(guesserPage),
    ]);
    return [nextDeclarerState.roundNumber, nextGuesserState.roundNumber];
  }, { timeout: 20_000 }).toEqual([initialRoundNumber + 1, initialRoundNumber + 1]);

  await Promise.all([
    expect(declarerPage.locator('#roundReadyBar')).toBeHidden(),
    expect(guesserPage.locator('#roundReadyBar')).toBeHidden(),
  ]);

  await ctx1.close();
  await ctx2.close();
});

test('四杠流局重连恢复：结果出现前刷新后结果与继续状态保持一致', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const initialRoundNumber = p1State.roundNumber;
  const actorPage = p1State.mySeat === 0 ? p1 : p2;
  const watcherPage = p1State.mySeat === 0 ? p2 : p1;
  const actorSeat = p1State.mySeat === 0 ? p1State.mySeat : p2State.mySeat;

  await triggerBackendPhase1ActionScenario(actorPage, {
    actor_seat: actorSeat,
    actor_closed: ['1p', '2p', '3p', '1s', '2s', '3s'],
    actor_draw: '5m',
    actor_melds: [
      { type: 'ankan', tiles: ['东', '东', '东', '东'] },
      { type: 'pon', tiles: ['5m', '5m', '5m'], called_index: 2 },
    ],
    opponent_closed: ['7m', '8m', '9m', '白', '发'],
    opponent_melds: [
      { type: 'ankan', tiles: ['南', '南', '南', '南'] },
      { type: 'ankan', tiles: ['西', '西', '西', '西'] },
    ],
    dora_indicator: '6p',
    actor_points: 25000,
    opponent_points: 25000,
    message: '宣告第四个杠后应立即进入四杠流局。',
  });

  await expect(actorPage.locator('#btnKan')).toBeVisible();
  await expect(watcherPage.locator('#resultOverlay')).toBeHidden();

  const wallBeforeAbort = (await getClientSnapshot(actorPage)).wallRemaining;

  await actorPage.locator('#btnKan').click();
  await actorPage.reload({ waitUntil: 'domcontentloaded' });
  await expect(actorPage).toHaveURL(/\/game/);

  await Promise.all([
    expect(actorPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(watcherPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
  ]);

  await expect(actorPage.locator('#resultTitle')).toHaveText('流局');
  await expect(watcherPage.locator('#resultTitle')).toHaveText('流局');
  await expect(actorPage.locator('#resultScore')).toContainText('四杠散了');
  await expect(watcherPage.locator('#resultScore')).toContainText('四杠散了');
  await expect(actorPage.locator('#resultPoints')).toContainText('25000');
  await expect(watcherPage.locator('#resultPoints')).toContainText('25000');

  await expect.poll(async () => {
    const [actorSnapshot, watcherSnapshot] = await Promise.all([
      getClientSnapshot(actorPage),
      getClientSnapshot(watcherPage),
    ]);
    return {
      actorPhase: actorSnapshot.phase,
      watcherPhase: watcherSnapshot.phase,
      actorPoints: actorSnapshot.myPoints,
      watcherPoints: watcherSnapshot.myPoints,
      actorMeldTypes: actorSnapshot.myMeldTypes,
      watcherOppMeldTypes: watcherSnapshot.oppMeldTypes,
      actorWall: actorSnapshot.wallRemaining,
      watcherWall: watcherSnapshot.wallRemaining,
      actorDora: actorSnapshot.doraCount,
      watcherDora: watcherSnapshot.doraCount,
    };
  }, { timeout: 15_000 }).toEqual({
    actorPhase: 'round_end',
    watcherPhase: 'round_end',
    actorPoints: 25000,
    watcherPoints: 25000,
    actorMeldTypes: ['ankan', 'kakan'],
    watcherOppMeldTypes: ['ankan', 'kakan'],
    actorWall: wallBeforeAbort,
    watcherWall: wallBeforeAbort,
    actorDora: 1,
    watcherDora: 1,
  });

  await actorPage.locator('#resultContinue').click();
  await expect(actorPage.locator('#roundReadyBar')).toBeVisible();
  await expect(actorPage.locator('#roundReadyText')).toHaveText('已继续，等待对手继续...');

  await actorPage.reload({ waitUntil: 'domcontentloaded' });
  await expect(actorPage).toHaveURL(/\/game/);
  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(actorPage);
    return {
      phase: snapshot.phase,
      myReady: snapshot.roundReadySeats.includes(actorSeat),
      wallRemaining: snapshot.wallRemaining,
      doraCount: snapshot.doraCount,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'round_end',
    myReady: true,
    wallRemaining: wallBeforeAbort,
    doraCount: 1,
  });

  await expect(actorPage.locator('#resultOverlay')).toBeHidden();
  await expect(actorPage.locator('#roundReadyBar')).toBeVisible();
  await expect(actorPage.locator('#btnRoundReady')).toBeHidden();

  await watcherPage.locator('#resultContinue').click();

  await expect.poll(async () => {
    const [nextActorState, nextWatcherState] = await Promise.all([
      getClientSnapshot(actorPage),
      getClientSnapshot(watcherPage),
    ]);
    return [nextActorState.roundNumber, nextWatcherState.roundNumber];
  }, { timeout: 20_000 }).toEqual([initialRoundNumber + 1, initialRoundNumber + 1]);

  await Promise.all([
    expect(actorPage.locator('#resultOverlay')).toBeHidden(),
    expect(watcherPage.locator('#resultOverlay')).toBeHidden(),
    expect(actorPage.locator('#roundReadyBar')).toBeHidden(),
    expect(watcherPage.locator('#roundReadyBar')).toBeHidden(),
  ]);

  await ctx1.close();
  await ctx2.close();
});

test('四杠流局重连恢复：结果已显示一段时间且对手先继续后，刷新仍保留继续状态', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const initialRoundNumber = p1State.roundNumber;
  const actorPage = p1State.mySeat === 0 ? p1 : p2;
  const watcherPage = p1State.mySeat === 0 ? p2 : p1;
  const actorSeat = p1State.mySeat === 0 ? p1State.mySeat : p2State.mySeat;
  const watcherSeat = 1 - actorSeat;

  await triggerBackendPhase1ActionScenario(actorPage, {
    actor_seat: actorSeat,
    actor_closed: ['1p', '2p', '3p', '1s', '2s', '3s'],
    actor_draw: '5m',
    actor_melds: [
      { type: 'ankan', tiles: ['东', '东', '东', '东'] },
      { type: 'pon', tiles: ['5m', '5m', '5m'], called_index: 2 },
    ],
    opponent_closed: ['7m', '8m', '9m', '白', '发'],
    opponent_melds: [
      { type: 'ankan', tiles: ['南', '南', '南', '南'] },
      { type: 'ankan', tiles: ['西', '西', '西', '西'] },
    ],
    dora_indicator: '6p',
    actor_points: 25000,
    opponent_points: 25000,
    message: '四杠流局结果停留一段时间后再刷新，应保留继续状态。',
  });

  await expect(actorPage.locator('#btnKan')).toBeVisible();
  const wallBeforeAbort = (await getClientSnapshot(actorPage)).wallRemaining;

  await actorPage.locator('#btnKan').click();

  await Promise.all([
    expect(actorPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(watcherPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
  ]);

  await Promise.all([
    waitForResultRevealComplete(actorPage),
    waitForResultRevealComplete(watcherPage),
  ]);

  await watcherPage.locator('#resultContinue').click();

  await expect(watcherPage.locator('#roundReadyBar')).toBeVisible();
  await expect(watcherPage.locator('#roundReadyText')).toHaveText('已继续，等待对手继续...');
  await expect(actorPage.locator('#roundReadyBar')).toBeVisible();
  await expect(actorPage.locator('#roundReadyText')).toHaveText('对手已继续，点击继续开始下一局');

  await actorPage.reload({ waitUntil: 'domcontentloaded' });
  await expect(actorPage).toHaveURL(/\/game/);

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(actorPage);
    return {
      phase: snapshot.phase,
      roundReadySeats: [...snapshot.roundReadySeats].sort((a, b) => a - b),
      wallRemaining: snapshot.wallRemaining,
      doraCount: snapshot.doraCount,
      myPoints: snapshot.myPoints,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'round_end',
    roundReadySeats: [watcherSeat],
    wallRemaining: wallBeforeAbort,
    doraCount: 1,
    myPoints: 25000,
  });

  await expect(actorPage.locator('#resultOverlay')).toBeVisible();
  await expect(actorPage.locator('#resultTitle')).toHaveText('流局');
  await expect(actorPage.locator('#resultScore')).toContainText('四杠散了');
  await expect(actorPage.locator('#resultPoints')).toContainText('25000');
  await expectResultRevealStatic(actorPage);
  await expect(actorPage.locator('#roundReadyBar')).toBeVisible();
  await expect(actorPage.locator('#roundReadyText')).toHaveText('对手已继续，点击继续开始下一局');
  await expect(actorPage.locator('#btnRoundReady')).toBeVisible();

  await actorPage.locator('#resultContinue').click();

  await expect.poll(async () => {
    const [nextActorState, nextWatcherState] = await Promise.all([
      getClientSnapshot(actorPage),
      getClientSnapshot(watcherPage),
    ]);
    return [nextActorState.roundNumber, nextWatcherState.roundNumber];
  }, { timeout: 20_000 }).toEqual([initialRoundNumber + 1, initialRoundNumber + 1]);

  await Promise.all([
    expect(actorPage.locator('#resultOverlay')).toBeHidden(),
    expect(watcherPage.locator('#resultOverlay')).toBeHidden(),
    expect(actorPage.locator('#roundReadyBar')).toBeHidden(),
    expect(watcherPage.locator('#roundReadyBar')).toBeHidden(),
  ]);

  await ctx1.close();
  await ctx2.close();
});

test('四杠流局重连恢复：刷新后结果音效不重播', async ({ browser }) => {
  test.setTimeout(120_000);

  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  await Promise.all([
    installAudioPlaySpy(ctx1),
    installAudioPlaySpy(ctx2),
  ]);
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const actorPage = p1State.mySeat === 0 ? p1 : p2;
  const watcherPage = actorPage === p1 ? p2 : p1;
  const actorSeat = p1State.mySeat === 0 ? p1State.mySeat : p2State.mySeat;

  await triggerBackendPhase1ActionScenario(actorPage, {
    actor_seat: actorSeat,
    actor_closed: ['1p', '2p', '3p', '1s', '2s', '3s'],
    actor_draw: '5m',
    actor_melds: [
      { type: 'ankan', tiles: ['东', '东', '东', '东'] },
      { type: 'pon', tiles: ['5m', '5m', '5m'], called_index: 2 },
    ],
    opponent_closed: ['7m', '8m', '9m', '白', '发'],
    opponent_melds: [
      { type: 'ankan', tiles: ['南', '南', '南', '南'] },
      { type: 'ankan', tiles: ['西', '西', '西', '西'] },
    ],
    dora_indicator: '6p',
    actor_points: 25000,
    opponent_points: 25000,
    message: '四杠流局重连恢复时，不应重播结果音效。',
  });

  await Promise.all([
    clearAudioPlayLog(actorPage),
    clearAudioPlayLog(watcherPage),
  ]);

  await expect(actorPage.locator('#btnKan')).toBeVisible();
  await actorPage.locator('#btnKan').click();

  await Promise.all([
    expect(actorPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(watcherPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
  ]);

  await expect.poll(async () => {
    return countAudioPlayByFragment(actorPage, 'se_result_draw_01.wav');
  }, { timeout: 5_000 }).toBe(1);

  await actorPage.reload({ waitUntil: 'domcontentloaded' });
  await expect(actorPage).toHaveURL(/\/game/);
  await expect(actorPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 });
  await expect(actorPage.locator('#resultTitle')).toHaveText('流局');
  await expect(actorPage.locator('#resultScore')).toContainText('四杠散了');

  await expect.poll(async () => {
    return countAudioPlayByFragment(actorPage, 'se_result_draw_01.wav');
  }, { timeout: 5_000 }).toBe(1);

  await ctx1.close();
  await ctx2.close();
});

test('自摸结果重连恢复：刷新后不重播 resultWin/resultLose', async ({ browser }) => {
  test.setTimeout(120_000);

  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  await Promise.all([
    installAudioPlaySpy(ctx1),
    installAudioPlaySpy(ctx2),
  ]);
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const actorPage = p1State.mySeat === 0 ? p1 : p2;
  const watcherPage = actorPage === p1 ? p2 : p1;

  const hookResult = await triggerBackendPhase1ActionScenario(actorPage, {
    actor_closed: ['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '5m'],
    actor_draw: '5m',
    opponent_closed: ['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
    dora_indicator: '6p',
  });

  expect(hookResult.actions.can_tsumo).toBeTruthy();

  await Promise.all([
    clearAudioPlayLog(actorPage),
    clearAudioPlayLog(watcherPage),
  ]);

  await expect(actorPage.locator('#btnTsumo')).toBeVisible();
  await actorPage.locator('#btnTsumo').click();

  await Promise.all([
    expect(actorPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(watcherPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
  ]);

  await expect.poll(async () => {
    return {
      actorWin: await countAudioPlayByFragment(actorPage, 'se_result_win_01.wav'),
      actorLose: await countAudioPlayByFragment(actorPage, 'se_result_lose_01.wav'),
      watcherWin: await countAudioPlayByFragment(watcherPage, 'se_result_win_01.wav'),
      watcherLose: await countAudioPlayByFragment(watcherPage, 'se_result_lose_01.wav'),
    };
  }, { timeout: 5_000 }).toEqual({
    actorWin: 1,
    actorLose: 0,
    watcherWin: 0,
    watcherLose: 1,
  });

  await actorPage.reload({ waitUntil: 'domcontentloaded' });
  await watcherPage.reload({ waitUntil: 'domcontentloaded' });

  await Promise.all([
    expect(actorPage).toHaveURL(/\/game/),
    expect(watcherPage).toHaveURL(/\/game/),
    expect(actorPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(watcherPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
  ]);

  await expect(actorPage.locator('#resultTitle')).toContainText('自摸');
  await expect(watcherPage.locator('#resultTitle')).toContainText('自摸');

  await expect.poll(async () => {
    return {
      actorWin: await countAudioPlayByFragment(actorPage, 'se_result_win_01.wav'),
      actorLose: await countAudioPlayByFragment(actorPage, 'se_result_lose_01.wav'),
      watcherWin: await countAudioPlayByFragment(watcherPage, 'se_result_win_01.wav'),
      watcherLose: await countAudioPlayByFragment(watcherPage, 'se_result_lose_01.wav'),
    };
  }, { timeout: 5_000 }).toEqual({
    actorWin: 1,
    actorLose: 0,
    watcherWin: 0,
    watcherLose: 1,
  });

  await ctx1.close();
  await ctx2.close();
});

test('荣和结果重连恢复：刷新后不重播 resultWin/resultLose', async ({ browser }) => {
  test.setTimeout(120_000);

  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  await Promise.all([
    installAudioPlaySpy(ctx1),
    installAudioPlaySpy(ctx2),
  ]);
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const actorPage = p1;
  const responderPage = p2;

  await triggerBackendPhase1ActionScenario(actorPage, {
    actor_closed: ['1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '4m'],
    actor_melds: [{ type: 'pon', tiles: ['5m', '5m', '5m'], called_index: 2 }],
    actor_draw: '5m',
    opponent_closed: ['3m', '4m', '1p', '2p', '3p', '1s', '2s', '3s', '南', '南', '南', '白', '白'],
    dora_indicator: '6p',
    actor_points: 25000,
    opponent_points: 25000,
  });

  await Promise.all([
    clearAudioPlayLog(actorPage),
    clearAudioPlayLog(responderPage),
  ]);

  await expect(actorPage.locator('#btnKan')).toBeVisible();
  await actorPage.locator('#btnKan').click();
  await expect(responderPage.locator('#btnRon')).toBeVisible();
  await responderPage.locator('#btnRon').click();

  await Promise.all([
    expect(actorPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(responderPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
  ]);

  await expect.poll(async () => {
    return {
      actorWin: await countAudioPlayByFragment(actorPage, 'se_result_win_01.wav'),
      actorLose: await countAudioPlayByFragment(actorPage, 'se_result_lose_01.wav'),
      responderWin: await countAudioPlayByFragment(responderPage, 'se_result_win_01.wav'),
      responderLose: await countAudioPlayByFragment(responderPage, 'se_result_lose_01.wav'),
    };
  }, { timeout: 5_000 }).toEqual({
    actorWin: 0,
    actorLose: 1,
    responderWin: 1,
    responderLose: 0,
  });

  await actorPage.reload({ waitUntil: 'domcontentloaded' });
  await responderPage.reload({ waitUntil: 'domcontentloaded' });

  await Promise.all([
    expect(actorPage).toHaveURL(/\/game/),
    expect(responderPage).toHaveURL(/\/game/),
    expect(actorPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(responderPage.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
  ]);

  await expect(actorPage.locator('#resultTitle')).toContainText('荣和');
  await expect(responderPage.locator('#resultTitle')).toContainText('荣和');

  await expect.poll(async () => {
    return {
      actorWin: await countAudioPlayByFragment(actorPage, 'se_result_win_01.wav'),
      actorLose: await countAudioPlayByFragment(actorPage, 'se_result_lose_01.wav'),
      responderWin: await countAudioPlayByFragment(responderPage, 'se_result_win_01.wav'),
      responderLose: await countAudioPlayByFragment(responderPage, 'se_result_lose_01.wav'),
    };
  }, { timeout: 5_000 }).toEqual({
    actorWin: 0,
    actorLose: 1,
    responderWin: 1,
    responderLose: 0,
  });

  await ctx1.close();
  await ctx2.close();
});

test('终局重连恢复：刷新后不重播 gameWin/gameLose 且终局信息保持权威一致', async ({ browser }) => {
  test.setTimeout(120_000);

  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  await Promise.all([
    installAudioPlaySpy(ctx1),
    installAudioPlaySpy(ctx2),
  ]);
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  await Promise.all([
    clearAudioPlayLog(p1),
    clearAudioPlayLog(p2),
  ]);

  const hookResult = await triggerBackendGameOverState(p1, {
    winner: 1,
    seat0_points: 25000,
    seat1_points: 25000,
    honba_count: 0,
    riichi_sticks: 0,
  });

  expect(hookResult.winner).toBe(1);
  expect(hookResult.final_points).toEqual({ 0: 25000, 1: 25000 });

  await Promise.all([
    expect(p1.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(p2.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(p1.locator('#matchOverPanel')).toBeVisible({ timeout: 15_000 }),
    expect(p2.locator('#matchOverPanel')).toBeVisible({ timeout: 15_000 }),
  ]);

  await expect(p1.locator('#matchOverTitle')).toHaveText('本场结束，对手获胜');
  await expect(p2.locator('#matchOverTitle')).toHaveText('本场结束，你获胜');
  await expect(p1.locator('#matchOverPoints')).toContainText('25000');
  await expect(p2.locator('#matchOverPoints')).toContainText('25000');

  await expect.poll(async () => {
    return {
      p1Win: await countAudioPlayByFragment(p1, 'se_game_win_01.wav'),
      p1Lose: await countAudioPlayByFragment(p1, 'se_game_lose_01.wav'),
      p2Win: await countAudioPlayByFragment(p2, 'se_game_win_01.wav'),
      p2Lose: await countAudioPlayByFragment(p2, 'se_game_lose_01.wav'),
    };
  }, { timeout: 5_000 }).toEqual({
    p1Win: 0,
    p1Lose: 1,
    p2Win: 1,
    p2Lose: 0,
  });

  await p1.reload({ waitUntil: 'domcontentloaded' });
  await p2.reload({ waitUntil: 'domcontentloaded' });

  await Promise.all([
    expect(p1).toHaveURL(/\/game/),
    expect(p2).toHaveURL(/\/game/),
    expect(p1.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(p2.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(p1.locator('#matchOverPanel')).toBeVisible({ timeout: 15_000 }),
    expect(p2.locator('#matchOverPanel')).toBeVisible({ timeout: 15_000 }),
  ]);

  await expect(p1.locator('#matchOverTitle')).toHaveText('本场结束，对手获胜');
  await expect(p2.locator('#matchOverTitle')).toHaveText('本场结束，你获胜');
  await expect(p1.locator('#matchOverPoints')).toContainText('25000');
  await expect(p2.locator('#matchOverPoints')).toContainText('25000');

  await expect.poll(async () => {
    return {
      p1Win: await countAudioPlayByFragment(p1, 'se_game_win_01.wav'),
      p1Lose: await countAudioPlayByFragment(p1, 'se_game_lose_01.wav'),
      p2Win: await countAudioPlayByFragment(p2, 'se_game_win_01.wav'),
      p2Lose: await countAudioPlayByFragment(p2, 'se_game_lose_01.wav'),
    };
  }, { timeout: 5_000 }).toEqual({
    p1Win: 0,
    p1Lose: 1,
    p2Win: 1,
    p2Lose: 0,
  });

  await ctx1.close();
  await ctx2.close();
});

test('终局重连恢复：上一手结算内容也会静默恢复一致', async ({ browser }) => {
  test.setTimeout(120_000);

  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  await Promise.all([
    installAudioPlaySpy(ctx1),
    installAudioPlaySpy(ctx2),
  ]);
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  await Promise.all([
    clearAudioPlayLog(p1),
    clearAudioPlayLog(p2),
  ]);

  const roundResultPayload = {
    type: 'tsumo',
    winner: 1,
    winner_name: P2.username,
    loser: 0,
    win_tile: 52,
    hand: {
      closed: [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52],
      melds: [],
    },
    dora_indicators: [60],
    uradora_indicators: [],
    score: {
      han: 1,
      fu: 30,
      total: 1000,
      yaku: ['menzen_tsumo'],
      uradora_indicators: [],
    },
    points: { 0: 24000, 1: 26000 },
    points_transfer: 1000,
    honba_count: 0,
    riichi_sticks: 0,
    honba_bonus: 0,
    riichi_bonus: 0,
    points_delta: { 0: 0, 1: 1000 },
  };

  const hookResult = await triggerBackendGameOverState(p1, {
    winner: 1,
    seat0_points: 24000,
    seat1_points: 26000,
    honba_count: 0,
    riichi_sticks: 0,
    round_result: roundResultPayload,
  });

  expect(hookResult.winner).toBe(1);

  await Promise.all([
    expect(p1.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(p2.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(p1.locator('#matchOverPanel')).toBeVisible({ timeout: 15_000 }),
    expect(p2.locator('#matchOverPanel')).toBeVisible({ timeout: 15_000 }),
  ]);

  await expect(p1.locator('#resultTitle')).toContainText('自摸');
  await expect(p2.locator('#resultTitle')).toContainText('自摸');
  await expect(p1.locator('#resultPoints')).toContainText('24000');
  await expect(p1.locator('#resultPoints')).toContainText('26000');
  await expect(p2.locator('#resultPoints')).toContainText('24000');
  await expect(p2.locator('#resultPoints')).toContainText('26000');
  await expect(p1.locator('#matchOverTitle')).toHaveText('本场结束，对手获胜');
  await expect(p2.locator('#matchOverTitle')).toHaveText('本场结束，你获胜');
  await expect(p1.locator('#resultContinue')).toBeHidden();
  await expect(p2.locator('#resultContinue')).toBeHidden();

  await expect.poll(async () => {
    return {
      p1ResultWin: await countAudioPlayByFragment(p1, 'se_result_win_01.wav'),
      p1ResultLose: await countAudioPlayByFragment(p1, 'se_result_lose_01.wav'),
      p1GameWin: await countAudioPlayByFragment(p1, 'se_game_win_01.wav'),
      p1GameLose: await countAudioPlayByFragment(p1, 'se_game_lose_01.wav'),
      p2ResultWin: await countAudioPlayByFragment(p2, 'se_result_win_01.wav'),
      p2ResultLose: await countAudioPlayByFragment(p2, 'se_result_lose_01.wav'),
      p2GameWin: await countAudioPlayByFragment(p2, 'se_game_win_01.wav'),
      p2GameLose: await countAudioPlayByFragment(p2, 'se_game_lose_01.wav'),
    };
  }, { timeout: 5_000 }).toEqual({
    p1ResultWin: 0,
    p1ResultLose: 1,
    p1GameWin: 0,
    p1GameLose: 1,
    p2ResultWin: 1,
    p2ResultLose: 0,
    p2GameWin: 1,
    p2GameLose: 0,
  });

  await p1.reload({ waitUntil: 'domcontentloaded' });
  await p2.reload({ waitUntil: 'domcontentloaded' });

  await Promise.all([
    expect(p1).toHaveURL(/\/game/),
    expect(p2).toHaveURL(/\/game/),
    expect(p1.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(p2.locator('#resultOverlay')).toBeVisible({ timeout: 15_000 }),
    expect(p1.locator('#matchOverPanel')).toBeVisible({ timeout: 15_000 }),
    expect(p2.locator('#matchOverPanel')).toBeVisible({ timeout: 15_000 }),
  ]);

  await expect(p1.locator('#resultTitle')).toContainText('自摸');
  await expect(p2.locator('#resultTitle')).toContainText('自摸');
  await expect(p1.locator('#resultPoints')).toContainText('24000');
  await expect(p1.locator('#resultPoints')).toContainText('26000');
  await expect(p2.locator('#resultPoints')).toContainText('24000');
  await expect(p2.locator('#resultPoints')).toContainText('26000');
  await Promise.all([
    expectResultRevealStatic(p1),
    expectResultRevealStatic(p2),
  ]);
  await expect(p1.locator('#matchOverTitle')).toHaveText('本场结束，对手获胜');
  await expect(p2.locator('#matchOverTitle')).toHaveText('本场结束，你获胜');
  await expect(p1.locator('#resultContinue')).toBeHidden();
  await expect(p2.locator('#resultContinue')).toBeHidden();

  await expect.poll(async () => {
    return {
      p1ResultWin: await countAudioPlayByFragment(p1, 'se_result_win_01.wav'),
      p1ResultLose: await countAudioPlayByFragment(p1, 'se_result_lose_01.wav'),
      p1GameWin: await countAudioPlayByFragment(p1, 'se_game_win_01.wav'),
      p1GameLose: await countAudioPlayByFragment(p1, 'se_game_lose_01.wav'),
      p2ResultWin: await countAudioPlayByFragment(p2, 'se_result_win_01.wav'),
      p2ResultLose: await countAudioPlayByFragment(p2, 'se_result_lose_01.wav'),
      p2GameWin: await countAudioPlayByFragment(p2, 'se_game_win_01.wav'),
      p2GameLose: await countAudioPlayByFragment(p2, 'se_game_lose_01.wav'),
    };
  }, { timeout: 5_000 }).toEqual({
    p1ResultWin: 0,
    p1ResultLose: 1,
    p1GameWin: 0,
    p1GameLose: 1,
    p2ResultWin: 1,
    p2ResultLose: 0,
    p2GameWin: 1,
    p2GameLose: 0,
  });

  await ctx1.close();
  await ctx2.close();
});

test('Phase2_draw 重连恢复：听牌方中途重连后摸牌流程不中断', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const initialRoundNumber = p1State.roundNumber;
  const declarerPage = p1State.mySeat === 0 ? p1 : p2;
  const guesserPage = p1State.mySeat === 1 ? p1 : p2;
  const declarerSeat = p1State.mySeat === 0 ? p1State.mySeat : p2State.mySeat;

  await triggerBackendPhase2Scenario(guesserPage, {
    already_guessed: [],
    tenpai_declarer: declarerSeat,
    message: '请先猜错进入摸牌阶段。',
    declarer_closed: ['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '5m'],
    guesser_closed: ['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
    wall_draw_sequence: ['9p', '9s', '北', '中', '7p', '5m'],
    dora_indicator: '6p',
  });

  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="1"]').click();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="10"]').click();
  await guesserPage.locator('#guessConfirm').click();

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return snapshot.phase === 'phase2_action' ? snapshot.phase2DrawCount : 0;
  }, { timeout: 15_000 }).toBeGreaterThan(0);

  const drawCountBeforeReload = (await getClientSnapshot(declarerPage)).phase2DrawCount;

  await declarerPage.reload({ waitUntil: 'domcontentloaded' });
  await expect(declarerPage).toHaveURL(/\/game/);

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      tenpaiDeclarer: snapshot.tenpaiDeclarer,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: drawCountBeforeReload,
    tenpaiDeclarer: declarerSeat,
  });

  await expect(declarerPage.locator('#phase2Status')).toBeVisible();
  await expect(declarerPage.locator('#phase2Info')).toContainText('请选择打牌或开杠');

  await finishPhase2DrawSequenceByDiscardingDrawTile(declarerPage, 5);

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(guesserPage);
    return snapshot.phase;
  }, { timeout: 20_000 }).toBe('phase2_guess');

  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await expect(guesserPage.locator('#guessTitle')).toHaveText('5次摸牌结束，未和牌。请再次选择2张牌进行猜测。');
  await expect(guesserPage.locator('#guessTiles .tile[data-tile-type="1"]')).toHaveClass(/guessed/);
  await expect(guesserPage.locator('#guessTiles .tile[data-tile-type="10"]')).toHaveClass(/guessed/);

  await expect.poll(async () => {
    const [nextDeclarerState, nextGuesserState] = await Promise.all([
      getClientSnapshot(declarerPage),
      getClientSnapshot(guesserPage),
    ]);
    return {
      guesserPhase: nextGuesserState.phase,
      declarerDrawCount: nextDeclarerState.phase2DrawCount,
      guesserDrawCount: nextGuesserState.phase2DrawCount,
      roundNumberA: nextDeclarerState.roundNumber,
      roundNumberB: nextGuesserState.roundNumber,
    };
  }, { timeout: 10_000 }).toEqual({
    guesserPhase: 'phase2_guess',
    declarerDrawCount: 5,
    guesserDrawCount: 5,
    roundNumberA: initialRoundNumber,
    roundNumberB: initialRoundNumber,
  });

  await ctx1.close();
  await ctx2.close();
});

test('Phase2 杠入口：可选择不开杠，也可暗杠补摸后继续', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const declarerPage = p1State.mySeat === 0 ? p1 : p2;
  const guesserPage = p1State.mySeat === 1 ? p1 : p2;
  const declarerSeat = p1State.mySeat === 0 ? p1State.mySeat : p2State.mySeat;

  const phase2KanPayload = {
    already_guessed: [],
    tenpai_declarer: declarerSeat,
    message: '请先猜错以进入 Phase2 摸牌。',
    declarer_closed: ['1m', '1m', '1m', '4m', '5m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东'],
    guesser_closed: ['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
    wall_draw_sequence: ['1m', '9p', '9s', '北', '中', '7p'],
    dora_indicator: '6p',
    rinshan_sequence: ['西'],
  };

  await triggerBackendPhase2Scenario(guesserPage, phase2KanPayload);

  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="4"]').click();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="10"]').click();
  await guesserPage.locator('#guessConfirm').click();

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      myMeldsCount: snapshot.myMeldsCount,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 1,
    myMeldsCount: 0,
  });

  await expect(declarerPage.locator('#btnKan')).toBeVisible();
  await discardCurrentDrawTile(declarerPage);

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      myMeldsCount: snapshot.myMeldsCount,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 2,
    myMeldsCount: 0,
  });

  await triggerBackendPhase2Scenario(guesserPage, phase2KanPayload);

  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="4"]').click();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="10"]').click();
  await guesserPage.locator('#guessConfirm').click();

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      doraCount: snapshot.doraCount,
      myMeldsCount: snapshot.myMeldsCount,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 1,
    doraCount: 1,
    myMeldsCount: 0,
  });

  await expect(declarerPage.locator('#btnKan')).toBeVisible();
  await declarerPage.locator('#btnKan').click();

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      doraCount: snapshot.doraCount,
      myMeldsCount: snapshot.myMeldsCount,
      myDrawTileType: snapshot.myDrawTileType,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 1,
    doraCount: 2,
    myMeldsCount: 1,
    myDrawTileType: 29,
  });

  await expect(declarerPage.locator('#myMelds .meld-group')).toHaveCount(1);
  await expect(declarerPage.locator('#phase2Info')).toHaveText('请选择打牌或开杠');

  await discardCurrentDrawTile(declarerPage);

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      doraCount: snapshot.doraCount,
      myMeldsCount: snapshot.myMeldsCount,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 2,
    doraCount: 2,
    myMeldsCount: 1,
  });

  await ctx1.close();
  await ctx2.close();
});

test('Phase2 加杠入口：可选择不加杠，也可加杠补摸后继续', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const declarerPage = p1State.mySeat === 0 ? p1 : p2;
  const guesserPage = p1State.mySeat === 1 ? p1 : p2;
  const declarerSeat = p1State.mySeat === 0 ? p1State.mySeat : p2State.mySeat;

  const phase2KakanPayload = {
    already_guessed: [],
    tenpai_declarer: declarerSeat,
    message: '请先猜错以进入 Phase2 摸牌。',
    declarer_closed: ['1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '4m'],
    declarer_melds: [{ type: 'pon', tiles: ['5m', '5m', '5m'], called_index: 2 }],
    guesser_closed: ['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
    wall_draw_sequence: ['5m', '9p', '9s', '北', '中', '7p'],
    dora_indicator: '6p',
    rinshan_sequence: ['西'],
  };

  await triggerBackendPhase2Scenario(guesserPage, phase2KakanPayload);

  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="4"]').click();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="10"]').click();
  await guesserPage.locator('#guessConfirm').click();

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      doraCount: snapshot.doraCount,
      myMeldsCount: snapshot.myMeldsCount,
      myFirstMeldType: snapshot.myFirstMeldType,
      myDrawTileType: snapshot.myDrawTileType,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 1,
    doraCount: 1,
    myMeldsCount: 1,
    myFirstMeldType: 'pon',
    myDrawTileType: 4,
  });

  await expect(declarerPage.locator('#btnKan')).toBeVisible();
  await discardCurrentDrawTile(declarerPage);

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      myMeldsCount: snapshot.myMeldsCount,
      myFirstMeldType: snapshot.myFirstMeldType,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 2,
    myMeldsCount: 1,
    myFirstMeldType: 'pon',
  });

  await triggerBackendPhase2Scenario(guesserPage, phase2KakanPayload);

  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="4"]').click();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="10"]').click();
  await guesserPage.locator('#guessConfirm').click();

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      doraCount: snapshot.doraCount,
      myMeldsCount: snapshot.myMeldsCount,
      myFirstMeldType: snapshot.myFirstMeldType,
      myDrawTileType: snapshot.myDrawTileType,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 1,
    doraCount: 1,
    myMeldsCount: 1,
    myFirstMeldType: 'pon',
    myDrawTileType: 4,
  });

  await expect(declarerPage.locator('#btnKan')).toBeVisible();
  await declarerPage.locator('#btnKan').click();

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      doraCount: snapshot.doraCount,
      myMeldsCount: snapshot.myMeldsCount,
      myFirstMeldType: snapshot.myFirstMeldType,
      myDrawTileType: snapshot.myDrawTileType,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 1,
    doraCount: 2,
    myMeldsCount: 1,
    myFirstMeldType: 'kakan',
    myDrawTileType: 29,
  });

  await expect(declarerPage.locator('#myMelds .meld-group')).toHaveCount(1);
  await expect(declarerPage.locator('#phase2Info')).toHaveText('请选择打牌或开杠');

  await discardCurrentDrawTile(declarerPage);

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      doraCount: snapshot.doraCount,
      myMeldsCount: snapshot.myMeldsCount,
      myFirstMeldType: snapshot.myFirstMeldType,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 2,
    doraCount: 2,
    myMeldsCount: 1,
    myFirstMeldType: 'kakan',
  });

  await ctx1.close();
  await ctx2.close();
});

test('Phase2 加杠后重连恢复：动作态、副露与补摸牌可恢复', async ({ browser }) => {
  test.setTimeout(120_000);

  const { ctx1, ctx2, p1, p2 } = await openTwoPlayers(browser);

  await login(p1, P1.username, P1.password);
  await login(p2, P2.username, P2.password);

  if (!/\/game$/.test(p1.url())) {
    await createRoom(p1);
  }
  if (!/\/game$/.test(p2.url())) {
    await joinFirstAvailableRoom(p2);
  }

  await Promise.all([
    expect(p1).toHaveURL(/\/game/, { timeout: 20_000 }),
    expect(p2).toHaveURL(/\/game/, { timeout: 20_000 }),
  ]);

  await readyBothUntilStarted(p1, p2);

  const [p1State, p2State] = await Promise.all([getClientSnapshot(p1), getClientSnapshot(p2)]);
  const declarerPage = p1State.mySeat === 0 ? p1 : p2;
  const guesserPage = p1State.mySeat === 1 ? p1 : p2;
  const declarerSeat = p1State.mySeat === 0 ? p1State.mySeat : p2State.mySeat;

  await triggerBackendPhase2Scenario(guesserPage, {
    already_guessed: [],
    tenpai_declarer: declarerSeat,
    message: '请先猜错以进入 Phase2 摸牌。',
    declarer_closed: ['1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '4m'],
    declarer_melds: [{ type: 'pon', tiles: ['5m', '5m', '5m'], called_index: 2 }],
    guesser_closed: ['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
    wall_draw_sequence: ['5m', '9p', '9s', '北', '中', '7p'],
    dora_indicator: '6p',
    rinshan_sequence: ['西'],
  });

  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="4"]').click();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="10"]').click();
  await guesserPage.locator('#guessConfirm').click();

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      myFirstMeldType: snapshot.myFirstMeldType,
      myDrawTileType: snapshot.myDrawTileType,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 1,
    myFirstMeldType: 'pon',
    myDrawTileType: 4,
  });

  await declarerPage.locator('#btnKan').click();

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      doraCount: snapshot.doraCount,
      myMeldsCount: snapshot.myMeldsCount,
      myFirstMeldType: snapshot.myFirstMeldType,
      myDrawTileType: snapshot.myDrawTileType,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 1,
    doraCount: 2,
    myMeldsCount: 1,
    myFirstMeldType: 'kakan',
    myDrawTileType: 29,
  });

  await declarerPage.reload({ waitUntil: 'domcontentloaded' });
  await expect(declarerPage).toHaveURL(/\/game/);

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      doraCount: snapshot.doraCount,
      tenpaiDeclarer: snapshot.tenpaiDeclarer,
      myMeldsCount: snapshot.myMeldsCount,
      myFirstMeldType: snapshot.myFirstMeldType,
      myDrawTileType: snapshot.myDrawTileType,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 1,
    doraCount: 2,
    tenpaiDeclarer: declarerSeat,
    myMeldsCount: 1,
    myFirstMeldType: 'kakan',
    myDrawTileType: 29,
  });

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return snapshot.clickableCount;
  }, { timeout: 10_000 }).toBeGreaterThan(0);

  await expect(declarerPage.locator('#phase2Status')).toBeVisible();
  await expect(declarerPage.locator('#phase2Info')).toHaveText('请选择打牌或开杠');
  await expect(declarerPage.locator('#myMelds .meld-group')).toHaveCount(1);

  await discardCurrentDrawTile(declarerPage);

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(declarerPage);
    return {
      phase: snapshot.phase,
      drawCount: snapshot.phase2DrawCount,
      doraCount: snapshot.doraCount,
      myMeldsCount: snapshot.myMeldsCount,
      myFirstMeldType: snapshot.myFirstMeldType,
    };
  }, { timeout: 15_000 }).toEqual({
    phase: 'phase2_action',
    drawCount: 2,
    doraCount: 2,
    myMeldsCount: 1,
    myFirstMeldType: 'kakan',
  });

  await ctx1.close();
  await ctx2.close();
});

test('音频设置：大厅滑杆调整后会持久化到对局页', async ({ browser }) => {
  test.setTimeout(45_000);

  const context = await browser.newContext();
  const page = await context.newPage();

  await login(page, P1.username, P1.password);
  await expect(page).toHaveURL(/\/lobby/);

  const setRangeValue = async (selector: string, value: number) => {
    const slider = page.locator(selector);
    const current = Number(await slider.inputValue());
    const delta = value - current;
    const steps = Math.abs(delta) / 5;
    await slider.focus();
    for (let i = 0; i < steps; i++) {
      await page.keyboard.press(delta > 0 ? 'ArrowRight' : 'ArrowLeft');
    }
  };

  await expect(page.locator('#audioSeVolume')).toHaveValue('45');
  await expect(page.locator('#audioBgmVolume')).toHaveValue('30');

  await setRangeValue('#audioSeVolume', 35);
  await setRangeValue('#audioBgmVolume', 15);

  await page.reload();
  await expect(page.locator('#audioSeVolume')).toHaveValue('35');
  await expect(page.locator('#audioBgmVolume')).toHaveValue('15');

  await createRoom(page);
  await expect(page.locator('#audioSeVolume')).toHaveValue('35');
  await expect(page.locator('#audioBgmVolume')).toHaveValue('15');

  await context.close();
});
