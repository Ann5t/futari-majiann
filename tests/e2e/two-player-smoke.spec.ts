import { expect, test, Page, Browser, APIRequestContext } from '@playwright/test';

declare const process: { env: Record<string, string | undefined> };

const P1 = { username: process.env.E2E_USER1 || 'player1', password: process.env.E2E_PASS1 || 'pass1' };
const P2 = { username: process.env.E2E_USER2 || 'player2', password: process.env.E2E_PASS2 || 'pass2' };

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

async function openTwoPlayers(browser: Browser) {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();
  return { ctx1, ctx2, p1, p2 };
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
      state.myPoints = 25000;
      state.oppClosedCount = 13;
      state.oppMelds = [];
      state.oppDiscards = [];
      state.oppPoints = 25000;
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

  await expect.poll(async () => {
    const snapshot = await getClientSnapshot(p1);
    return snapshot.totalDiscards;
  }, { timeout: 15_000 }).toBeGreaterThanOrEqual(initialTotalDiscards + 2);

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

test('门清听牌：动作条可选择立直或默听，立直后立直棒与点数立即更新', async ({ browser }) => {
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
  });

  await expect(actorPage.locator('#btnRiichi')).toBeVisible();
  await expect(actorPage.locator('#btnTenpai')).toBeVisible();
  await expect(actorPage.locator('#btnTenpai')).toHaveText('默听');

  await actorPage.locator('#btnRiichi').click();

  await expect(actorPage.locator('#myPoints')).toHaveText('24000');
  await expect(actorPage.locator('#riichiStickInfo')).toHaveText('立直棒: 1');

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

  await expect(declarerPage.locator('#phase2Info')).toHaveText('请选择打牌或开杠');
  await finishPhase2DrawSequenceByDiscardingDrawTile(declarerPage, 5);

  await expect(guesserPage.locator('#guessPanel')).toBeVisible();
  await expect(guesserPage.locator('#guessTitle')).toHaveText('5次摸牌结束，未和牌。请再次选择2张牌进行猜测。', { timeout: 20_000 });
  await expect(guesserPage.locator('#guessTiles .tile[data-tile-type="1"]')).toHaveClass(/guessed/);
  await expect(guesserPage.locator('#guessTiles .tile[data-tile-type="10"]')).toHaveClass(/guessed/);

  await guesserPage.locator('#guessTiles .tile[data-tile-type="2"]').click();
  await guesserPage.locator('#guessTiles .tile[data-tile-type="11"]').click();
  await guesserPage.locator('#guessConfirm').click();

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
  expect(resultDeclarerState.myPoints).toBeGreaterThan(25000);
  expect(resultGuesserState.myPoints).toBeLessThan(25000);

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

  const [resultDeclarerState, resultGuesserState] = await Promise.all([
    getClientSnapshot(declarerPage),
    getClientSnapshot(guesserPage),
  ]);
  expect(resultDeclarerState.myPoints).toBe(22000);
  expect(resultGuesserState.myPoints).toBe(28000);

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
  await guesserPage.locator('#guessConfirm').click();

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
