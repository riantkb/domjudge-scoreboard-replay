// SPDX-License-Identifier: GPL-2.0-or-later
// Keep scoring and the viewer in one asset so cached versions cannot diverge.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ScoreboardCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function toMillis(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const millis = Date.parse(value);
    if (!Number.isFinite(millis)) {
      throw new Error(`Invalid timestamp: ${value}`);
    }
    return millis;
  }

  function findLastJudgementCompletion(data, startTime, endTime) {
    const startMs = toMillis(startTime);
    const endMs = toMillis(endTime);
    let lastCompletionMs = endMs;

    for (const attempt of data.attempts) {
      lastCompletionMs = Math.max(lastCompletionMs, startMs + attempt[3]);
    }

    return lastCompletionMs;
  }

  function buildScoreboard(data, options) {
    // Each attempt is [team index, problem index, submitted ms, judged ms,
    // result code], with times relative to the contest start.
    const startMs = toMillis(options.startTime);
    const endMs = toMillis(options.endTime);
    const targetMs =
      typeof options.targetTime === "number"
        ? options.targetTime
        : toMillis(options.targetTime);
    const penaltyMinutes = Number(options.penaltyMinutes ?? 20);
    const freezeStartMs = options.freezeStartTime
      ? toMillis(options.freezeStartTime)
      : null;
    const freezeActive = Boolean(
      options.applyFreeze &&
        freezeStartMs !== null &&
        targetMs >= freezeStartMs,
    );

    const teams = data.teams.map((team, index) => ({
      id: index,
      display: team[0],
      affiliation: team[1],
    }));
    const teamOrder = new Map(teams.map((team, index) => [team.id, index]));
    const problems = data.problems.map((problem, index) => ({
      id: index,
      label: problem[0],
      name: problem[1],
      rgb: problem[2],
    }));
    const targetOffsetMs = targetMs - startMs;
    const submissions = data.attempts.filter(
      (attempt) => attempt[2] < endMs - startMs && attempt[2] <= targetOffsetMs,
    );

    const grouped = new Map();
    for (const submission of submissions) {
      const key = `${submission[0]}\u0000${submission[1]}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(submission);
    }

    const cellsByTeam = new Map();
    for (const team of teams) {
      const cells = new Map();
      for (const problem of problems) {
        const key = `${team.id}\u0000${problem.id}`;
        const problemSubmissions = grouped.get(key) || [];
        let solved = false;
        let solveTime = null;
        let solvedAtMs = null;
        let numJudged = 0;
        let numPending = 0;
        let wrongAttempts = 0;

        for (const submission of problemSubmissions) {
          if (solved) break;
          const completedMs = startMs + submission[3];
          const submittedMs = startMs + submission[2];
          const hiddenByFreeze = Boolean(
            freezeActive && submittedMs >= freezeStartMs,
          );
          const resultAvailable = Boolean(
            !hiddenByFreeze && completedMs <= targetMs,
          );

          if (!resultAvailable) {
            numPending += 1;
            continue;
          }

          if (submission[4] === 2) {
            numJudged += 1;
            solved = true;
            solveTime = Math.floor(submission[2] / 60_000);
            solvedAtMs = submittedMs;
          } else if (submission[4] === 1) {
            numJudged += 1;
            wrongAttempts += 1;
          }
          // DOMjudge does not include non-penalizing failures such as CE in
          // num_judged or the score penalty.
        }

        cells.set(problem.id, {
          problemId: problem.id,
          label: problem.label,
          solved,
          solveTime,
          solvedAtMs,
          numJudged,
          numPending,
          wrongAttempts,
          firstToSolve: false,
        });
      }
      cellsByTeam.set(team.id, cells);
    }

    for (const problem of problems) {
      let firstSolvedAt = Number.POSITIVE_INFINITY;
      for (const cells of cellsByTeam.values()) {
        const cell = cells.get(problem.id);
        if (cell.solved && cell.solvedAtMs < firstSolvedAt) {
          firstSolvedAt = cell.solvedAtMs;
        }
      }
      if (Number.isFinite(firstSolvedAt)) {
        for (const cells of cellsByTeam.values()) {
          const cell = cells.get(problem.id);
          if (cell.solvedAtMs === firstSolvedAt) cell.firstToSolve = true;
        }
      }
    }

    const rows = teams.map((team) => {
      const cells = problems.map((problem) =>
        cellsByTeam.get(team.id).get(problem.id),
      );
      const solvedCells = cells.filter((cell) => cell.solved);
      return {
        team,
        score: {
          numSolved: solvedCells.length,
          totalTime: solvedCells.reduce(
            (total, cell) =>
              total + cell.solveTime + penaltyMinutes * cell.wrongAttempts,
            0,
          ),
          lastSolvedMinute: solvedCells.reduce(
            (latest, cell) => Math.max(latest, cell.solveTime),
            0,
          ),
        },
        problems: cells,
        rank: 0,
      };
    });

    // DOMjudge uses the last solve time after solved count and total penalty.
    rows.sort((left, right) => {
      return (
        right.score.numSolved - left.score.numSolved ||
        left.score.totalTime - right.score.totalTime ||
        left.score.lastSolvedMinute - right.score.lastSolvedMinute ||
        teamOrder.get(left.team.id) - teamOrder.get(right.team.id)
      );
    });

    let previous = null;
    rows.forEach((row, index) => {
      const tied =
        previous &&
        previous.score.numSolved === row.score.numSolved &&
        previous.score.totalTime === row.score.totalTime &&
        previous.score.lastSolvedMinute === row.score.lastSolvedMinute;
      row.rank = tied ? previous.rank : index + 1;
      previous = row;
    });

    const problemStats = problems.map((problem, index) => {
      let solved = 0;
      let attempted = 0;
      let pending = 0;
      let rejected = 0;
      let firstSolvedMinute = null;
      for (const row of rows) {
        const cell = row.problems[index];
        if (cell.solved) {
          solved += 1;
          if (firstSolvedMinute === null || cell.solveTime < firstSolvedMinute) {
            firstSolvedMinute = cell.solveTime;
          }
        }
        if (cell.numJudged > 0 || cell.numPending > 0) attempted += 1;
        pending += cell.numPending;
        rejected += cell.wrongAttempts;
      }
      return { problemId: problem.id, solved, attempted, rejected, pending, firstSolvedMinute };
    });

    return {
      rows,
      problems,
      problemStats,
      freezeActive,
      targetMs,
      totals: {
        teams: rows.length,
        solved: rows.reduce((sum, row) => sum + row.score.numSolved, 0),
        pending: rows.reduce(
          (sum, row) =>
            sum +
            row.problems.reduce(
              (problemSum, cell) => problemSum + cell.numPending,
              0,
            ),
          0,
        ),
      },
    };
  }

  function parseElapsed(value) {
    const match = String(value)
      .trim()
      .match(/^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/);
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
  }

  function formatElapsed(totalSeconds, includeSeconds = false) {
    const seconds = Math.max(0, Math.round(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    const base = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    return includeSeconds ? `${base}:${String(rest).padStart(2, "0")}` : base;
  }

  return {
    buildScoreboard,
    findLastJudgementCompletion,
    formatElapsed,
    parseElapsed,
    toMillis,
  };
});
(function () {
  "use strict";

  const MANIFEST_URL = "./data/contests.manifest.json";
  const core = globalThis.ScoreboardCore;

  const elements = {
    contestSelect: document.querySelector("#contest-select"),
    contestTimer: document.querySelector("#contest-timer"),
    customSpeed: document.querySelector("#custom-speed"),
    customSpeedField: document.querySelector("#custom-speed-field"),
    elapsedInput: document.querySelector("#elapsed-input"),
    errorMessage: document.querySelector("#error-message"),
    errorState: document.querySelector("#error-state"),
    endMark: document.querySelector("#end-mark"),
    freezeMark: document.querySelector("#freeze-mark"),
    freezeToggle: document.querySelector("#freeze-toggle"),
    loadingState: document.querySelector("#loading-state"),
    pendingCard: document.querySelector(".pending-card"),
    pendingCount: document.querySelector("#pending-count"),
    playbackSpeed: document.querySelector("#playback-speed"),
    playButton: document.querySelector("#play-button"),
    playIcon: document.querySelector(".play-icon"),
    playLabel: document.querySelector("#play-label"),
    scoreboardBody: document.querySelector("#scoreboard-body"),
    scoreboardHead: document.querySelector("#scoreboard-head"),
    scoreboardSummary: document.querySelector("#scoreboard-summary"),
    solvedCount: document.querySelector("#solved-count"),
    stickyHeader: document.querySelector("#sticky-scoreboard-header"),
    stickyHead: document.querySelector("#sticky-scoreboard-head"),
    stickyTable: document.querySelector("#sticky-scoreboard-table"),
    tableScroll: document.querySelector("#table-scroll"),
    scoreboardTable: document.querySelector("#scoreboard-table"),
    teamCount: document.querySelector("#team-count"),
    teamFilter: document.querySelector("#team-filter"),
    timeRange: document.querySelector("#time-range"),
    timelineEndLabel: document.querySelector("#timeline-end-label"),
    timelineFreezeLabel: document.querySelector("#timeline-freeze-label"),
    wallClock: document.querySelector("#wall-clock"),
  };

  const state = {
    data: null,
    startMs: 0,
    endMs: 0,
    judgedMs: 0,
    freezeMs: null,
    maxSeconds: 0,
    elapsedSeconds: 0,
    penaltyMinutes: 20,
    clockOffsetMinutes: 0,
    clockZoneLabel: "UTC",
    playing: false,
    customSpeed: 1,
    seeking: false,
    playbackFrame: null,
    playbackElapsedSeconds: 0,
    playbackLastFrameMs: null,
    playbackLastRenderMs: null,
    result: null,
    stickyFrame: null,
    renderedHeaderData: null,
    contests: [],
    loadSerial: 0,
  };

  const clockFormatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  function contestClockZone(start) {
    const match = /([+-])(\d{2}):?(\d{2})$/.exec(start);
    if (!match) return { offsetMinutes: 0, label: "UTC" };
    const sign = match[1] === "+" ? 1 : -1;
    return {
      offsetMinutes: sign * (Number(match[2]) * 60 + Number(match[3])),
      label: `UTC${match[1]}${match[2]}:${match[3]}`,
    };
  }

  async function fetchJson(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function elapsedAt(timestamp) {
    return Math.max(0, Math.round((timestamp - state.startMs) / 1000));
  }

  function setElapsed(seconds, render = true) {
    state.elapsedSeconds = clamp(Math.round(seconds), 0, state.maxSeconds);
    elements.timeRange.value = String(state.elapsedSeconds);
    elements.elapsedInput.value = core.formatElapsed(state.elapsedSeconds, true);
    const progress = (state.elapsedSeconds / state.maxSeconds) * 100;
    elements.timeRange.style.setProperty("--range-progress", `${progress}%`);
    if (render) renderScoreboard();
  }

  function configureTimeline() {
    const contestEndSeconds = elapsedAt(state.endMs);
    state.maxSeconds = Math.max(contestEndSeconds, Math.ceil((state.judgedMs - state.startMs) / 1000));
    elements.timeRange.max = String(state.maxSeconds);
    elements.timeRange.step = "1";

    const freezeSeconds = state.freezeMs ? elapsedAt(state.freezeMs) : null;
    const freezePosition = freezeSeconds === null ? 0 : (freezeSeconds / state.maxSeconds) * 100;
    const endPosition = (contestEndSeconds / state.maxSeconds) * 100;
    elements.freezeMark.hidden = freezeSeconds === null;
    elements.freezeMark.style.left = `${freezePosition}%`;
    elements.endMark.style.left = `${endPosition}%`;
    elements.endMark.hidden = false;
    elements.timelineFreezeLabel.hidden = freezeSeconds === null;
    elements.timelineFreezeLabel.style.left = `${freezePosition}%`;
    elements.timelineFreezeLabel.textContent = `FREEZE ${core.formatElapsed(freezeSeconds || 0)}`;
    elements.timelineEndLabel.style.left = "100%";
    elements.timelineEndLabel.textContent = state.maxSeconds > contestEndSeconds
      ? `END ${core.formatElapsed(contestEndSeconds)} · 判定完了 ${core.formatElapsed(state.maxSeconds, true)}`
      : `END ${core.formatElapsed(contestEndSeconds)}`;

  }

  function cellMarkup(cell) {
    let className = "cell-empty";
    let main = "";
    let sub = "";
    let detail = "提出なし";

    if (cell.solved) {
      className = cell.firstToSolve ? "score_correct score_first" : "score_correct";
      main = String(cell.solveTime);
      sub = `${cell.numJudged} ${cell.numJudged === 1 ? "try" : "tries"}`;
      detail = `${cell.solveTime}分で正解`;
      if (cell.wrongAttempts > 0) detail += `、誤答${cell.wrongAttempts}回`;
    } else if (cell.numPending > 0) {
      className = "score_pending";
      main = "\u00a0";
      sub = `${cell.numJudged} + ${cell.numPending} tries`;
      detail = `未確定${cell.numPending}件`;
      if (cell.wrongAttempts > 0) detail += `、誤答${cell.wrongAttempts}回`;
    } else if (cell.wrongAttempts > 0) {
      className = "score_incorrect";
      main = "\u00a0";
      sub = `${cell.numJudged} ${cell.numJudged === 1 ? "try" : "tries"}`;
      detail = `誤答${cell.wrongAttempts}回`;
    }

    return `
      <td class="score_cell" title="${escapeHtml(detail)}">
        ${className === "cell-empty" ? "" : `<div class="${className}">${escapeHtml(main)}<span>${escapeHtml(sub)}</span></div>`}
      </td>`;
  }

  function problemColorMarkup(problem) {
    const color = /^#[0-9a-f]{6}$/i.test(problem.rgb || "")
      ? problem.rgb
      : "#999999";
    const red = parseInt(color.slice(1, 3), 16);
    const green = parseInt(color.slice(3, 5), 16);
    const blue = parseInt(color.slice(5, 7), 16);
    const border = `#${[red, green, blue].map((part) => Math.max(0, part - 64).toString(16).padStart(2, "0")).join("")}`;
    const brightness = (red * 299 + green * 587 + blue * 114) / 1000;
    const ink = brightness >= 145 ? "#000000" : "#ffffff";
    return `<span class="problem-badge" style="background-color:${color};border-color:${border};color:${ink}">${escapeHtml(problem.label)}</span>`;
  }

  function summaryCellMarkup(problem, stats) {
    const firstSolved = stats.firstSolvedMinute === null
      ? "n/a" : `${stats.firstSolvedMinute}min`;
    const detail = `問題 ${problem.label}: 正解 ${stats.solved}、誤答 ${stats.rejected}、未確定 ${stats.pending}、最初の正解 ${firstSolved}`;
    return `
      <td class="summary-problem-cell" title="${escapeHtml(detail)}" aria-label="${escapeHtml(detail)}">
        <span class="summary-metric" title="number of accepted submissions"><span class="summary-symbol" aria-hidden="true">✓</span>${stats.solved}</span>
        <span class="summary-metric" title="number of rejected submissions"><span class="summary-symbol" aria-hidden="true">✕</span>${stats.rejected}</span>
        <span class="summary-metric" title="number of pending submissions"><span class="summary-symbol" aria-hidden="true">?</span>${stats.pending}</span>
        <span class="summary-metric" title="first solved"><span class="summary-symbol" aria-hidden="true">◷</span>${firstSolved}</span>
      </td>`;
  }

  function renderTable(result) {
    if (state.renderedHeaderData !== state.data) {
      elements.scoreboardHead.innerHTML = `
        <tr class="scoreheader">
          <th class="rank-col" scope="col">rank</th>
          <th class="team-heading" scope="col" colspan="2">team</th>
          <th class="score-heading" scope="col" colspan="2">score</th>
          ${result.problems
            .map((problem) => {
              return `
                <th class="problem-heading" scope="col" title="problem ${escapeHtml(problem.name)}">
                  ${problemColorMarkup(problem)}
                </th>`;
            })
            .join("")}
        </tr>`;
      elements.stickyHead.innerHTML = elements.scoreboardHead.innerHTML;
      state.renderedHeaderData = state.data;
    }

    elements.scoreboardBody.innerHTML = result.rows
      .map(
        (row) => `
          <tr data-search="${escapeHtml(
            `${row.team.display} ${row.team.affiliation || ""}`.toLocaleLowerCase("ja"),
          )}">
            <td class="rank-col">${row.rank}</td>
            <td class="scoreaf"></td>
            <td class="team-col" title="${escapeHtml(row.team.display)}">
              <span class="team-name">${escapeHtml(row.team.display)}</span>
              <span class="team-affiliation" title="${escapeHtml(row.team.affiliation || "")}">${escapeHtml(row.team.affiliation || "")}</span>
            </td>
            <td class="score-col">${row.score.numSolved}</td>
            <td class="time-col">${row.score.totalTime}</td>
            ${row.problems.map(cellMarkup).join("")}
          </tr>`,
      )
      .join("");
    elements.scoreboardSummary.innerHTML = `
      <tr class="score-summary-row">
        <td class="scoresummary" title="Summary" colspan="3">Summary</td>
        <td class="summary-solved-total" title="total solved">${result.totals.solved}</td>
        <td class="summary-time-col"></td>
        ${result.problems.map((problem, index) =>
          summaryCellMarkup(problem, result.problemStats[index])).join("")}
      </tr>`;
    applyTeamFilter();
    scheduleStickyHeader();
  }

  function scheduleStickyHeader() {
    if (state.stickyFrame !== null) return;
    state.stickyFrame = window.requestAnimationFrame(() => {
      state.stickyFrame = null;
      syncStickyHeader();
    });
  }

  function syncStickyHeader() {
    if (elements.tableScroll.hidden || !elements.scoreboardHead.firstElementChild) {
      elements.stickyHeader.hidden = true;
      return;
    }

    const stickyTop = 0;
    const headRect = elements.scoreboardHead.getBoundingClientRect();
    const tableRect = elements.scoreboardTable.getBoundingClientRect();
    const scrollRect = elements.tableScroll.getBoundingClientRect();
    const left = Math.max(0, scrollRect.left);
    const right = Math.min(window.innerWidth, scrollRect.right);
    const visible =
      right > left &&
      headRect.top < stickyTop &&
      tableRect.bottom > stickyTop + headRect.height;

    elements.stickyHeader.hidden = !visible;
    if (!visible) return;

    elements.stickyHeader.style.top = `${stickyTop}px`;
    elements.stickyHeader.style.left = `${left}px`;
    elements.stickyHeader.style.width = `${right - left}px`;
    elements.stickyHeader.style.height = `${headRect.height}px`;
    elements.stickyTable.style.width = `${tableRect.width}px`;
    elements.stickyTable.style.marginLeft = `${tableRect.left - left}px`;

    const originalCells = elements.scoreboardHead.querySelectorAll("th");
    const stickyCells = elements.stickyHead.querySelectorAll("th");
    originalCells.forEach((cell, index) => {
      const width = `${cell.getBoundingClientRect().width}px`;
      stickyCells[index].style.width = width;
      stickyCells[index].style.minWidth = width;
      stickyCells[index].style.maxWidth = width;
    });
  }

  function applyTeamFilter() {
    const query = elements.teamFilter.value.trim().toLocaleLowerCase("ja");
    for (const row of elements.scoreboardBody.querySelectorAll("tr")) {
      row.hidden = Boolean(query && !row.dataset.search.includes(query));
    }
    scheduleStickyHeader();
  }

  function renderScoreboard() {
    if (!state.data) return;
    const targetMs = state.startMs + state.elapsedSeconds * 1000;
    const result = core.buildScoreboard(state.data, {
      startTime: state.startMs,
      endTime: state.endMs,
      targetTime: targetMs,
      freezeStartTime: state.freezeMs,
      applyFreeze: elements.freezeToggle.checked,
      penaltyMinutes: state.penaltyMinutes,
    });
    state.result = result;

    const clockMs = targetMs + state.clockOffsetMinutes * 60_000;
    elements.wallClock.textContent = `${clockFormatter.format(new Date(clockMs))} ${state.clockZoneLabel}`;
    elements.teamCount.textContent = String(result.totals.teams);
    elements.solvedCount.textContent = String(result.totals.solved);
    elements.pendingCount.textContent = String(result.totals.pending);
    elements.pendingCard.classList.toggle("has-pending", result.totals.pending > 0);

    elements.contestTimer.textContent = result.freezeActive
      ? `The scoreboard was frozen with ${Math.round((state.endMs - state.freezeMs) / 60_000)} minutes remaining`
      : targetMs >= state.judgedMs ? "judging complete"
        : targetMs >= state.endMs ? "judging in progress" : "contest running";
    elements.contestTimer.hidden = false;

    renderTable(result);
  }

  function stopPlayback() {
    if (state.playbackFrame !== null) window.cancelAnimationFrame(state.playbackFrame);
    state.playbackFrame = null;
    state.seeking = false;
    state.playbackLastFrameMs = null;
    state.playbackLastRenderMs = null;
    state.playing = false;
    elements.playButton.classList.remove("playing");
    elements.playIcon.textContent = "▶";
    elements.playLabel.textContent = "再生";
  }

  function advancePlayback(frameMs) {
    if (!state.playing) return;
    if (state.seeking) {
      state.playbackLastFrameMs = null;
      state.playbackFrame = window.requestAnimationFrame(advancePlayback);
      return;
    }
    if (state.playbackLastFrameMs !== null) {
      // RAF may pause in a hidden tab; include that interval when it resumes.
      const realSeconds = (frameMs - state.playbackLastFrameMs) / 1000;
      const speed = elements.playbackSpeed.value === "custom"
        ? state.customSpeed : Number(elements.playbackSpeed.value);
      state.playbackElapsedSeconds = Math.min(
        state.maxSeconds,
        state.playbackElapsedSeconds + realSeconds * speed,
      );
    }
    state.playbackLastFrameMs = frameMs;

    // Keep the scoreboard responsive without rebuilding its DOM every frame.
    if (
      state.playbackLastRenderMs === null ||
      frameMs - state.playbackLastRenderMs >= 33 ||
      state.playbackElapsedSeconds >= state.maxSeconds
    ) {
      state.playbackLastRenderMs = frameMs;
      const elapsed = Math.round(state.playbackElapsedSeconds);
      if (elapsed !== state.elapsedSeconds) setElapsed(elapsed);
    }

    if (state.playbackElapsedSeconds >= state.maxSeconds) {
      stopPlayback();
    } else {
      state.playbackFrame = window.requestAnimationFrame(advancePlayback);
    }
  }

  function togglePlayback() {
    if (state.playing) {
      stopPlayback();
      return;
    }
    if (state.elapsedSeconds >= state.maxSeconds) setElapsed(0);
    state.playing = true;
    state.playbackElapsedSeconds = state.elapsedSeconds;
    state.playbackLastFrameMs = performance.now();
    state.playbackLastRenderMs = null;
    elements.playButton.classList.add("playing");
    elements.playIcon.textContent = "Ⅱ";
    elements.playLabel.textContent = "停止";
    state.playbackFrame = window.requestAnimationFrame(advancePlayback);
  }

  function commitElapsedInput() {
    const parsed = core.parseElapsed(elements.elapsedInput.value);
    if (parsed === null) {
      elements.elapsedInput.value = core.formatElapsed(state.elapsedSeconds, true);
      return;
    }
    stopPlayback();
    setElapsed(parsed);
  }

  function syncCustomSpeedField() {
    const custom = elements.playbackSpeed.value === "custom";
    elements.customSpeedField.hidden = !custom;
    elements.customSpeed.disabled = !custom;
    if (custom) {
      elements.customSpeed.focus();
      elements.customSpeed.select();
    }
  }

  function updateCustomSpeed() {
    const speed = elements.customSpeed.valueAsNumber;
    const valid = Number.isFinite(speed) && speed > 0;
    elements.customSpeed.setAttribute("aria-invalid", String(!valid));
    if (valid) state.customSpeed = speed;
  }

  function commitCustomSpeed() {
    if (elements.customSpeed.getAttribute("aria-invalid") === "true") {
      elements.customSpeed.value = String(state.customSpeed);
      elements.customSpeed.setAttribute("aria-invalid", "false");
    }
  }

  function bindEvents() {
    elements.contestSelect.addEventListener("change", () => {
      const contest = state.contests.find((item) => item.id === elements.contestSelect.value);
      if (contest) loadContest(contest);
    });
    elements.timeRange.addEventListener("pointerdown", () => {
      state.seeking = true;
    });
    const finishSeeking = () => {
      if (!state.seeking) return;
      state.seeking = false;
      state.playbackElapsedSeconds = state.elapsedSeconds;
      state.playbackLastFrameMs = performance.now();
    };
    window.addEventListener("pointerup", finishSeeking);
    window.addEventListener("pointercancel", finishSeeking);
    elements.timeRange.addEventListener("input", (event) => {
      setElapsed(Number(event.target.value));
      if (state.playing) {
        state.playbackElapsedSeconds = state.elapsedSeconds;
        state.playbackLastFrameMs = performance.now();
      }
    });
    elements.elapsedInput.addEventListener("change", commitElapsedInput);
    elements.elapsedInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        commitElapsedInput();
        elements.elapsedInput.blur();
      }
    });
    elements.playButton.addEventListener("click", togglePlayback);
    elements.playbackSpeed.addEventListener("change", syncCustomSpeedField);
    elements.customSpeed.addEventListener("input", updateCustomSpeed);
    elements.customSpeed.addEventListener("change", commitCustomSpeed);
    elements.freezeToggle.addEventListener("change", renderScoreboard);
    elements.teamFilter.addEventListener("input", applyTeamFilter);
    window.addEventListener("scroll", scheduleStickyHeader, { passive: true });
    window.addEventListener("resize", scheduleStickyHeader);
    elements.tableScroll.addEventListener("scroll", scheduleStickyHeader, { passive: true });
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(scheduleStickyHeader);
      observer.observe(elements.scoreboardTable);
      observer.observe(elements.tableScroll);
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden || !state.playing) return;
      if (state.playbackFrame !== null) window.cancelAnimationFrame(state.playbackFrame);
      state.playbackFrame = null;
      advancePlayback(performance.now());
    });
  }

  function showLoadError(error) {
    console.error(error);
    elements.loadingState.hidden = true;
    elements.errorState.hidden = false;
    elements.errorMessage.textContent =
      location.protocol === "file:"
        ? "ブラウザは file:// からのJSON読み込みを許可しません。ローカルHTTPサーバー経由で開く必要があります。"
        : String(error?.message || error);
  }

  async function loadContest(selected) {
    const serial = ++state.loadSerial;
    stopPlayback();
    state.data = null;
    state.renderedHeaderData = null;
    elements.loadingState.hidden = false;
    elements.errorState.hidden = true;
    elements.tableScroll.hidden = true;
    elements.stickyHeader.hidden = true;
    elements.contestTimer.hidden = true;
    elements.teamFilter.value = "";
    elements.elapsedInput.disabled = true;
    elements.playButton.disabled = true;
    elements.timeRange.disabled = true;

    try {
      const data = await fetchJson(`./data/${selected.file}`);
      if (serial !== state.loadSerial) return;
      if (!data.contest || !Array.isArray(data.teams) ||
          !Array.isArray(data.problems) || !Array.isArray(data.attempts)) {
        throw new Error(`${selected.file} の形式が正しくありません`);
      }
      const contest = data.contest;
      state.startMs = core.toMillis(contest.start);
      state.endMs = state.startMs + contest.duration_ms;
      state.freezeMs = contest.freeze_ms === null
        ? null
        : state.startMs + contest.freeze_ms;
      state.penaltyMinutes = contest.penalty_minutes;
      const clockZone = contestClockZone(contest.start);
      state.clockOffsetMinutes = clockZone.offsetMinutes;
      state.clockZoneLabel = clockZone.label;

      state.data = data;
      state.judgedMs = core.findLastJudgementCompletion(data, state.startMs, state.endMs);
      configureTimeline();
      elements.tableScroll.scrollTop = 0;
      elements.tableScroll.scrollLeft = 0;
      elements.loadingState.hidden = true;
      elements.tableScroll.hidden = false;
      elements.elapsedInput.disabled = false;
      elements.playButton.disabled = false;
      elements.timeRange.disabled = false;
      setElapsed(state.maxSeconds);
      document.title = `${contest.name} — Scoreboard Replay`;
      const url = new URL(location.href);
      url.searchParams.set("contest", selected.id);
      history.replaceState(null, "", url);
    } catch (error) {
      if (serial === state.loadSerial) showLoadError(error);
    }
  }

  async function load() {
    try {
      const manifest = await fetchJson(MANIFEST_URL);
      if (!Array.isArray(manifest.contests) || manifest.contests.length === 0 ||
          !manifest.contests.every((item) =>
            typeof item.id === "string" &&
            /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(item.id) &&
            typeof item.name === "string" && typeof item.file === "string" &&
            item.file === `${item.id}.json`)) {
        throw new Error("contests.manifest.json の形式が正しくありません");
      }
      state.contests = manifest.contests;
      elements.contestSelect.replaceChildren(...state.contests.map((item) => {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.name;
        return option;
      }));
      elements.contestSelect.disabled = false;
      bindEvents();
      const requestedId = new URL(location.href).searchParams.get("contest");
      const selected = state.contests.find((item) => item.id === requestedId) || state.contests[0];
      elements.contestSelect.value = selected.id;
      await loadContest(selected);
    } catch (error) {
      showLoadError(error);
    }
  }

  load();
})();
