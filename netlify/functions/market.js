// 경제지표 프록시 (After10 일지용)
// 소스: Yahoo Finance chart API (서버측 호출 → CORS 무관)
// 쿼리: ?date=YYYY-MM-DD → 그 날짜의(없으면 직전 거래일) 지표 9종 반환
//
// ⚠️ 소스가 막히면 아래 SOURCE / SYMBOLS / fetchOne 만 교체하면 된다.

const SOURCE = "yahoo";

// 저장/표시 키 → Yahoo 심볼 (2024 데이터로 유효성 확인 완료)
const SYMBOLS = {
  usdkrw: "KRW=X",     // 원/달러
  jpykrw: "JPYKRW=X",  // 원/엔
  usdjpy: "JPY=X",     // 달러/엔 (Yahoo 표기 USD/JPY)
  dxy:    "DX-Y.NYB",  // 달러지수 (ICE US Dollar Index)
  spx:    "^GSPC",     // S&P500
  ndq:    "^IXIC",     // 나스닥
  kospi:  "^KS11",     // 코스피
  gold:   "GC=F",      // 금 (USD/oz)
  btc:    "BTC-USD",   // 비트코인 (USD)
};

/* 시간봉 폴백을 허용하는 지표 — 일봉 종가가 있는 날로 대조해 정확한 것만 남겼다.
   (최근 30일, '그날 마지막 시간봉' vs '그날 일봉 종가' 오차)
     spx  0/21일이 0.1% 초과, 최대 0.06%      ndq  0/21, 최대 0.04%
     btc  0/30, 최대 0.07%                    dxy  3/21, 최대 0.14%
   아래는 뺐다 — 마지막 시간봉이 그날 종가와 다른 값이라, 채우면 틀린 수치가 들어간다.
     kospi  16/22일이 0.1% 초과, 최대 0.82%
       · 코스피 종가는 15:20~15:30 동시호가로 정해지는데 시간봉은 15:00에서 끊긴다.
     gold   16/22, 최대 1.42%   — 선물 정산가와 마지막 체결가가 다르다.
     usdkrw 21/24, 최대 1.32% / jpykrw 20/24, 1.63% / usdjpy 17/24, 1.76%
       · 환율 일봉 종가는 런던 23:00 스냅샷이라 마지막 시간봉과 시점이 어긋난다.
   근사값보다 빈 칸이 낫다는 판단이다 — 빈 칸은 나중에 채울 수 있지만
   틀린 값은 그대로 차트에 남는다. */
const HOURLY_FALLBACK = new Set(["spx", "ndq", "dxy", "btc"]);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const DAY = 24 * 3600;

function toEpoch(dateStr) {           // YYYY-MM-DD → epoch(초, UTC 자정)
  return Math.floor(Date.parse(dateStr + "T00:00:00Z") / 1000);
}
function epochToYmd(sec) {             // epoch(초) → YYYY-MM-DD (UTC)
  const d = new Date(sec * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
/* 봉의 '거래일'은 UTC 날짜가 아니라 거래소 현지 날짜다.
   Yahoo는 일봉 timestamp를 그 거래일의 현지 장 시작 시각으로 준다.
   · ^KS11  00:00Z (서울 09:00)  · ^GSPC 13:30Z (뉴욕 09:30)  → UTC 날짜와 같은 날
   · KRW=X  전날 23:00Z (런던 00:00)                          → UTC 날짜가 하루 앞선다
   그래서 UTC로만 날짜를 붙이면 환율 3종만 하루 밀린 라벨이 되고,
   공통 기준일(min)이 그 심볼에 끌려 과거로 역행했다.
   meta.gmtoffset을 더해 현지 날짜로 읽으면 전 심볼의 라벨이 실제 거래일과 맞는다.
   덧붙여, 장중 진행봉은 '현재 시각'으로 찍히고 장 마감 후 '전날 23:00Z'로 확정되는데,
   현지 날짜로 읽으면 둘 다 같은 날짜가 되어 확정 전후로 라벨이 움직이지 않는다. */
function barYmd(sec, gmtOffset) {
  return epochToYmd(sec + (Number(gmtOffset) || 0));
}
function isWeekday(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return d >= 1 && d <= 5;
}

// 값 반올림 (지표별)
function roundVal(key, v) {
  if (v == null || Number.isNaN(v)) return null;
  if (key === "btc") return Math.round(v);            // 비트코인은 정수
  return Math.round(v * 100) / 100;                   // 나머지 소수 2자리
}

// 한 심볼의 시계열(요청일 이하, 종가가 있는 날들) 반환.
// 반환: [{ ymd:"YYYY-MM-DD", close:number }, ...] 오름차순 — ymd는 거래소 현지 거래일.
async function fetchSeries(yahooSym, targetDate, targetEpoch) {
  const period1 = targetEpoch - 14 * DAY;   // 넉넉히 14일 전부터 (연휴 대비)
  // 현지 날짜가 요청일인 봉이 UTC로는 다음 날에 찍힐 수도 있어 하루 더 받아온다.
  // 실제 걸러내는 일은 아래 현지 날짜 비교가 한다.
  const period2 = targetEpoch + 2 * DAY;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}` +
              `?period1=${period1}&period2=${period2}&interval=1d`;

  // 요청별 타임아웃 6초: 한 심볼이 늘어져도 함수 전체가 Netlify 한도(10초)를
  // 넘겨 502가 되는 것을 막고, 그 심볼만 실패로 처리한다.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const r = data && data.chart && data.chart.result && data.chart.result[0];
  const ts = r && r.timestamp;
  const closes = r && r.indicators && r.indicators.quote && r.indicators.quote[0] &&
                 r.indicators.quote[0].close;
  if (!ts || !closes) throw new Error("no data");

  // 요청일 이하에서 종가가 있는 거래일만. 비교도 라벨과 같은 기준(현지 날짜)으로 한다 —
  // 한쪽만 UTC로 재면 환율처럼 날짜가 어긋나는 심볼에서 하루씩 밀린다.
  const off = (r.meta && r.meta.gmtoffset) || 0;
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const ymd = barYmd(ts[i], off);
    if (ymd <= targetDate && closes[i] != null) {
      points.push({ ymd, close: closes[i] });
    }
  }
  if (!points.length) throw new Error("no close in range");
  return points;
}

// 차트 API 한 번 호출. 타임아웃을 부르는 쪽이 정한다 —
// Netlify 한도(10초) 안에 일봉+시간봉 두 번이 들어가야 할 수 있어서다.
async function fetchChart(yahooSym, params, timeoutMs) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const r = data && data.chart && data.chart.result && data.chart.result[0];
  if (!r) throw new Error("no data");
  return r;
}

/* 일봉이 통째로 빈 날을 1시간 봉으로 메운다.
   야후는 이따금 특정 날짜의 '일봉'만 통째로 비워서 준다(open·high·low·close·volume 전부 null).
   2026-09-22가 그랬는데, 미국·한국·영국 거래소 상장 종목이 한꺼번에 비었고
   선물·환율·암호화폐는 멀쩡했다. 같은 날 1시간 봉에는 값이 온전히 남아 있다.
   그래서 그날 마지막 시간봉의 종가를 종가 대신 쓴다.
   ⚠ 이 방식이 맞는지는 교차로 확인했다 — 코스피 9/23의 마지막 시간봉(7080.92)이
      같은 날 regularMarketPrice와 정확히 일치한다. */
async function fetchHourlyClose(yahooSym, targetDate, targetEpoch, off) {
  const r = await fetchChart(yahooSym,
    `period1=${targetEpoch - DAY}&period2=${targetEpoch + 2 * DAY}&interval=1h`, 3500);
  const ts = r.timestamp;
  const closes = r.indicators && r.indicators.quote && r.indicators.quote[0] &&
                 r.indicators.quote[0].close;
  if (!ts || !closes) return null;
  let last = null;
  for (let i = 0; i < ts.length; i++) {
    if (barYmd(ts[i], off) === targetDate && closes[i] != null) last = closes[i];
  }
  return last;
}

/* ── mode=daily : 심볼마다 '자기 실제 거래일'과 그 값을 그대로 돌려준다 ──
   v:3(기본 모드)은 9종을 하나의 공통 기준일(min)로 맞추느라, 주말이면 24시간 도는
   비트코인까지 금요일 값으로 끌려 내려갔다. 여기서는 맞추지 않는다.

   ⚠ 두 가지를 더 본다.
   1) 중간에 종가가 비어 있는 봉이 있다(야후 데이터 구멍). 최신 봉이 그러면
      meta.regularMarketPrice로 메운다 — 이것이 기준일이 이틀씩 밀리던 원인이었다.
   2) 그런데 장중이면 regularMarketPrice도, 마지막 일봉의 종가도 '지금 값'이라
      확정 종가가 아니다. 이 엔드포인트에는 marketState가 없어서
      currentTradingPeriod.regular.end로 판단한다 —
      regularMarketTime이 그 끝보다 이르면 아직 장이 돌고 있는 것이다.
      그 날짜(liveDate)는 확정값에서 빼고, 왜 빠졌는지 알 수 있게 따로 알려준다. */
async function fetchDaily(yahooSym, targetDate, targetEpoch, allowHourly) {
  const r = await fetchChart(yahooSym,
    `period1=${targetEpoch - 14 * DAY}&period2=${targetEpoch + 2 * DAY}&interval=1d`, 6000);
  const meta = r.meta || {};
  const ts = r.timestamp;
  const closes = r.indicators && r.indicators.quote && r.indicators.quote[0] &&
                 r.indicators.quote[0].close;
  const off = meta.gmtoffset || 0;

  /* 아직 장이 돌고 있는 날짜 — 확정값으로 쓰지 않는다.
     '마지막 체결이 지금 열려 있는 장 안에서 일어났는가'로 본다.
     regularMarketTime < end 만 보면, 장 열리기 전(예: 한국 08시)에는 currentTradingPeriod가
     이미 오늘 장을 가리켜 어제가 장중으로 잘못 잡힌다 — 그러면 어제 값을 영영 못 받는다. */
  const rmTime = meta.regularMarketTime;
  const reg = (meta.currentTradingPeriod && meta.currentTradingPeriod.regular) || null;
  const liveDate = (rmTime != null && reg && reg.start != null && reg.end != null &&
                    rmTime >= reg.start && rmTime < reg.end) ? barYmd(rmTime, off) : null;

  let best = null;              // { ymd, close, filled }  filled: false | 'regular' | 'hourly'
  const seen = new Set();       // 그날 확정 종가를 얻은 날짜
  const hasRow = new Set();     // 봉 '행'은 있는 날짜 (종가가 null이어도)
  if (ts && closes) {
    for (let i = 0; i < ts.length; i++) {
      const ymd = barYmd(ts[i], off);
      if (ymd > targetDate) continue;
      hasRow.add(ymd);
      if (ymd === liveDate || closes[i] == null) continue;
      seen.add(ymd);
      if (!best || ymd >= best.ymd) best = { ymd, close: closes[i], filled: false };
    }
  }
  // 종가가 빈 최신 봉을 meta 값으로 메운다 (같은 날 확정 종가가 이미 있으면 건드리지 않는다)
  const metaDate = rmTime != null ? barYmd(rmTime, off) : null;
  if (metaDate && metaDate <= targetDate && metaDate !== liveDate &&
      !seen.has(metaDate) && meta.regularMarketPrice != null &&
      (!best || metaDate > best.ymd)) {
    best = { ymd: metaDate, close: meta.regularMarketPrice, filled: 'regular' };
    seen.add(metaDate);
  }

  /* 그래도 요청한 날짜가 비어 있으면 1시간 봉으로 메운다. 조건을 좁게 잡는다:
     · 그날 봉 '행'은 있는데 종가만 없을 때 — 행 자체가 없으면 휴장이라 메울 것이 없다
     · 장중인 날은 제외 (확정값이 아니다)
     · 평일만 — DX-Y.NYB처럼 일요일 저녁에도 도는 종목이 있어서, 이 조건이 없으면
       지금까지 비어 있던 주말 칸에 값이 새로 생긴다(주말 동작을 바꾸지 않으려는 것).
     · 그리고 HOURLY_FALLBACK에 든 지표만 (위 표 참고 — 코스피·금·환율은 뺐다)
     일봉이 멀쩡한 날에는 아예 호출하지 않으므로 요청이 늘지 않는다. */
  if (allowHourly && !seen.has(targetDate) && targetDate !== liveDate && hasRow.has(targetDate) &&
      isWeekday(targetDate)) {
    try {
      const h = await fetchHourlyClose(yahooSym, targetDate, targetEpoch, off);
      if (h != null) best = { ymd: targetDate, close: h, filled: 'hourly' };
    } catch (e) {
      // 시간봉까지 실패해도 일봉으로 얻은 값은 그대로 돌려준다
    }
  }

  if (!best) throw new Error(liveDate ? `확정 종가 없음(장중 ${liveDate})` : "no close in range");
  return { ymd: best.ymd, close: best.close, filled: best.filled, liveDate };
}

exports.handler = async (event) => {
  const date = (event.queryStringParameters && event.queryStringParameters.date) || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { statusCode: 400, body: JSON.stringify({ error: "date=YYYY-MM-DD 필요" }) };
  }
  const targetEpoch = toEpoch(date);
  const mode = (event.queryStringParameters && event.queryStringParameters.mode) || "";

  /* mode=daily — 일지 저장이 쓰는 기본 응답(v:3)은 그대로 두고, 새 수집기만 이 갈래를 쓴다.
     같은 함수에 둔 이유: 심볼 목록·타임존 보정·반올림을 한 벌만 두려는 것이다.
     두 벌로 나뉘면 심볼을 하나 더할 때 한쪽만 고치는 일이 생긴다. */
  if (mode === "daily") {
    const keys2 = Object.keys(SYMBOLS);
    const settled2 = await Promise.allSettled(
      keys2.map(k => fetchDaily(SYMBOLS[k], date, targetEpoch, HOURLY_FALLBACK.has(k))));
    const symbols = {}, errors2 = {}, live = {};
    settled2.forEach((res, i) => {
      const k = keys2[i];
      if (res.status === "fulfilled") {
        const v = res.value;
        symbols[k] = { value: roundVal(k, v.close), date: v.ymd };
        if (v.filled) symbols[k].filled = v.filled;   // 'regular'(meta 값) | 'hourly'(시간봉)
        if (v.liveDate) live[k] = v.liveDate;
      } else {
        errors2[k] = String((res.reason && res.reason.message) || res.reason);
      }
    });
    const out = { source: SOURCE, v: 4, mode: "daily", requestedDate: date, symbols };
    if (Object.keys(live).length) out.live = live;          // 장중이라 확정으로 보지 않은 날짜
    if (Object.keys(errors2).length) out.errors = errors2;
    /* 수집기는 늘 '지금'의 답이 필요하다 — 장이 끝났는지, 야후가 빈 날을 메웠는지,
       허용 목록이 바뀌었는지에 따라 답이 달라진다. 캐시를 두면 방금 고친 기준으로
       다시 물어봐도 옛 답이 돌아온다(실제로 보완값 재검사가 그래서 한 번 헛돌았다).
       호출은 클라이언트가 이미 날짜 단위로 걸러내고 800ms 간격을 두므로 부담이 없다.
       일지가 쓰는 기본 응답(v:3)의 캐시는 그대로 둔다. */
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(out),
    };
  }

  const keys = Object.keys(SYMBOLS);
  // 병렬 조회 — 일부 실패해도 나머지는 유지 (전체 실패 처리 금지)
  const settled = await Promise.allSettled(
    keys.map(k => fetchSeries(SYMBOLS[k], date, targetEpoch))
  );

  // v:3 — 거래일 라벨을 거래소 현지 날짜로 읽는다(환율 3종이 하루 밀리던 것을 바로잡음).
  //        v:2는 UTC 라벨이라 기준일이 역행하거나 한 카드에 서로 다른 거래일 값이 섞일 수 있었다.
  //        이미 저장된 문서는 그대로 두므로, v로 어느 방식에서 나온 값인지 구분한다.
  const market = { source: SOURCE, v: 3, requestedDate: date };
  const errors = {};

  // 1단계: 각 심볼의 시계열 확보 + '공통 기준일' 확정.
  // 공통 기준일 = 모든 심볼이 데이터를 가진 마지막 거래일 = 각 심볼 마지막날의 최솟값(min).
  const seriesByKey = {};
  let basisDate = null;
  settled.forEach((res, i) => {
    const k = keys[i];
    if (res.status === "fulfilled") {
      seriesByKey[k] = res.value;
      const lastYmd = res.value[res.value.length - 1].ymd;
      if (basisDate == null || lastYmd < basisDate) basisDate = lastYmd;
    } else {
      errors[k] = String((res.reason && res.reason.message) || res.reason);
    }
  });

  // 2단계: 모든 심볼 값을 '공통 기준일 이하 마지막 종가'로 재선택 → 전 값이 같은 날짜.
  if (basisDate) {
    for (const k of Object.keys(seriesByKey)) {
      let chosen = null;
      for (const p of seriesByKey[k]) {
        if (p.ymd <= basisDate) chosen = p;
      }
      if (chosen) market[k] = roundVal(k, chosen.close);
      else errors[k] = `기준일(${basisDate}) 이전 데이터 없음`;
    }
  }

  market.basisDate = basisDate || date;
  // 요청일과 기준일이 다르면(주말/공휴일 등 직전 거래일 사용) 표시
  market.stale = market.basisDate !== date;
  if (Object.keys(errors).length) market.errors = errors;

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
    body: JSON.stringify(market),
  };
};
