(function () {
  const STORAGE_KEY = 'futari_audio_settings_v2';
  const FILES = {
    bgm: {
      lobby: '/static/assets/audio/bgm/bgm_lobby_calm_loop_v1.wav',
      ready: '/static/assets/audio/bgm/bgm_room_ready_wait_loop_v1.wav',
      match: '/static/assets/audio/bgm/bgm_match_main_loop_v1.wav',
      phase2: '/static/assets/audio/bgm/bgm_match_phase2_tense_loop_v1.wav',
    },
    se: {
      uiTap: '/static/assets/audio/se/se_ui_click_soft_01.wav',
      uiConfirm: '/static/assets/audio/se/se_ui_confirm_01.wav',
      uiCancel: '/static/assets/audio/se/se_ui_cancel_01.wav',
      matchFound: '/static/assets/audio/se/se_lobby_match_found_01.wav',
      roomReadyOn: '/static/assets/audio/se/se_room_ready_on_01.wav',
      roomReadyOff: '/static/assets/audio/se/se_room_ready_off_01.wav',
      roundStart: '/static/assets/audio/se/se_round_start_01.wav',
      drawSelf: '/static/assets/audio/se/se_tile_draw_01.wav',
      drawOpponent: '/static/assets/audio/se/se_tile_draw_01.wav',
      discardSelf: '/static/assets/audio/se/se_tile_discard_01.wav',
      discardOpponent: '/static/assets/audio/se/se_tile_discard_01.wav',
      actionPrompt: '/static/assets/audio/se/se_action_prompt_01.wav',
      callChi: '/static/assets/audio/se/se_call_chi_01.wav',
      callPon: '/static/assets/audio/se/se_call_pon_01.wav',
      callKan: '/static/assets/audio/se/se_call_kan_01.wav',
      tenpaiSelf: '/static/assets/audio/se/se_tenpai_alert_01.wav',
      tenpaiOpponent: '/static/assets/audio/se/se_tenpai_alert_01.wav',
      phase2Start: '/static/assets/audio/se/se_phase2_enter_01.wav',
      guessHit: '/static/assets/audio/se/se_guess_hit_01.wav',
      guessMiss: '/static/assets/audio/se/se_guess_miss_01.wav',
      phase2Draw: '/static/assets/audio/se/se_tile_draw_01.wav',
      timerWarning: '/static/assets/audio/se/se_timer_warning_01.wav',
      resultWin: '/static/assets/audio/se/se_result_win_01.wav',
      resultLose: '/static/assets/audio/se/se_result_lose_01.wav',
      resultDraw: '/static/assets/audio/se/se_result_draw_01.wav',
      gameWin: '/static/assets/audio/se/se_game_win_01.wav',
      gameLose: '/static/assets/audio/se/se_game_lose_01.wav',
    },
  };

  const PLAY_MAP = {
    uiTap: { key: 'uiTap' },
    uiConfirm: { key: 'uiConfirm' },
    uiCancel: { key: 'uiCancel' },
    matchFound: { key: 'matchFound' },
    roomReadyOn: { key: 'roomReadyOn' },
    roomReadyOff: { key: 'roomReadyOff' },
    roundStart: { key: 'roundStart' },
    drawSelf: { key: 'drawSelf' },
    drawOpponent: { key: 'drawOpponent', gain: 0.72 },
    discardSelf: { key: 'discardSelf' },
    discardOpponent: { key: 'discardOpponent', gain: 0.8 },
    actionPrompt: { key: 'actionPrompt' },
    tenpaiSelf: { key: 'tenpaiSelf' },
    tenpaiOpponent: { key: 'tenpaiOpponent', gain: 1.08 },
    phase2Start: { key: 'phase2Start' },
    guessHit: { key: 'guessHit' },
    guessMiss: { key: 'guessMiss' },
    phase2Draw: { key: 'phase2Draw' },
    resultWin: { key: 'resultWin' },
    resultLose: { key: 'resultLose' },
    resultDraw: { key: 'resultDraw' },
    gameWin: { key: 'gameWin' },
    gameLose: { key: 'gameLose' },
  };

  function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function loadSettings(defaults) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return {
          muted: false,
          seVolume: defaults.seVolume,
          bgmVolume: defaults.bgmVolume,
        };
      }
      const parsed = JSON.parse(raw);
      return {
        muted: !!parsed.muted,
        seVolume: clampNumber(Number(parsed.seVolume) || defaults.seVolume, 0, 1),
        bgmVolume: clampNumber(Number(parsed.bgmVolume) || defaults.bgmVolume, 0, 1),
      };
    } catch (_) {
      return {
        muted: false,
        seVolume: defaults.seVolume,
        bgmVolume: defaults.bgmVolume,
      };
    }
  }

  function saveSettings(settings) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function createAudio(url, loop) {
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.loop = !!loop;
    return audio;
  }

  function fadeAudio(audio, from, to, duration, onDone) {
    if (!audio) {
      if (onDone) onDone();
      return;
    }
    if (!duration || duration <= 0) {
      audio.volume = to;
      if (onDone) onDone();
      return;
    }

    const start = performance.now();
    function step(now) {
      const ratio = clampNumber((now - start) / duration, 0, 1);
      audio.volume = from + (to - from) * ratio;
      if (ratio < 1) {
        requestAnimationFrame(step);
        return;
      }
      if (onDone) onDone();
    }
    requestAnimationFrame(step);
  }

  window.createFutariAudioManager = function createFutariAudioManager(options = {}) {
    const defaults = {
      seVolume: clampNumber(Number(options.defaultSeVolume) || 0.6, 0, 1),
      bgmVolume: clampNumber(Number(options.defaultBgmVolume) || 0.22, 0, 1),
    };
    const settings = loadSettings(defaults);
    const sePools = new Map();
    let unlocked = false;
    let currentBgm = null;
    let currentBgmKey = null;
    let currentBgmGain = 1;
    let pendingBgm = null;
    let lastTimerTick = null;
    let controls = null;

    function persist() {
      saveSettings(settings);
    }

    function effectiveSeVolume(gain) {
      if (settings.muted) return 0;
      return clampNumber(settings.seVolume * gain, 0, 1);
    }

    function effectiveBgmVolume(gain) {
      if (settings.muted) return 0;
      return clampNumber(settings.bgmVolume * gain, 0, 1);
    }

    function applyCurrentBgmVolume() {
      if (!currentBgm) return;
      currentBgm.volume = effectiveBgmVolume(currentBgmGain);
    }

    function getSeAudio(key) {
      let pool = sePools.get(key);
      if (!pool) {
        pool = Array.from({ length: 4 }, () => createAudio(FILES.se[key], false));
        sePools.set(key, pool);
      }
      const idle = pool.find((audio) => audio.paused || audio.ended);
      return idle || pool[0].cloneNode();
    }

    function unlock() {
      if (unlocked) return;
      unlocked = true;
      if (pendingBgm) {
        const next = pendingBgm;
        pendingBgm = null;
        playBgm(next.key, next.options);
      }
      refreshControls();
    }

    function playSe(key, gain) {
      const volume = effectiveSeVolume(gain);
      if (volume <= 0) return false;
      const audio = getSeAudio(key);
      audio.currentTime = 0;
      audio.volume = volume;
      audio.play().catch(() => {
        unlocked = false;
        refreshControls();
      });
      return true;
    }

    function stopBgm(options = {}) {
      const fadeMs = options.fadeMs ?? 240;
      if (!currentBgm) return;
      const audio = currentBgm;
      currentBgm = null;
      currentBgmKey = null;
      fadeAudio(audio, audio.volume, 0, fadeMs, () => {
        audio.pause();
        audio.currentTime = 0;
      });
      refreshControls();
    }

    function playBgm(key, options = {}) {
      const gain = clampNumber(Number(options.gain) || 1, 0, 1.5);
      const fadeMs = options.fadeMs ?? 320;
      if (!FILES.bgm[key]) return false;
      if (!unlocked) {
        pendingBgm = { key, options: { gain, fadeMs } };
        refreshControls();
        return false;
      }
      if (currentBgmKey === key && currentBgm) {
        currentBgmGain = gain;
        applyCurrentBgmVolume();
        return true;
      }

      const next = createAudio(FILES.bgm[key], true);
      next.volume = 0;
      next.play().then(() => {
        const previous = currentBgm;
        currentBgm = next;
        currentBgmKey = key;
        currentBgmGain = gain;
        fadeAudio(next, 0, effectiveBgmVolume(gain), fadeMs);
        if (previous) {
          const previousVolume = previous.volume;
          fadeAudio(previous, previousVolume, 0, fadeMs, () => {
            previous.pause();
            previous.currentTime = 0;
          });
        }
        refreshControls();
      }).catch(() => {
        pendingBgm = { key, options: { gain, fadeMs } };
        unlocked = false;
        refreshControls();
      });
      return true;
    }

    function resolvePlayDescriptor(name, detail) {
      if (name === 'callMade') {
        const callType = detail.callType || 'chi';
        if (callType === 'chi') return { key: 'callChi', gain: detail.myAction ? 1 : 0.82 };
        if (callType === 'pon') return { key: 'callPon', gain: detail.myAction ? 1 : 0.84 };
        return { key: 'callKan', gain: detail.myAction ? 1 : 0.86 };
      }
      if (name === 'phase2Draw') {
        return { key: 'phase2Draw', gain: detail.isWin ? 1.08 : 0.9 };
      }
      return PLAY_MAP[name] || null;
    }

    function play(name, detail = {}) {
      const descriptor = resolvePlayDescriptor(name, detail);
      if (!descriptor) return false;
      return playSe(descriptor.key, descriptor.gain ?? 1);
    }

    function syncTimer(secondsRemaining) {
      const thresholds = new Set([10, 5, 3, 2, 1]);
      if (!Number.isInteger(secondsRemaining)) return;
      if (secondsRemaining <= 0) {
        lastTimerTick = null;
        return;
      }
      if (thresholds.has(secondsRemaining) && lastTimerTick !== secondsRemaining) {
        playSe('timerWarning', 0.9);
      }
      if (secondsRemaining > 10) {
        lastTimerTick = null;
      } else {
        lastTimerTick = secondsRemaining;
      }
    }

    function bindControls(ids = {}) {
      controls = {
        root: document.getElementById(ids.rootId || 'audioControls'),
        mute: document.getElementById(ids.muteButtonId || 'audioMuteToggle'),
        se: document.getElementById(ids.seSliderId || 'audioSeVolume'),
        bgm: document.getElementById(ids.bgmSliderId || 'audioBgmVolume'),
        status: document.getElementById(ids.statusId || 'audioStatus'),
      };
      if (!controls.root) return;
      if (controls.mute) {
        controls.mute.addEventListener('click', () => {
          unlock();
          settings.muted = !settings.muted;
          applyCurrentBgmVolume();
          persist();
          refreshControls();
          if (!settings.muted) {
            playSe('uiTap', 0.8);
          }
        });
      }
      if (controls.se) {
        controls.se.value = String(Math.round(settings.seVolume * 100));
        controls.se.addEventListener('input', (event) => {
          unlock();
          settings.seVolume = clampNumber(Number(event.target.value) / 100, 0, 1);
          persist();
          refreshControls();
        });
        controls.se.addEventListener('change', () => {
          playSe('uiTap', 0.75);
        });
      }
      if (controls.bgm) {
        controls.bgm.value = String(Math.round(settings.bgmVolume * 100));
        controls.bgm.addEventListener('input', (event) => {
          unlock();
          settings.bgmVolume = clampNumber(Number(event.target.value) / 100, 0, 1);
          applyCurrentBgmVolume();
          persist();
          refreshControls();
        });
      }
      refreshControls();
    }

    function refreshControls() {
      if (!controls || !controls.root) return;
      if (controls.mute) {
        if (settings.muted) {
          controls.mute.textContent = '声音关';
        } else if (!unlocked && pendingBgm) {
          controls.mute.textContent = '点一下开声';
        } else {
          controls.mute.textContent = '声音开';
        }
      }
      if (controls.se) {
        controls.se.value = String(Math.round(settings.seVolume * 100));
      }
      if (controls.bgm) {
        controls.bgm.value = String(Math.round(settings.bgmVolume * 100));
      }
      if (controls.status) {
        const prefix = settings.muted ? '已静音' : (unlocked ? '已启用' : '待启用');
        controls.status.textContent = prefix + ' · SE ' + Math.round(settings.seVolume * 100) + '% · BGM ' + Math.round(settings.bgmVolume * 100) + '%';
      }
      controls.root.classList.toggle('is-muted', settings.muted);
    }

    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);

    return {
      bindControls,
      refreshControls,
      play,
      playBgm,
      stopBgm,
      syncTimer,
      resetRound() {
        lastTimerTick = null;
      },
      setMuted(nextMuted) {
        settings.muted = !!nextMuted;
        applyCurrentBgmVolume();
        persist();
        refreshControls();
      },
      isMuted() {
        return settings.muted;
      },
      unlock,
    };
  };
})();
