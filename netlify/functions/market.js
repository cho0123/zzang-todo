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
async function fetchDaily(yahooSym, targetDate, targetEpoch) {
  const period1 = targetEpoch - 14 * DAY;
  const period2 = targetEpoch + 2 * DAY;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}` +
              `?period1=${period1}&period2=${period2}&interval=1d`;

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
  const meta = (r && r.meta) || {};
  const ts = r && r.timestamp;
  const closes = r && r.indicators && r.indicators.quote && r.indicators.quote[0] &&
                 r.indicators.quote[0].close;
  const off = meta.gmtoffset || 0;

  // 아직 장이 돌고 있는 날짜 — 확정값으로 쓰지 않는다
  const rmTime = meta.regularMarketTime;
  const regEnd = meta.currentTradingPeriod && meta.currentTradingPeriod.regular &&
                 meta.currentTradingPeriod.regular.end;
  const liveDate = (rmTime != null && regEnd != null && rmTime < regEnd) ? barYmd(rmTime, off) : null;

  let best = null;   // { ymd, close, filled }
  const seen = new Set();
  if (ts && closes) {
    for (let i = 0; i < ts.length; i++) {
      const ymd = barYmd(ts[i], off);
      if (ymd > targetDate || ymd === liveDate || closes[i] == null) continue;
      seen.add(ymd);
      if (!best || ymd >= best.ymd) best = { ymd, close: closes[i], filled: false };
    }
  }
  // 종가가 빈 최신 봉을 메운다 (같은 날 확정 종가가 이미 있으면 건드리지 않는다)
  const metaDate = rmTime != null ? barYmd(rmTime, off) : null;
  if (metaDate && metaDate <= targetDate && metaDate !== liveDate &&
      !seen.has(metaDate) && meta.regularMarketPrice != null &&
      (!best || metaDate > best.ymd)) {
    best = { ymd: metaDate, close: meta.regularMarketPrice, filled: true };
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
    const settled2 = await Promise.allSettled(keys2.map(k => fetchDaily(SYMBOLS[k], date, targetEpoch)));
    const symbols = {}, errors2 = {}, live = {};
    settled2.forEach((res, i) => {
      const k = keys2[i];
      if (res.status === "fulfilled") {
        const v = res.value;
        symbols[k] = { value: roundVal(k, v.close), date: v.ymd };
        if (v.filled) symbols[k].filled = true;
        if (v.liveDate) live[k] = v.liveDate;
      } else {
        errors2[k] = String((res.reason && res.reason.message) || res.reason);
      }
    });
    const out = { source: SOURCE, v: 4, mode: "daily", requestedDate: date, symbols };
    if (Object.keys(live).length) out.live = live;          // 장중이라 확정으로 보지 않은 날짜
    if (Object.keys(errors2).length) out.errors = errors2;
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=900" },
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
